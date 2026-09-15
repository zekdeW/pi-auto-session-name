/**
 * 自动会话命名（支持长对话实时更新）：
 * - 首轮对话结束后，用当前模型生成一个简短标题并设为会话名
 * - 之后每新增 RENAME_EVERY_N 条用户消息，自动复查一次：主题没变保留原标题，
 *   主题漂移则更新标题（并通知）
 * - 手动 /name 设置的名字不会被覆盖（通过会话内 custom entry 标记区分）
 * - 名称显示在 pi -r / /resume 的会话列表里
 *
 * 可用环境变量微调：PI_AUTO_NAME_EVERY=3  （每几条用户消息复查一次标题）
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RENAME_EVERY_N = Math.max(1, Number(process.env.PI_AUTO_NAME_EVERY ?? 3));
const MAX_TEXT = 800; // 首轮命名时传给模型的单段内容上限（字符）
const RECENT_CLIP = 300; // 复查时每条用户消息的截断上限
const RECENT_COUNT = 4; // 复查时携带最近几条用户消息
const MAX_TITLE = 24; // 标题最大长度
const MARKER = "auto-session-name"; // 会话内标记的 customType

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				!!b && (b as { type?: string }).type === "text" && typeof (b as { text?: string }).text === "string",
		)
		.map((b) => b.text)
		.join("\n");
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const cleanTitle = (raw: string): string => {
	let t = raw.replace(/\s+/g, " ").trim();
	t = t.replace(/^[(《"'\u201c\u2018【[]+|[》"'\u201d\u2019】\]))]+$/g, "");
	t = t.replace(/^(标题|题目|title|主题)\s*[:：]\s*/i, "");
	t = t.replace(/[。.!！]+$/, "");
	if (t.length > MAX_TITLE) t = `${t.slice(0, MAX_TITLE).trimEnd()}…`;
	return t;
};

export default function (pi: ExtensionAPI) {
	let inFlight = false; // 防止重入
	let checkedCount = 0; // 上次命名/复查时的用户消息数
	let autoName: string | undefined; // 我们自动设置的名字
	let manualName = false; // 用户手动命名过 → 停止自动命名

	// ---- 会话加载时恢复状态（区分自动命名与手动命名） ----
	pi.on("session_start", async (_event, ctx) => {
		autoName = undefined;
		manualName = false;
		checkedCount = 0;
		let marker: string | undefined;
		for (const entry of ctx.sessionManager.getEntries() as Array<{
			type: string;
			message?: { role?: string };
			customType?: string;
			data?: { name?: string };
		}>) {
			if (entry.type === "custom" && entry.customType === MARKER) marker = entry.data?.name;
			else if (entry.type === "message" && entry.message?.role === "user") checkedCount++;
		}
		const current = pi.getSessionName();
		if (current) {
			manualName = current !== marker;
			autoName = manualName ? undefined : current;
		}
	});

	// ---- 用户手动 /name → 记住并停止自动命名 ----
	pi.on("session_info_changed", async (event) => {
		if (!event.name || event.name === autoName) return;
		manualName = true;
	});

	const collect = (ctx: {
		sessionManager: { getBranch: () => Array<{ type: string; message?: { role?: string; content?: unknown } }> };
	}) => {
		let firstUser = "";
		let firstAssistant = "";
		const recentUsers: string[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg?.role) continue;
			const text = textOf(msg.content).trim();
			if (!text) continue;
			if (msg.role === "user") {
				if (!firstUser) firstUser = text;
				recentUsers.push(text);
			} else if (msg.role === "assistant" && !firstAssistant) {
				firstAssistant = text;
			}
		}
		return { firstUser, firstAssistant, recentUsers };
	};

	const askModel = async (
		ctx: {
			model?: unknown;
			modelRegistry: {
				hasConfiguredAuth: (m: unknown) => boolean;
				complete: (model: unknown, context: unknown, options?: unknown) => Promise<{
					content: Array<{ type: string; text?: string }>;
				}>;
			};
		},
		prompt: string,
	): Promise<string> => {
		const model = ctx.model;
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return "";
		const response = await ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ cacheRetention: "none", sessionId: uuidv7() },
		);
		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	};

	const applyName = (
		ctx: { hasUI: boolean; ui: { notify: (msg: string, level?: string) => void } },
		title: string,
	): void => {
		if (!title || title === pi.getSessionName()) return;
		pi.setSessionName(title);
		autoName = title;
		pi.appendEntry(MARKER, { name: title });
		if (ctx.hasUI) ctx.ui.notify(`已自动命名：${title}`, "info");
	};

	// ---- 每轮对话结束后：首次命名 / 周期性复查 ----
	pi.on("agent_end", async (_event, ctx) => {
		if (manualName || inFlight) return;
		inFlight = true;
		try {
			const { firstUser, firstAssistant, recentUsers } = collect(ctx);
			const current = pi.getSessionName();

			if (!current) {
				// 首次命名
				if (!firstUser) return;
				const prompt = [
					"根据下面的对话开头，给这段对话起一个简短的标题。",
					"要求：不超过 20 个字；标题语言与对话一致；直接输出标题本身，不要引号、句号或任何解释。",
					"",
					"<对话>",
					clip(firstUser, MAX_TEXT),
					firstAssistant ? clip(firstAssistant, MAX_TEXT) : "",
					"</对话>",
				].join("\n");
				const title = cleanTitle(await askModel(ctx, prompt)) || firstUser.replace(/\s+/g, " ").slice(0, 30);
				checkedCount = recentUsers.length;
				applyName(ctx, title);
			} else if (autoName && recentUsers.length - checkedCount >= RENAME_EVERY_N) {
				// 周期性复查：主题漂移才改名
				const recent = recentUsers
					.slice(-RECENT_COUNT)
					.map((t, i) => `${i + 1}. ${clip(t, RECENT_CLIP)}`)
					.join("\n");
				const prompt = [
					"这是一个进行中的对话，需要决定是否更新会话标题。",
					`当前标题：${current}`,
					"",
					"对话最早的用户消息：",
					clip(firstUser, RECENT_CLIP),
					"",
					"最近的用户消息：",
					recent,
					"",
					"判断当前标题是否仍然能概括整个对话：如果主题没有明显变化，原样输出当前标题；如果主题已经明显变化，输出一个新的、不超过 20 字的标题（语言与对话一致）。",
					"直接输出标题本身，不要引号或任何解释。",
				].join("\n");
				const title = cleanTitle(await askModel(ctx, prompt));
				checkedCount = recentUsers.length;
				if (title) applyName(ctx, title);
			}
		} catch {
			// 命名只是锦上添花，任何错误都静默忽略，不影响正常对话
		} finally {
			inFlight = false;
		}
	});
}

/**
 * 自动会话命名（主题集合版）：
 * - 首轮对话结束后，用当前模型生成第一个主题
 * - 之后每新增 RENAME_EVERY_N 条用户消息复查一次：主题没变保持不变；
 *   出现新主题则追加；名字 = 各主题按出现顺序用 " / " 连接
 *   （例：「自动最大化终端窗口 / 会话自动命名扩展」）
 * - 手动 /name 设置的名字不会被覆盖（通过会话内 custom entry 标记区分）
 * - 名称显示在 pi -r / /resume 的会话列表里
 *
 * 可用环境变量微调：PI_AUTO_NAME_EVERY=3（每几条用户消息复查一次）
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RENAME_EVERY_N = Math.max(1, Number(process.env.PI_AUTO_NAME_EVERY ?? 3));
const MAX_TOPICS = 4; // 主题列表最多保留几个
const TOPIC_LEN = 12; // 单个主题最大长度（字符）
const JOINER = " / "; // 主题连接符
const MAX_TEXT = 800; // 首轮命名时传给模型的单段内容上限（字符）
const RECENT_CLIP = 300; // 复查时每条用户消息的截断上限
const RECENT_COUNT = 4; // 复查时携带最近几条用户消息
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

/** 清洗单个主题：去掉编号、引号、前后缀和末尾标点，超长截断 */
const cleanTopic = (raw: string): string => {
	let t = raw.replace(/\s+/g, " ").trim();
	t = t.replace(/^([-*•]|\d+[.、)]|[一二三四五六七八九十]+[、.])\s*/, "");
	t = t.replace(/^[(《"'\u201c\u2018【[]+|[》"'\u201d\u2019】\]))]+$/g, "");
	t = t.replace(/^(主题|题目|title|topic)\s*[:：]\s*/i, "");
	t = t.replace(/[。.!！、；;，,]+$/, "");
	if (t.length > TOPIC_LEN) t = `${t.slice(0, TOPIC_LEN).trimEnd()}…`;
	return t.trim();
};

/** 把模型输出解析为主题列表：按行拆分、清洗、去重，超出上限舍弃最旧 */
const parseTopics = (raw: string): string[] => {
	const out: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const t = cleanTopic(line);
		if (t && !out.includes(t)) out.push(t);
	}
	return out.slice(-MAX_TOPICS);
};

const joinName = (topics: string[]): string => topics.filter(Boolean).join(JOINER);

export default function (pi: ExtensionAPI) {
	let inFlight = false; // 防止重入
	let checkedCount = 0; // 上次命名/复查时的用户消息数
	let autoTopics: string[] | undefined; // 我们自动维护的主题列表
	let manualName = false; // 用户手动命名过 → 停止自动命名

	// ---- 会话加载时恢复状态（区分自动命名与手动命名，兼容 v1.0 单标题标记） ----
	pi.on("session_start", async (_event, ctx) => {
		autoTopics = undefined;
		manualName = false;
		checkedCount = 0;
		let markerTopics: string[] | undefined;
		for (const entry of ctx.sessionManager.getEntries() as Array<{
			type: string;
			message?: { role?: string };
			customType?: string;
			data?: { name?: string; topics?: string[] };
		}>) {
			if (entry.type === "custom" && entry.customType === MARKER) {
				markerTopics =
					Array.isArray(entry.data?.topics) && entry.data.topics.length
						? entry.data.topics
						: entry.data?.name
							? [entry.data.name]
							: undefined;
			} else if (entry.type === "message" && entry.message?.role === "user") {
				checkedCount++;
			}
		}
		const current = pi.getSessionName();
		if (current) {
			if (markerTopics && joinName(markerTopics) === current) {
				autoTopics = markerTopics;
			} else {
				manualName = true; // 有名字但不是我们自动维护的 → 视为手动
			}
		}
	});

	// ---- 用户手动 /name → 记住并停止自动命名 ----
	pi.on("session_info_changed", async (event) => {
		const ours = autoTopics ? joinName(autoTopics) : undefined;
		if (!event.name || event.name === ours) return;
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

	const applyTopics = (
		ctx: { hasUI: boolean; ui: { notify: (msg: string, level?: string) => void } },
		topics: string[],
	): void => {
		const name = joinName(topics);
		if (!name || name === pi.getSessionName()) return;
		// 必须先更新 autoTopics 再 setSessionName：setSessionName 会同步触发
		// session_info_changed，若 autoTopics 尚未更新，我们自己的改名会被
		// 误判为用户手动命名，导致自动命名被永久禁用
		autoTopics = topics;
		pi.setSessionName(name);
		pi.appendEntry(MARKER, { name, topics });
		if (ctx.hasUI) ctx.ui.notify(`已更新命名：${name}`, "info");
	};

	// ---- 每轮对话结束后：首次命名 / 周期性复查主题列表 ----
	pi.on("agent_end", async (_event, ctx) => {
		if (manualName || inFlight) return;
		inFlight = true;
		try {
			const { firstUser, firstAssistant, recentUsers } = collect(ctx);
			const current = pi.getSessionName();

			if (!current) {
				// 首次命名：生成第一个主题
				if (!firstUser) return;
				const prompt = [
					"根据下面的对话开头，给这段对话起一个简短的主题标题。",
					"要求：不超过 12 个字；标题语言与对话一致；直接输出标题本身，不要引号、编号、句号或任何解释。",
					"",
					"<对话>",
					clip(firstUser, MAX_TEXT),
					firstAssistant ? clip(firstAssistant, MAX_TEXT) : "",
					"</对话>",
				].join("\n");
				const topics = parseTopics(await askModel(ctx, prompt));
				checkedCount = recentUsers.length;
				applyTopics(ctx, topics.length ? topics : [firstUser.replace(/\s+/g, " ").slice(0, TOPIC_LEN)]);
			} else if (autoTopics && recentUsers.length - checkedCount >= RENAME_EVERY_N) {
				// 周期性复查：维护主题集合
				const currentList = autoTopics.map((t, i) => `${i + 1}. ${t}`).join("\n");
				const recent = recentUsers
					.slice(-RECENT_COUNT)
					.map((t, i) => `${i + 1}. ${clip(t, RECENT_CLIP)}`)
					.join("\n");
				const prompt = [
					"这是一个进行中的会话，需要维护它的「主题列表」（按主题在对话中出现的顺序排列）。",
					"",
					"当前主题列表：",
					currentList,
					"",
					"对话最早的用户消息：",
					clip(firstUser, RECENT_CLIP),
					"",
					"最近的用户消息：",
					recent,
					"",
					"请维护这个主题列表：",
					"- 若最近的内容仍属于已有主题，保持列表不变（已有条目文字尽量原样保留）",
					"- 若出现了明显的新主题，在列表末尾追加一个不超过 12 字的新条目",
					"- 若两个条目明显是同一件事的不同叫法，可合并为一个",
					"- 条目最多保留 4 个：若已满且有新主题，先尝试合并相近条目，否则舍弃最旧的",
					"直接输出完整列表：每行一个主题，不要编号、引号或任何解释。",
				].join("\n");
				const topics = parseTopics(await askModel(ctx, prompt));
				checkedCount = recentUsers.length;
				if (topics.length) applyTopics(ctx, topics);
			}
		} catch {
			// 命名只是锦上添花，任何错误都静默忽略，不影响正常对话
		} finally {
			inFlight = false;
		}
	});
}

# pi-auto-session-name

[pi coding agent](https://pi.dev) 扩展：**自动为会话命名**，并在长对话中随主题漂移**实时更新标题**。名字显示在 `pi -r` / `/resume` 的会话列表里，多会话一目了然。

An extension for [pi](https://pi.dev) that automatically names your sessions and keeps the title up to date as the conversation evolves.

## 功能特性

- **首轮自动命名**：第一次对话结束后，用当前模型生成一个 ≤20 字的标题
- **实时更新**：之后每新增 N 条用户消息（默认 3），自动复查标题；主题没变保持不变，主题漂移则自动改名并通知
- **手动命名保护**：用 `/name` 手动设置的名字不会被覆盖（通过会话内 custom entry 标记区分自动/手动）
- **零打扰**：命名失败静默忽略，不影响正常对话；每会话只多几次极小的模型调用

## 安装

```bash
pi install git:github.com/zekdeW/pi-auto-session-name@v1.0.0
```

或先试用（不落盘，仅本次运行生效）：

```bash
pi -e git:github.com/zekdeW/pi-auto-session-name
```

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_AUTO_NAME_EVERY` | `3` | 每新增多少条用户消息，复查一次标题 |

```bash
# 例：每条消息后都复查（最"实时"）
PI_AUTO_NAME_EVERY=1 pi
```

## 工作原理

1. 监听 `agent_end` 事件，首轮结束后取「用户提问 + 助手回复」（各截取 800 字符）让当前模型生成标题，经 `pi.setSessionName()` 写入会话
2. 之后周期性发起一次极小的「标题复查」请求（当前标题 + 最近几条用户消息）：主题未变则原样保留，变化则更新
3. 每次自动命名都会向会话写入 `auto-session-name` 标记，用于和手动 `/name` 区分；检测到手动命名后，该会话永久停止自动改名

> 命名使用你**当前选中的模型**，入参几百字符、出参 ≤20 字，成本可忽略。

## License

[MIT](./LICENSE)

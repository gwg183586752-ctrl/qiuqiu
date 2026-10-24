# AI SDK 6 与 MiMo 真实兼容结论

2026-10-25。采用已锁定 `ai@6.0.315` 与 `@ai-sdk/openai-compatible@2.0.87`，schema 使用已锁定 zod。官方接口要求 `api-key` 头，显式 `thinking`，`max_completion_tokens`；provider 请求变换移除 `max_tokens` 并填写对应字段，禁止重定向和隐式重试。

真实样本：普通诊断 1 次时间调用成功，工具结果 `2026-10-25 00:28:07`，最终回答同秒；thinking 样本产生 reasoning 增量，后续请求确实带历史 `reasoning_content`，最终时间同秒。报告只保存 reasoning 字符数及事件种类，不保存其内容。生产使用 thinking disabled。

四调用请求实际在同一模型响应返回 4 项，诊断只执行前三项，第四项返回拒绝；最终请求依然成功并引用已有结果。出站摘要核对工具阶段存在 `tools=[get_server_time]`、`tool_choice=auto`；最终阶段 `toolsFieldPresent=false`，工具结果消息已回传。不是仅把 tool_choice 设为 none。

真实取消样本在 250ms 信号后退出，实测约 270ms，未进行最终生成。真实流中收到 tool-input-start / delta / end、tool-call，工具前文本不交给口播；受控 WS 用例补足三次失败、非法工具、配额、接管和迟到结果，不能把这些受控行为记成真实模型自发行为。

首次包含演出提示的诊断没有触发工具（失败证据保留）；简化为明确工具诊断提示后成功。生产足球提示再通过真实 ASR→Agent→TTS 验证：识别“现在北京时间几点”，执行一次真实探针，最终回答“现在是北京时间 00:32，深夜啦。你是准备看夜场球赛吗？”，与本次 00:32:23 工具结果一致。该轮工具判定累计 3120ms，首音就绪 6447ms；性能结论以同条件浏览器采样另报。

继续采用 SDK。已有真实文本、工具 schema、参数增量、结果回传、最终无工具请求、thinking 历史和取消证据，没有 SDK 兼容性阻塞。两阶段设计会增加模型请求，超过 500ms 目标时应按模型判定、网络和合成分别归因，不能只因延迟高就改为手写循环。

命令：`npm run agent:check -- --real`，可分别增加 `--thinking`、`--multi` 或 `--cancel`。脱敏报告将复制到交接证据目录；`.cache/sdk-spike-*` 保留原始本机实验输出。

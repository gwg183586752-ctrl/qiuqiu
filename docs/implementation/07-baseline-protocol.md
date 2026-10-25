# 冻结的本机性能采样协议

本文件保留首次冻结协议及其历史样本。修复后最终复测与当前性能结论以 `17-acceptance.md` 及 `evidence/final-*.json` 为准。

2026-10-25，Windows 本机、Ryzen 7 7840H、16GiB 内存、RTX 4060 Laptop；Node 22.20.0、Chrome 155.0.8059.86，回环 HTTP/WS。云请求经本机当时网络访问 MiMo 官方服务；没有使用课程作者机器数据。采样期间不修改应用源代码、不同时运行其他浏览器压力测试或付费云诊断。

固定模型：`mimo-v2.6-flash`、`mimo-v2.5-asr`、`mimo-v2.5-tts`、冰糖、thinking disabled、最终生成最多 512 tokens。基线走无工具增量回复；Agent 走工具判定和无工具最终回复。其他音频参数与程序源代码相同，并在原始报告中保存源代码 SHA-256、模型参数、输入音频 SHA-256 和浏览器版本以便核对。

固定输入两类：“我喜欢阿森纳，请陪我聊聊足球。”、“现在北京时间几点？”。使用实际 MiMo 冰糖合成的固定 WAV，经 Chrome 模拟麦克风和实际 AudioWorklet 重新采集为 16kHz PCM16 单声道 WAV。输入前后各补一秒静音。每类单独启动已安装 Chrome，每轮使用新浏览器上下文；先一轮预热，再三轮正式采样，共八轮（六轮正式）。每轮都播放新会话开场白，待其完成后开始录音、结束发送，等全部声音播完。

这是浏览器与真实云链路证据，输入不是物理麦克风的人声。独立的物理设备验收不得据此冒充已完成。

原始 JSON 的每一轮包含预热标记、输入来源、识别文本、最终回答、服务端分段耗时、浏览器实际首音、状态和关联 ID。开始时立即保存未完成样本；失败保留，不静默删除。分别统计首个有效文字、首音就绪及实际首音，中位数使用普通排序中间值、p95 使用最近秩；每类三轮时 p95 通常等于最大值，不能推断长期服务表现。

本次基线目录 `.cache/measurements/baseline-1792859685316`，八轮均完成、六轮正式成功率 100%。普通闲聊实际首音中位数约 5374ms；时间类问题约 3760ms，基线的时间回答不具备工具事实能力。统计由原始数据重算，不能挑选最快一轮作结论。

此前 `.cache/measurements/baseline-1792858404450` 在页面连接逻辑更新后主动终止并注明作废，包含三轮已完成和一轮未完成；原始数据继续保留，不混入冻结后的统计。

重跑：仓库已保留 `docs/implementation/fixtures/manifest.json` 及两个固定 WAV，无需重新生成输入。设置 `RUN_REAL_CLOUD=1`，运行 `npm run test:real -- --reporter=line`。设置 `REAL_BRAIN_MODE=agent` 后用同一命令运行 Agent。统计：`npm run latency:report -- --baseline <基线samples.json> --agent <Agent samples.json> --output <新报告.json>`。

基线已包含共享入口与持久层，以便只比较大脑差异；本报告不把基线采样本身视为完整 M0 或 +500ms 目标通过。演出与状态观察见 `03-browser-baseline.md`、`04-06-real-voice.md`，Agent 对照及未验证项在整体验收报告中汇总。

# qiuqiu

本机足球数字人项目，采用 TypeScript、React、Three.js/VRM 和 Node HTTP/WebSocket。当前按 OpenSpec 的 `bootstrap-football-agent-m0` 变更实施；任务完成状态以其中的清单为准。

## 安装与配置

本机验证运行时为 Node 22.20.0、npm 10.9.3。依赖安装后使用锁文件复现：

```powershell
npm ci
Copy-Item .env.example .env
```

若 `.env` 已存在，请直接编辑，不要覆盖。填写 `MIMO_API_KEY` 和本机入口 `ACCESS_TOKEN`；云密钥只由后端读取，`.env` 已被 Git 忽略。模型可通过配置调整，实际账号权限在真实接口验证中确认。

## 运行与验证

```powershell
npm run dev
```

服务默认绑定 `127.0.0.1:3000`，健康检查使用：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
npm run typecheck
npm test
npm run build
```

在运行终端按 Ctrl+C 停止。无需云调用的模拟运行须明确设置 `CLOUD_MODE=fake`，健康结果将标记 `fake`，不能作为真实语音或模型权限的验证证据。

安装依赖后也可通过 Node 自带的 TypeScript 类型剥离直接运行启动检查：

```powershell
node --experimental-strip-types --test tests/startup.test.ts
node --experimental-strip-types src/cli/cloud-check.ts --fake
```

构建后可以从构建产物启动：

```powershell
npm run build
npm start -- --production
```

开发命令仅监听服务端、共享协议及 `.env`，避免 Vite 临时配置文件触发重启循环。当前前端修改后刷新页面查看。

## 存储诊断与恢复

```powershell
npm run storage:check
npm run storage -- inspect --database .cache/storage-check/diagnostic.sqlite
```

诊断使用独立缓存数据库，报告真实 SQLite 跨重开写读及 1024 维向量近邻结果。仅向量扩展失败会明确标记降级；关系存储错误或不支持的结构版本会失败退出。

一致性备份与恢复使用 SQLite 备份接口，包含 WAL 中已提交的数据。目的文件必须不存在，重跑示例时请选择新的文件名：

```powershell
npm run storage -- backup --database .cache/storage-check/diagnostic.sqlite --destination .cache/storage-check/snapshot.sqlite
npm run storage -- restore --database .cache/storage-check/snapshot.sqlite --destination .cache/storage-check/restored.sqlite
npm run storage -- inspect --database .cache/storage-check/restored.sqlite
```

结构迁移只前进；显式迁移使用 `npm run storage -- migrate --database <数据库文件>`。遇到未知的新版本或迁移失败，保留数据库并使用匹配程序或一致性备份恢复，不自动清空数据。

浏览器首次访问先点击“开启声音”，开场白结束后点击“开始录音”，说完点击“结束并发送”。生成和播放期间不接收下一段录音。麦克风只在主动录音期间开启，结束、离开或接管会停止采集。浏览器权限拒绝、设备占用或没有声音时，页面会显示可操作的提示。

`BRAIN_MODE=agent` 启用足球迷小糖和时间探针；`baseline` 保留性能对比用的无工具大脑。`CLOUD_MODE=fake` 是显式模拟，声音是测试波形，不能用于评价冰糖音质。真实账号已验证 `mimo-v2.6-flash`、`mimo-v2.5-asr`、`mimo-v2.5-tts` 与冰糖，具体记录见 `docs/implementation/`；完整验收及待核对项以 OpenSpec 任务和验收报告为准。

## 会话与访问

共享口令从后端本机配置自动用于握手，无登录页。错误口令在升级前拒绝，页面停止自动重试；修正 `.env` 并重启服务后点击重试。服务只接受回环 Host 和同源浏览器请求，不输出带口令的连接地址。

同一浏览器通过本地存储续聊；刷新、关闭重开和服务重启后保留最近 12 条完整普通消息作为上下文，旧历史仍在数据库中。新标签页接管同一会话，旧页面停止录音、播放及重连。清除站点数据会开始新会话；不同浏览器使用不同会话。会话标识是本机共享口令范围内的续聊标识，不是账号或独立权限。

开场白只安排给新会话。全部回复及本轮语音合成成功后才事务保存问答，保存不等待播放结束；已保存但未播完的回答仍可续聊。刷新或接管取消未完成回合，已说出的半句不会加入历史。不自动重新提交旧录音，遇到失败请重新录制新的一轮。

## 审计与工具诊断

```powershell
npm run audit -- --turn <回合ID>
npm run audit -- --session <会话ID>
npm run audit -- --database <已有数据库文件> --turn <回合ID>
npm run agent:check -- --real
npm run agent:check -- --real --thinking
npm run agent:check -- --real --multi
npm run agent:check -- --real --cancel
```

审计包含成功、失败或取消的回合、阶段、工具结果和分开的延迟指标。无匹配记录返回 `empty`，参数或数据库错误失败退出。SQLite 是业务事实；`AUDIT_PATH` 的 JSONL 是附加出口，无法追加只告警，不能回滚成功问答或重试云调用。查询会再次脱敏当前配置中的凭证；不要把旧的敏感原始数据库当作公开附件。

M0 唯一工具 `get_server_time` 支持北京时间和 UTC。每轮最多实际尝试三次，失败计入；非法或超额调用单独记为未执行。工具判定最多三轮，然后安排不提供工具的最终回答。查询文字不口播，时间以本次真实工具结果为准；比分、赛程与积分尚未接入实时查询。真实诊断命令会使用账号配额并把脱敏结果保存在 `.cache/`。

## 浏览器与真实链路验收

```powershell
npm run test:browser -- --reporter=line
npm run cloud:check -- --real --speech-fixture
npm run cloud:check -- --real --agent --audio <PCM16单声道WAV文件>
```

普通浏览器测试使用本机已安装 Chrome 与模拟麦克风。真实云采样入口需显式启用 `RUN_REAL_CLOUD=1`，命令及固定输入见基线验收说明。真实云合成输入经浏览器模拟麦克风采集，属于真实接口和浏览器自动化证据；物理麦克风与主观听感需单独核对，不能混记。

本次最终功能、性能及剩余项见 [本机验收交接](docs/implementation/17-acceptance.md)，物理设备确认见 [实录核对](docs/implementation/18-physical-device-check.md)。当前性能增加不超过 500ms 的目标未达，原始样本和统计完整保留。

## 目录

- `src/`：浏览器、服务端、共享协议与维护命令。
- `public/`：官方验证模型、许可元数据与录音工作处理器。
- `tests/`：公开启动/WS/CLI 行为测试及浏览器验收。
- `demo/`：历史演示设计工作区。
- `docs/`：项目文档。
- `openspec/`：需求规格、变更计划和归档。
- `.agents/skills/`：项目内的 Codex skills。

## OpenSpec

使用本机已安装的 OpenSpec CLI 1.14.1，项目配置采用 `spec-driven` schema，产出语言为简体中文。

在 Codex 对话中使用：

```text
$openspec-explore 讨论一个需求
$openspec-propose 描述要实现的功能
$openspec-apply-change 实现已经规划的变更
$openspec-archive-change 归档已完成的变更
```

在终端查看变更和规格：

```powershell
openspec list
openspec list --specs
```

## Matt Pocock skills

已安装官方工程和生产力目录中的 27 个 skills，例如 `$ask-matt`、`$grill-with-docs`、`$tdd`、`$code-review` 和 `$implement`。新安装的 skills 从下一轮对话起可用。

来源与版本记录在 `.agents/skill-sources.json`，原始许可见 `.agents/MATT-POCOCK-LICENSE`。

安装来源：[OpenSpec](https://github.com/Fission-AI/OpenSpec) 和 [Matt Pocock skills](https://github.com/mattpocock/skills)。

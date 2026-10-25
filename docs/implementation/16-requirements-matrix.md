# M0 要求与证据映射

状态截至 2026-10-25 的完整验收阶段。这里只映射事实，任务状态仍以 OpenSpec 清单为准。物理设备已单独核对，最终性能见 `17-acceptance.md` 及其原始数据。

| 要求 | 结果与证据 |
|---|---|
| RT-01 | 安装锁文件、启动、typecheck、build、健康与关闭验证；01-startup、startup.test |
| RT-02 | 缺密钥/非法配置只输出名称，未来服务配置缺失可启动；startup.test |
| RT-03 | SQLite 真实跨重开及 vec 1024 维命中，扩展失败单独降级；02-storage、storage.test |
| RT-04 | 递增迁移至 v4；中途失败、未知版本拒启、历史及 WAL 备份保护；storage.test |
| RT-05 | interrupted、knowledge_chunks、entities 和审计预留；storage.test，数据库迁移 |
| RT-06 | fake/real 输出分开；浏览器合成麦克风和物理设备分开；各证据的 evidence 字段 |
| DH-01 | 真实 VRM、四类页面内容、模型错误和重试；baseline.spec、03 截图 |
| DH-02 | 点击开始/结束，等待首采样，处理中及播放中禁用；baseline.spec |
| DH-03 | 固定语音真实识别，加上 Realtek 物理语音 completed 回合及用户听感确认；18-physical-device-check |
| DH-04 | 乱序按序播放、字幕随 playing、迟到重复不阻塞；baseline.spec |
| DH-05 | 官方模型六表情、四动作、音量口型；03-action 截图及 final-agent-speaking / final-agent-time-speaking 真实截图 |
| DH-06 | 新会话按钮激活声音后播放开场白；baseline.spec |
| DH-07 | 接管/断线/媒体失败清理、迟到丢弃、TTS 文字降级；browser、conversation、persistence 测试 |
| DH-08 | 冻结输入、基线真实八轮及原始三类延迟；07-baseline-protocol、baseline-samples |
| AC-01 | 监听 127.0.0.1，回环 Host 验证；startup/access 测试 |
| AC-02 | 缺失、错误口令升级拒绝，零会话/回合副作用；access.test |
| AC-03 | 同源预检、无登录、错误可恢复且无重连循环；baseline.spec |
| AC-04 | 业务与审计哨兵、带口令 URL、构建产物扫描无密钥；audit.test、构建扫描 |
| PC-01 | 未知身份重分配、已知恢复、存储失败保持提示并停止重连；persistence.test、baseline.spec |
| PC-02 | Chrome/Edge 独立会话、WS 恢复上下文无交叉；persistence.spec、persistence.test |
| PC-03 | 九轮保存后仅注入最近十二条，全部九轮仍可审计；persistence.test |
| PC-04 | 新页接管，旧页麦克风结束/声音停止/不抢回；browser 与 persistence 测试 |
| PC-05 | 第二条消息和成功终态故障注入均回滚；保存未播完后重启保留；persistence.test |
| PC-06 | 旧生成与工具迟到、TTS 失败整轮无历史；persistence/agent 测试 |
| PC-07 | 接管前后提交的确定边界；旧关闭不影响新连接；persistence.test |
| PC-08 | processing/completed/cancelled 重提、内容冲突，不增加云或音频；persistence.test |
| PC-09 | 新建一次固定欢迎，刷新/重开/重启不重播；persistence.spec 与协议测试 |
| OB-01 | 成功/失败/取消/启动恢复可关联，阶段记录；audit/persistence 测试 |
| OB-02 | 三实际执行、第四拒绝，失败与非法项分开；agent.test、sdk-multi |
| OB-03 | 按 session/turn 只读查询、empty 与参数错误区别；audit.test、README 命令 |
| OB-04 | 首文字、服务端首音就绪、客户端实际首音分开；原始样本与审计 |
| OB-05 | 最终同源代码指纹/同输入两批各八轮已附；均完成但 +500ms 目标未达，失败的旧批次另保留 |
| OB-06 | JSONL 不可追加时告警，SQLite completed 与历史保留、不多调云；audit.test |
| OB-07 | 自动化、真实云、真实浏览器和 Realtek 物理设备证据分别列示；36 Node / 14 浏览器用例通过 |
| AG-01 | SDK 真实时间同秒、完整 ASR→Agent→TTS、浏览器真实探针及 SQLite 审计 |
| AG-02 | 同响应四项只执行三项、三失败、非法名称及参数；agent.test、sdk-multi |
| AG-03 | 三次失败仍产生最终回复，最终请求无 tools；agent.test、SDK 出站摘要 |
| AG-04 | 过程文本留内部，查询状态独立；首文字仅从最终流测量；agent.test 与真实报告 |
| AG-05 | 足球提示、固定规则/历史/实时三类样本，失败记录保留；15-persona 与真实报告 |
| AG-06 | 六条提示保留、默认表情与禁语兜底；conversation/agent 测试、persona 原文与效果分开 |
| AG-07 | 总期限、断开/接管、真实 SDK 取消约 270ms、工具迟到不继续；SDK/agent 测试 |
| AG-08 | SDK schema/参数流/多调用/无工具收尾/thinking 历史/取消均有真实结论；13-sdk-spike |

功能验收与性能优化目标分别判定。首版仅本机；没有实时足球数据、知识检索、用户打断或最终定制造型。物理麦克风、扬声器及听感已由真实发言和用户反馈核对，没有用合成麦克风代替。

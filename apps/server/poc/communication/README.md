# Minimal communication POC

2026-09-15，基于本地 `main@d321394`。用户直接授权的隔离实验，不是生产实现或上线版本。

## 运行

在仓库根目录运行，无需安装新依赖：

```sh
node_modules/.bin/tsc -p apps/server/poc/communication/tsconfig.json
apps/server/node_modules/.bin/tsx --test apps/server/poc/communication/communication.test.ts
```

基准测试从 `apps/server` 目录运行：

```sh
node --expose-gc --import tsx poc/communication/benchmark.ts
```

进程内：合成 Browser HTTP → Hub → 同进程 Connector app.fetch。
跨进程：合成 Browser HTTP → Hub → loopback HTTP → 子进程 Connector。
两条路径复用同一 ConnectorClient、鉴权入口、序列化和处理器，不使用真实浏览器 UI。

仅绑定 `127.0.0.1` 随机端口；子进程仅继承 PATH，凭据是代码内明确的 fixture 假值。不得改为公网监听。没有导入 `src/index.ts`、生产 store、Codex/Gateway、配置或真实会话；不改现有运行实例。文件位于 `src` 外，不进入生产 build。

## 已实现的最小边界

- `protocol.ts`：命令/回执/快照/事件类型、有限日志、按游标恢复、有界近期投影。
- `connector.ts`：唯一合成执行者；每条命令保留身份、自主排队推进；重复请求返回同一回执，冲突拒绝。
- `transport.ts`：一个客户端注入 dispatch；读取期限、取消/reader 清理、有限重试和流式解析。事件每个 Feed 只编码一次，各消费者复制字节，避免互相修改。
- `hub.ts`：只做认证、投递、缓存和分发；每节点/安全域一条上游流，与浏览器数量无关。连接状态与执行状态分开。
- 其余 TS 文件是 fixture、子进程入口、测试和 benchmark，不是新的生产服务层。

恢复规则：快照携带 epoch/seq，订阅从该游标补增量；过期、未来游标或 epoch 不同返回 410，Hub 重新取快照。快照到订阅间的数据由有限日志承接，超过窗口会显式重同步，不能静默漏掉。

已接收命令不随 HTTP 取消而停止；自动重试固定 command ID、payload、epoch。Connector 重启后旧 epoch 的重试返回 409，表示结果需核对，**不证明旧执行没发生**。这不是 durable inbox 或 exactly-once。

## 资源边界

| 对象         | POC 上限/行为                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| 单条命令     | body 8 KiB、文本 4096 个 JS 字符、ID 80 字符；读取最多 2 秒                                                  |
| JSON 响应    | 2 MiB，RPC 总期限默认 2 秒                                                                                   |
| 单 SSE frame | 16,384 个 JS 字符；仅解析本 POC 发出的 LF/单行 JSON SSE，不是通用 SSE SDK                                    |
| 事件日志     | 默认 128 条；fixture 32 条；每条事件也有大小约束                                                             |
| 近期消息快照 | 最近 64 条，明确不是完整历史；收据不随消息窗口淘汰                                                           |
| 合成命令收据 | 默认 256 条，fixture 2000；满后拒绝，不驱逐旧 ID 然后误执行                                                  |
| 消费者       | 每 Feed 最多 64 个；每消费者一个游标和最多一个待读 chunk，另有网络栈固定缓冲                                 |
| 慢消费者     | 落后日志窗口即断开，之后从游标或快照恢复，不无限缓存、不阻塞其他消费者                                       |
| 心跳         | 每个活跃 Feed 一个定时器，默认 15 秒；测试节点为 100ms，加速测试；无消费者即释放                             |
| 连接超时     | 流默认 60 秒无读取活动超时；有心跳就续期，不定期重建健康流                                                   |
| 重试         | command 最多 3 次；Hub 重连指数退避+jitter，退避基值最大 1 秒（另有 jitter）；401/403 停止重试并关闭缓存订阅 |

近期快照、复制文本和 command Map 都是实验用的内存实现，生产历史必须分页/按需读取。Hub 不应复制完整 transcript。保护还不包括生产级的连接/IP 限流、跨节点总预算或公平调度。

## 验证与证据

测试覆盖本地/真实跨进程闭环、12 浏览器共用一个上游、相同文本不同 ID、丢 ACK 后重试、payload 冲突、命令 epoch 防护、快照/订阅间隙、游标过期和节点重启、断线保留 running、慢消费者、流取消/计时器/监听器清理、UTF-8 分片、超大/非法消息、迟到响应、慢上传取消和授权拒绝后关闭缓存订阅。

测试、基准和已知限制的结论同步写入 [架构评审记录](../../../../docs/architecture/hub-connector-evaluation.md)。[benchmark-baseline.json](benchmark-baseline.json) 保存一次可复现测量，不是最优值筛选。基准发送 100 条 256-byte ASCII 消息，合成执行每条等待 4ms；snapshot RPC 先预热 30 次再采样 200 次。空闲段 500ms；每种模式做 300 次连接/取消。parent CPU/RSS 包含 Hub、模拟浏览器及同进程 Connector；HTTP 模式另列 worker 指标，不能直接把 parent 指标当服务端占用。

## 不能据此宣布完成的事情

- 未接真实 Codex/OpenClaw；未实现 SQLite 事务收据、崩溃恢复和跨重启幂等。单次 epoch 防护不是完整 unknown-outcome 管理。
- 一节点、一 session、单安全域和静态假 token；不是多用户 delegated grant、授权撤销时限、两节点隔离、权限缓存的验收。
- 没有真实 UI 自动恢复、工具链投影、历史分页、上传/文件代理、队列持久化或迁移删除旧路径。
- 只有 loopback HTTP；TLS/反向代理缓冲、广域网抖动/丢包/半开连接、真实网络慢消费者和长时泄漏测试仍待补。
- Hub 的健康状态可从 snapshot 读取，但尚未实现浏览器专用 health/sync 事件；不把本实验当最终前端状态协议。
- 本 POC 中 410→snapshot 适用于有界合成近期投影；生产 Hub 列表水位和 Connector 历史水位仍须分开，不能直接复制本实验的简化模型。

不引入新 package、生产依赖或外部服务。下一步应把验证过的传输/清理边界带入 P0 契约与隔离测试；不能直接把这个假 runtime/内存队列接入生产。生产改造仍保留正式工作项与验收门槛。

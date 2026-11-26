# Antigravity CLI 连接器开发

**简体中文 · [English](antigravity-cli.md) · [文档导航](README.zh-CN.md)**

## 当前状态

本开发工作继续使用 AOD **1.0.0**。Linux ACP 传输层、隔离配置解析器、执行归属编排、
Connector 运行时接线与 Web UI 入口已在 `apps/server/src/antigravity/`、
`apps/server/src/connector/`、`apps/server/src/routes/connector.ts` 与
`apps/web/src/` 中实现。
配置 `AOD_ANTIGRAVITY_ENABLED=true`、`AOD_ANTIGRAVITY_DEDICATED=true`、
`AOD_ANTIGRAVITY_COMMAND`、`AOD_ANTIGRAVITY_HOME` 与 `AOD_ANTIGRAVITY_WORKSPACE`
即可在 Connector 与界面中启用 owner-only 的 `antigravity` 运行时。
已支持图片/文本附件（`attachments`）、有界工具输出详情、上下文与 token 用量统计
（`usage_update` / `session/prompt` `usage`）、通过 `agy models` 动态发现模型目录与按会话切模型
（支持可选的 `AOD_ANTIGRAVITY_MODEL` 默认模型与 `AOD_ANTIGRAVITY_MODEL_CHOICES` 白名单覆盖 + `session/set_model`）
以及看板上下文透传。尚未支持的能力（`compact`、`interactions`）保持禁用并明确返回 `409`。
不分发原生可执行程序。

## 账号额度卡片

在运行 CLI 的 AOD 实例中，打开工作区的 **布局预设 → Antigravity 账号额度**，
或在桌面工具中打开 **Antigravity 账号额度**。无需创建任务板。
独立卡片在配置好的 AOD Antigravity 目录中执行 `agy --output-format json -p '/usage'`，
展示各模型组和额度周期的剩余百分比及 CLI 上报的重置时间。卡片直接展示各模型组
（不重复渲染顶部标题横幅），并将额度查询时间放在 Gemini 模型分组标题行内
（若未返回 Gemini 模型分组则回退到首个分组标题行）。这里显示的是账号额度，
不是单会话 token 用量或账单。打开卡片即可查询，也可点击 **刷新**；卡片可见时每
60 秒自动刷新，服务端最多复用 30 秒内的成功快照。

本机管理员接口 `GET /api/antigravity/usage` 不接受 Connector 传输授权，也不能指定远程
Connector。未启用时返回 `{ "usage": null }`，无权访问时返回 `403`，无法查询额度时
返回 `503`（例如需要登录或 CLI 未返回结构化 `/usage` JSON）。浏览器不缓存响应。

## 已实现的契约

- 使用明确配置的绝对路径启动 `agy acp --disable-telemetry`（当设置
  `AOD_ANTIGRAVITY_PERMISSION_MODE=deny` 时附加 `--sandbox`），不经过 shell。
- 协商 ACP 版本 1，然后新建会话，或恢复经过独立归属校验的会话。
  不通过列举或加载其他会话来恢复执行。
- 发送提示前要求调用方持久化执行意图。每个子进程只发送一次提示；
  失败或断连后不自动重试未知投递。
- 在帧大小限制内解码分片 UTF-8 和逐行 JSON-RPC；拒绝无效响应、
  其他会话的更新以及不兼容的协议版本。
- 通过 `AOD_ANTIGRAVITY_PERMISSION_MODE` 控制工具权限（默认 `allow`，响应
  ACP `session/request_permission` 选择允许项以支持本地读写与命令执行；设为
  `deny` 时启用 `--sandbox` 并拒绝权限请求）。不声明客户端侧文件系统或终端能力，
  绝不传入 `--dangerously-skip-permissions`。
- 使用环境变量白名单，以及专属 HOME、XDG 目录和临时目录；不继承 API Key、
  ADC、供应商配置或代理变量。认证必须在专属 HOME 中独立准备。
- 要求规范路径、服务账号持有的 `0700` HOME 和私有子目录。解析器默认关闭，
  要求 `DEDICATED=true`，以及绝对路径 `COMMAND`、`HOME`、`WORKSPACE` 和
  有界的 `STARTUP_TIMEOUT_MS`；所有字段使用 `AOD_ANTIGRAVITY_` 前缀。
  尚未实现 Windows 原生执行。
- 复用 `PrivateAgentHomeLease`，使用 Antigravity 专用 owner 和 binding 标记，
  将专属 HOME 绑定到精确的 Connector 数据库和节点；即使 Claude/Copilot 已正常退出，
  也拒绝复用其 HOME。绝不自动回收遗留 owner 标记。
- 使用不可变的 AOD 会话/执行/owner epoch 标识约束执行。在异步初始化后重新验证
  恢复会话的归属，先绑定并持久化意图再投递，拒绝其他会话及收尾后的转录更新。
- 在持久化终态及释放 HOME 前排空 worker。无法证明物理清理或结算失败时，保留 owner
  防护标记。强制清理会将供应商完成降级为 `unknown`；初始化或持久化期间取消，不会
  伪造供应商停止证明，也不触发重放。

`assertOwnership` 和 `persistIntent` 是集成边界，不是已经实现的日志或权限系统。
ACP 取消结果及 `inspectTransportClosed()` 都不能证明历史已持久化，
也不能证明后代进程已经退出。CLI 权限规则和沙箱行为独立于 AOD 授权。
此模块不是不可信用户执行沙箱。

`AntigravityOwnedExecution` 协同 `AntigravityJournal`（基于 `DatabaseSync` 与
`observedSavepoint`）和 `AntigravityProcessWorker`（封装 `AntigravityAcpClient` 与进程组排空）。
日志原子校验精确的执行/owner epoch，约束会话归属，并在确认意图之前完成持久化。
结算必须把确认结果不明的意图按 `unknown` 对账，对同一执行保持单调且幂等，拒绝过期
owner 或相互冲突的终态。确认失败后不自动重试。尚未投递的结果省略原生会话 ID 时，
绝不能清除或重新绑定现有持久会话。

`AntigravityProcessWorker.stopAndDrain()` 提供独立且有界的进程树清理证据。`cleaned` 只允许在
结算后物理释放 HOME；已知终态还要求 `quiescent`，即没有强制清理。原始
`AntigravityAcpClient` 有意不实现执行 worker 接口：不能用其 `finished` 或
`inspectTransportClosed()` 填充此证据端口。worker 分配失败时保留 HOME 防护标记，
因为分配失败不能证明没有子进程启动。测试不使用活动数据库或真实供应商。

## 剩余验收

1. 使用独立安装的 `agy` 可执行程序、专属 `AOD_ANTIGRAVITY_HOME` 与
   `AOD_ANTIGRAVITY_WORKSPACE` 完成无害实机端到端验收。
2. 在公开发布前完成开源审查与发布检查（`pnpm check:review` 与 `pnpm check:publication`）。

协议夹具测试不登录 Google，也不调用真实供应商。因此不能据此确认原生兼容性、
运行验收、许可证权利或发布批准。

## 验证

在仓库根目录使用现有源码测试运行器：

```bash
pnpm test:module agent:antigravity
pnpm test:scripts documentation.test.mjs test-modules.test.mjs
```

夹具仅在临时目录中启动合成本地程序。禁止将私有业务历史、共享凭据或失败的
生产会话作为验收输入。

## Subagent 观测兼容

Antigravity CLI 通过 ACP 上报的 subagent 工具调用（`Run invoke_subagent`、`Run define_subagent`、`Run send_message`、`Run manage_subagents`）会投影为 `ChatMessage['codexSubagent']`（`CodexSubagentObservation`），使 Web UI 的子智能体面板可直接展示 Antigravity 的子智能体活动。

## 协议参考

- [Google Antigravity CLI ACP](https://antigravity.google/docs/cli/acp)
- [Google Antigravity ACP 集成](https://antigravity.google/docs/ide/extensions/acp)
- [ACP 版本 1 schema](https://github.com/agentclientprotocol/agent-client-protocol/tree/main/schema/v1)

这些链接仅用于协议参考，不代表已经锁定兼容性矩阵，也不代表 AOD 分发第三方
源码或原生二进制。

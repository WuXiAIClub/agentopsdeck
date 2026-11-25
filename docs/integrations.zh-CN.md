# 智能体与 Hub/Connector 集成

**简体中文 · [English](integrations.md) · [文档导航](README.zh-CN.md)**

## 执行边界

原生执行必须主动开启。AOD 不提供供应商订阅、凭据代理，也不是不可信用户
沙箱。智能体需按其支持流程单独安装和认证，并使用专属原生 HOME、项目工作区
及系统账号。禁止导入其他私有实例的配置或历史。供应商及专有运行时条款不受
AOD 许可证替代。

## Codex 适配器配置

单独准备兼容的原生可执行程序后，在专属 `.env` 或外部服务配置中设置：

```dotenv
AOD_CODEX_ENABLED=true
AOD_CODEX_HOME=/srv/agentopsdeck/codex-home
AOD_CODEX_DEFAULT_CWD=/srv/agentopsdeck/workspace
AOD_CODEX_APPROVAL_POLICY=on-request
```

这些是绝对路径示例，并非仓库已创建的目录。使用前应为服务账号创建并保护。
POSIX 默认命令为 `codex`，Windows 为 `codex.cmd`，可用 `AOD_CODEX_COMMAND`
覆盖。不指定模型／供应商时由原生运行时选择默认值；真实供应商配置放在源码外。
`<AOD_CODEX_HOME>/config.toml`（`env_key`）引用的供应商 API 密钥可写入专属
`<AOD_CODEX_HOME>/.env`（权限 `0600` 且归属服务账号），或通过
`AOD_CODEX_ENV_PASSTHROUGH` 显式列出变量名从服务进程环境透传。

审批值支持 `never`、`on-request`、`untrusted`，继承默认值为 `never`。
**审批策略不等于文件系统沙箱**：执行器可以访问服务账号拥有权限的文件。
应结合 OS／容器隔离及受限可信工作区，首个任务前审查工具权限；只改审批策略
不能让多租户执行自动变得安全。

先在一次性工作区中新建合成会话，运行无害任务，检查历史、工具结果、关闭与
后台状态。不要用故障业务旧会话做安装测试，不要自动重放旧任务。
当前源码草稿不承诺已锁定并验收的原生运行时／供应商兼容矩阵。

## 其他适配器

Antigravity CLI 正在功能分支中独立开发。ACP 传输测试还不代表已提供可选择的
生产连接器；参见 [Antigravity CLI 开发](antigravity-cli.zh-CN.md)，了解已实现的
契约以及尚待完成的生命周期、标识和界面接入。目前不宣称可以启用。

初始 `AOD_LOCAL_OPENCLAW_CLI`、`AOD_HERMES_ENABLED`、`AOD_CLAUDE_ENABLED`、
`AOD_COPILOT_ENABLED` 均为 false。打开开关不等于安装 CLI、认证成功或兼容
验收。OpenClaw 网关使用 `AOD_OPENCLAW_GATEWAY_WS_URL`、
`AOD_OPENCLAW_GATEWAY_ADMIN_RPC_URL`、`AOD_OPENCLAW_GATEWAY_OWNER_TOKEN`，
必要时配置 `AOD_OPENCLAW_GATEWAY_PASSWORD`。这些值需保密；本机 CLI 和
远端网关是不同接入路径。

各适配器可选设置以 `apps/server/src/config.ts` 和相邻 `config-*.ts` 模块为准。
启用前审查配置合同及许可证，真实供应商执行不属于已完成的本地验收。

## 服务角色

| `AOD_SERVER_ROLE` | 用途 |
| --- | --- |
| `all` | 默认，一进程包含本机 Hub 与 Connector，推荐首次使用。 |
| `hub` | 控制面及网页，执行由另行授权的 Connector 提供。 |
| `connector` | 执行及资源端点，不能替代 Hub 工作区界面。 |

每个进程都必须有独立端口、数据目录和原生 HOME，不能共享活跃数据库、
Token 存储或队列。

已审查的直接 Hub→Connector 接入可使用以下**私有**设置：

- Connector：`AOD_CONNECTOR_ENV_ID`、`AOD_CONNECTOR_ENV_LABEL`、
  `AOD_CONNECTOR_BOOTSTRAP_TOKEN`，后者默认回退到该 Connector 的 `AOD_ACCESS_KEY`。
- Hub：`AOD_HUB_LOCAL_CONNECTOR_URL`、`AOD_HUB_LOCAL_CONNECTOR_TOKEN`、
  `AOD_HUB_LOCAL_CONNECTION_ID`、`AOD_HUB_LOCAL_CONNECTION_LABEL`。
- Hub 密钥库：`AOD_HUB_VAULT_SECRET`，默认回退到 Hub 的访问密钥。

授权需按现有连接／权限流程办理，限制网络访问，并保留 Token 与密钥库状态。
这里提供字段参考，不代表跨主机配对已验收。不能把 bootstrap token 放入命令
参数或公开真实示例。独立部署未验收前优先使用一体化模式。

## 未提供的组件

可选反向连接／沙箱蓝图中的 `agentopsdeck-connector` 可执行程序和镜像需要
操作者提供；本仓库不提供对应的 npm 初始化包。核心服务源码才是起点。
Windows／Android／iOS 源码为骨架，不是已验收的安装包。

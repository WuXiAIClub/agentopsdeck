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

当 Codex 的有效配置设置 `model_catalog_json` 时，AOD 使用原生 `model/list`
目录，保留可见性与显示名称，不再查询自定义供应商的 `/models` 接口。
将目录放在专属原生 HOME 中，并在启动 AOD 前刷新。不指定目录时，
自定义供应商的 HTTP 模型发现行为不变。

### 原生环境与本机供应商桥接

Windows 上建议将 `AOD_CODEX_COMMAND` 设置为原生 `codex.exe` 的绝对路径。
AOD 为子进程构造受限的 `PATH` 和专属 `HOME`、`USERPROFILE`、
`LOCALAPPDATA`；依赖原用户目录寻找 Codex 的安装包装脚本可能因此失效。
不要使用会导入其他实例设置或历史的包装脚本。

`AOD_*` 用于 AOD 服务配置，不用于 `<AOD_CODEX_HOME>/.env` 中的供应商密钥：
原生环境文件拒绝 `AOD_*`、`HOME`、`PATH`、`CODEX_HOME` 等执行控制变量。
使用供应商自身的变量名，例如由 Codex `env_key` 引用的 `VEKIL_API_KEY`。
真实值只写入私有原生环境文件，不公开、不复用其他实例的凭据。
任意父进程环境变量（包括代理设置）不会自动继承；显式供应商透传使用
`AOD_CODEX_ENV_PASSTHROUGH`。

使用可选 [Vekil](https://github.com/sozercan/vekil) 桥接时，需单独安装、认证，
将监听范围限制为本机并开启调用方认证。检查就绪状态后运行无害的 Codex
任务，不要仅凭模型列表请求成功判断可用。AOD 为 Codex 设置
`NO_PROXY=localhost,127.0.0.1,::1`；独立运行的 Codex 可能也需要这些本机
排除项，避免 Windows 或企业代理在请求到达 Vekil 前返回 502。
保留其他代理设置。

Copilot 的 Gemini 模型可能只提供 Chat Completions，而不是原生 Responses。
Codex 要求 Responses，需针对这些公开模型 ID 显式开启 Vekil 的
`--responses-over-chat-models`。这是适配 Copilot 接口，不是直连 Google
Gemini API。遵循 Vekil 当前兼容要求：Chat 模型的图像及工具能力受限，
不能假设支持托管搜索、远程压缩、Responses Lite、Code Mode、
自由格式 `apply_patch` 或 Responses WebSockets。适用时使用其固定模型的
托管启动器；持久运行的专属 Codex 配置需应用等效保护设置。

审批值支持 `never`、`on-request`、`untrusted`，继承默认值为 `never`。
**审批策略不等于文件系统沙箱**：执行器可以访问服务账号拥有权限的文件。
应结合 OS／容器隔离及受限可信工作区，首个任务前审查工具权限；只改审批策略
不能让多租户执行自动变得安全。

先在一次性工作区中新建合成会话，运行无害任务，检查历史、工具结果、关闭与
后台状态。不要用故障业务旧会话做安装测试，不要自动重放旧任务。
当前源码草稿不承诺已锁定并验收的原生运行时／供应商兼容矩阵。

## 其他适配器

### VS Code Agent Host（AHP）

实验性的 Windows 客户端通过已认证的本机命名管道连接到明确指定的 VS Code
编辑器实例。它可以连接一条已有会话，读取近期文本并发送文本，不另启
Copilot 进程。它不修改 VS Code 的工具审批策略，也不会自动重发未确认消息。

使用专用 Windows Connector（`AOD_SERVER_ROLE=connector`），仅监听
`127.0.0.1`，使用独立的 `AOD_DATA_DIR`、空闲端口及新生成的
`AOD_CONNECTOR_BOOTSTRAP_TOKEN`。在私有配置中将 `AOD_AHP_VSCODE_CLI` 设为
`code-tunnel.exe` 的绝对路径，`AOD_AHP_INSTANCE_ID` 设为明确的编辑器实例，
`AOD_AHP_SESSION_URI` 设为选定的 `ahp-session:/…` URI。通过本机 VS Code CLI
查找这些标识；端点发现结果含有密钥，不要复制到 Hub、日志或版本库。

在同一台机器上，以连接所有者身份把仅监听回环地址的 Connector 注册到可信
Hub；在连接详情中选择**打开 VS Code 会话**。这里操作的是原会话，不会新建
对话，也不会将它变成共享 Hub 会话。Hub 可代你读取和发送文本，因此不要
接入不可信或共享的 Hub，也不要把 Connector 或命名管道开放到网络。

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

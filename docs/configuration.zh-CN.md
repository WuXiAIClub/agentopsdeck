# 配置独立实例

**简体中文 · [English](configuration.md) · [文档导航](README.zh-CN.md)**

先完成 [安装](installation.zh-CN.md)，禁止与其他实例共享活跃状态。

## 默认值与隔离

| 设置 | AOD 默认值 |
| --- | --- |
| API／编译网页 | `127.0.0.1:8890` |
| 开发网页 | `127.0.0.1:5180`，端口严格模式 |
| Linux／macOS 数据 | `${XDG_DATA_HOME:-$HOME/.local/share}/agentopsdeck` |
| Windows 数据 | `%LOCALAPPDATA%/agentopsdeck`，有用户目录回退 |
| Codex HOME | `<AOD_DATA_DIR>/codex-home` |
| 工作区 | `<AOD_DATA_DIR>/workspace` |
| OpenClaw HOME | `<AOD_DATA_DIR>/openclaw-home` |
| 原生智能体 | 初始关闭，按适配器显式启用 |

内部 Hub／Connector API 和协议头保留兼容。AOD 使用 `agentopsdeck_session`、
`agentopsdeck_access` Cookie 及 `x-agentopsdeck-key` 请求头，语言与缓存标识
采用 AOD 命名空间，但 AOD 实例间共用这些名称，名称本身不能隔离两个部署。
Cookie 不按端口隔离；不同认证实例需不同主机名或浏览器配置。
同主机名的认证边界需另行审查，不能仅因端口不同就认为完全隔离。

状态文件默认以 `.agentopsdeck-*` 命名，每文件覆盖属于私有设置，不能共享
活跃数据库。`AOD_PORT` 优先于通用 `PORT`。应用配置只使用文档列出的
`AOD_*` 变量；原生网关凭据使用 `AOD_OPENCLAW_GATEWAY_*`。

## 配置加载顺序

默认只加载 AOD 仓库根目录 `.env`，不向父目录查找。
服务可用绝对 `AOD_CONFIG_FILE` 路径指定外部 dotenv；明确指定但文件缺失时
启动失败，不悄悄回退。进程环境优先于文件设置。Vite 读取根 `.env`，不会
自动读取外部服务配置；构建期资源来源需单独设置。

## 常用变量

| 变量 | 含义 |
| --- | --- |
| `AOD_PORT` | API／编译网页端口，默认 `8890`。 |
| `AOD_LISTEN_HOST` | 监听 IP，默认 `127.0.0.1`，不能填主机名。 |
| `AOD_SERVER_ROLE` | `all`、`hub`、`connector`，默认 `all`。 |
| `AOD_ACCESS_KEY` | 私有登录／初始化密钥，用工具生成，不能入库。 |
| `AOD_CONFIG_FILE` | 明确指定的外部服务 dotenv 文件，使用绝对路径。 |
| `AOD_DATA_DIR` | 独立、绝对且不是文件系统根目录的数据路径。 |
| `AOD_PUBLIC_BASE_URL` | 实例规范外部 HTTP(S) 地址。 |
| `AOD_ALLOWED_ORIGINS` | 逗号分隔的允许来源，不是跳过认证的开关。 |
| `AOD_AUTH_TRUSTED_PROXIES` | 可信代理地址，只信任自己管理的代理。 |
| `AOD_HUB_VAULT_SECRET` | Hub 密钥库秘密，默认使用访问密钥；升级需保留。 |
| `AOD_VITE_API_TARGET` | 开发 API 目标，默认 `http://127.0.0.1:8890`。 |
| `AOD_VITE_ALLOWED_HOSTS` | 开发主机允许列表，不应公开暴露 Vite。 |
| `AOD_WEB_RESOURCE_ORIGINS` | 网页资源来源，在 Vite 构建／开发时读取。 |

独立本机配置示例，密钥另行私有配置：

```dotenv
AOD_SERVER_ROLE=all
AOD_LISTEN_HOST=127.0.0.1
AOD_PORT=8890
AOD_DATA_DIR=/srv/agentopsdeck/data
AOD_CODEX_HOME=/srv/agentopsdeck/codex-home
AOD_CODEX_DEFAULT_CWD=/srv/agentopsdeck/workspace
AOD_OPENCLAW_HOME=/srv/agentopsdeck/openclaw-home
AOD_CODEX_ENABLED=false
AOD_LOCAL_OPENCLAW_CLI=false
AOD_HERMES_ENABLED=false
AOD_CLAUDE_ENABLED=false
AOD_COPILOT_ENABLED=false
```

这些 `/srv` 路径只是示例，文档不会创建特权目录；为服务账号准备并限制访问。
先用安装工具生成密钥，再将配置移出源码。已有数据必须保留对应密钥库及
认证秘密，不能靠换密钥绕过解密或登录失败。

修改开发 API 端口时同步修改 `AOD_VITE_API_TARGET`；资源来源改变后重建
编译网页。根 `.env` 保持被忽略的普通文件，外部服务配置不自动影响 Vite。

## 文件与预览权限

`AOD_FILE_ROOTS_JSON` 将智能体 ID 映射到具体绝对项目目录，例如
`{"main":"/srv/agentopsdeck/projects/demo"}`。目录及授权仍需单独准备；
文件系统根目录和用户 HOME 本身会被拒绝，`AOD_FILE_LOCAL_WRITE` 为独立开关。

`AOD_SOURCE_PREVIEW_ROOTS` 是预览根目录 JSON 数组。产物及媒体分别使用
`AOD_ARTIFACT_ALLOWED_DIRS`、`AOD_ARTIFACT_ALLOWED_DIRECT_CHILD_DIRS`、
`AOD_MEDIA_BRIDGE_ALLOWED_DIRS`。初始列表为空，仅开放必要项目范围，不要
开放整个 `/srv` 或其他应用状态。这些设置不绕过 Hub 授权或 OS 权限；
复杂策略先查看源码解析器。

入站附件绑定于 `AOD_DATA_DIR/media/inbound`，不使用提供商的环境 HOME。
POSIX 私有媒体目录要求当前用户所有权及 `0700`，落盘文件使用 `0600`。
已有目录应显式准备或审查，不能静默修复另一实例的存储。文件浏览使用启动
配置中的原生根及显式 `AOD_OPENCLAW_CONFIG_FILE`，不继承原生配置文件。

可选本机 OpenClaw CLI 仍需 `AOD_LOCAL_OPENCLAW_CLI=true`。其配置的私有
HOME 必须已存在，且与环境中继承的提供商 HOME、源码及工作区根分离。
`AOD_OPENCLAW_CLI_PATH` 显式指定可信可执行文件；否则仅使用受控运行时
搜索路径。原生启动不继承父进程凭据或任意运行设置。

## 智能体与角色

智能体需独立安装、认证和配置专属 HOME。Codex 审批默认 `never`，审批不是
文件系统沙箱；配置字段、执行边界及角色拆分见 [集成指南](integrations.zh-CN.md)。

## 容器范围

没有假设公开 AOD 镜像，需自行构建。本机端口发布、数据卷及必要环境覆盖
见 [安装指南](installation.zh-CN.md)。源码镜像默认一体化，独立 Connector
可设置 `AOD_SERVER_ROLE=connector`，但需另行配对验收；原生及容器未验收。
反向连接／临时沙箱蓝图需要操作者提供 `agentopsdeck-connector` 可执行程序
及镜像，仓库没有对应 CLI 或 npm 包，不能当成受支持的初始化入口。
默认 Android 源码不含 LAN 白名单。

## 可选浏览器流辅助脚本

`scripts/playwright-browser-stream-daemon.mjs` 为实验性工具，不由服务或 CI 启动。
必须显式提供绝对路径 `AOD_CHROMIUM_EXECUTABLE`；命令/帧默认位于私有
`AOD_DATA_DIR` 下的 `browser-stream/`，或独立 XDG/HOME 数据目录，不读取已有
发布目录/工作树。`AOD_BROWSER_STREAM_CMD_FILE` 可覆盖命令文件；
`AOD_BROWSER_STREAM_OUTPUT_DIRS` 可提供绝对目录的 JSON 数组；
`AOD_BROWSER_STREAM_LANGUAGE` 支持 `en`（默认）和 `zh-CN`。
仅配置经过回归，浏览器运行尚未验收。限制命令/帧目录的 OS 访问，不能把原始
脚本暴露给不可信用户；浏览器标志及导航并不是安全沙箱。

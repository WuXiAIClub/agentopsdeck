# 模块与执行边界

**简体中文 · [English](modules.md) · [文档目录](README.zh-CN.md)**

本图对应实际代码，不是规划架构。文档测试核对服务端目录覆盖。
接口注册见 [API 清单](api/openapi.json) 和 [API 指南](api.zh-CN.md)。
源码中存在适配器不代表已经安装、认证或启用。

## 应用入口与角色

[`apps/server/src/index.ts`](../apps/server/src/index.ts) 管理进程信号并调用
[`application-process.ts`](../apps/server/src/application-process.ts)。
[`config.ts`](../apps/server/src/config.ts) 读取私有设置，原生执行默认关闭。
[`server-role.ts`](../apps/server/src/server-role.ts) 选择 `all`、`hub` 或
`connector`；[`application.ts`](../apps/server/src/application.ts) 和
`application-*-async.ts` 组合已有同步／worker 端口。
[`application-http-shell.ts`](../apps/server/src/application-http-shell.ts)
管理 HTTP 准入、请求来源、CORS 和历史传输。`application-*-http.ts` 连接领域
端口与 HTTP；请求超时不证明任务已经停止。

## 服务端模块

| 源码模块 | 职责与边界 |
| --- | --- |
| [`apps/server/src/antigravity`](../apps/server/src/antigravity) | 实验性 Linux ACP 传输、专属 HOME 所有权及受日志/清理证明约束的执行契约。尚未接入生产或智能体选择器；参见 [CLI 开发](antigravity-cli.zh-CN.md)。 |
| [`apps/server/src/antigravity`](../apps/server/src/antigravity) | Linux Antigravity CLI ACP 传输、隔离配置和合成协议测试；尚未实现生产生命周期、持久标识绑定及界面接入。 |
| [`apps/server/src/auth`](../apps/server/src/auth) | 密钥、会话/cookie、Passkey、审计/限流、可信来源及原请求作用域；不记录认证材料。 |
| [`apps/server/src/claude`](../apps/server/src/claude) | Claude worker、权限、历史和执行归属；运行时需独立配置。 |
| [`apps/server/src/codex`](../apps/server/src/codex) | App-server RPC、轮次身份、rollout/历史、投影、工具详情和后台任务；区分历史失败与执行失败。 |
| [`apps/server/src/commands`](../apps/server/src/commands) | 幂等命令回执、消息/压缩命令观察及排队；未确认命令不得盲目重放。 |
| [`apps/server/src/connector`](../apps/server/src/connector) | 节点资源、授权、原生会话、文件/卡片同步、Git树、执行签发者、自动化、更新/维护和异步请求归属；文件操作需根目录与权限约束。 |
| [`apps/server/src/copilot`](../apps/server/src/copilot) | Copilot worker/环境、请求与流、历史、工具策略和投影；上游错误不等于停止证明。 |
| [`apps/server/src/diagnostics`](../apps/server/src/diagnostics) | 有界性能/受保护诊断；不要公开未脱敏请求。 |
| [`apps/server/src/execution`](../apps/server/src/execution) | 智能体适配器共用的独立原生进程环境，以及有界、脱敏的诊断。 |
| [`apps/server/src/gateway`](../apps/server/src/gateway) | Gateway RPC、发现和资源/执行集成；地址与凭据来自私有设置。 |
| [`apps/server/src/hermes`](../apps/server/src/hermes) | Hermes 执行和历史集成；需独立配置原生目录，默认关闭。 |
| [`apps/server/src/hub`](../apps/server/src/hub) | 存储/worker、成员身份、连接授权、共享会话、执行连续性、队列、看板/卡片/布局、文件绑定、浏览/研究和用量；权限版本必须有效。 |
| [`apps/server/src/lifecycle`](../apps/server/src/lifecycle) | 请求排空、暂停/恢复、独立维护及关闭归属；经过时间不是执行结束证明。 |
| [`apps/server/src/messages`](../apps/server/src/messages) | 消息历史传输、流及请求作用域；保留消息与工具关联。 |
| [`apps/server/src/openclaw`](../apps/server/src/openclaw) | OpenClaw 原生/Gateway、历史和资源集成；不附带账号或供应商配置。 |
| [`apps/server/src/projection`](../apps/server/src/projection) | 有界桌面/会话/消息读取投影；读视图不等于授权或执行所有权。 |
| [`apps/server/src/refresh`](../apps/server/src/refresh) | 刷新签名、请求合并、修订和读取恢复；旧事件不能复活已结束轮次。 |
| [`apps/server/src/routes`](../apps/server/src/routes) | 认证、Hub、Connector/应用会话、工作区、媒体、事件和终端 HTTP；集成前阅读守卫与测试。 |
| [`apps/server/src/storage`](../apps/server/src/storage) | 存储 worker、启动归属、持久化和数据库边界；不要直接访问其他活跃实例数据库。 |
| [`apps/server/src/system`](../apps/server/src/system) | 系统/进程/资源指标及平台帮助；指标只是观察结果。 |
| [`apps/server/src/tools`](../apps/server/src/tools) | 工具资源和策略；执行具有操作者权限。 |
| [`apps/server/src/utils`](../apps/server/src/utils) | HTTP正文、路径、脱敏和通用校验；调用者仍需领域授权。 |

根目录还包含配置、智能体/会话编排、队列、产物/媒体、语音消息、原生文件、
笔记与终端端口，其 HTTP 适配器委托给上述领域。相邻 `*.test.ts` 展示授权、
失败、持久化及恢复场景。

## 浏览器、协议与打包

- [`apps/web/src/components`](../apps/web/src/components)：桌面/窗格、消息/工具/队列、
  看板/卡片/笔记/文件、权限、连接、认证、媒体和终端。恢复按钮有条件显示，不是无保护解锁。
- [`apps/web/src/lib`](../apps/web/src/lib)：API客户端、请求/缓存治理、事件/历史/回执恢复、
  布局/菜单意图和资源地址策略，以及 [双语字典](../apps/web/src/lib/translations.ts)。
  用户内容不应作为翻译键。
- [`packages/shared/src`](../packages/shared/src)：会话/消息/队列、执行/目标、看板/卡片/文件、
  原生资源类型、校验及传输常量。[`protocol.ts`](../packages/shared/src/protocol.ts)
  中产品 **1.0.0** 与 Connector 协议范围独立。
- [`apps/android`](../apps/android)、[`apps/ios`](../apps/ios)、
  [`native/windows`](../native/windows)：原生路由、缓存、媒体/语音和启动器/安装骨架。
  应用标识统一为 AOD；尚未验收，签名与发行不属于源码 CI。
- [`scripts`](../scripts)：隔离源码/脚本/浏览器测试、分片、构建信息、安装/打包检查、
  发布/安全/双语/API检查与源码移植。历史 CI 契约只是
  [测试 fixture](../scripts/fixtures/gitlab-ci.json)，不用于部署。
- [GitHub CI](../.github/workflows/ci.yml)、[可选 GitLab 测试镜像](../.gitlab-ci.yml)
  和 [`Dockerfile`](../Dockerfile)：源码验证及实验性容器；CI 不部署服务、不发布产物。

## 跟踪一项功能

组件 → 浏览器 `lib` 客户端 → `routes` 或 `application-*-http.ts` →
Hub/Connector 领域 → 存储/适配器 → 共享校验与协议。
沿途阅读测试，不凭转圈、健康接口或超时推断任务成功或停止。
定点模块测试方式见 [开发指南](development.zh-CN.md)。

# API 参考与 OpenAPI

**简体中文 · [English](api.md) · [文档目录](README.zh-CN.md)**

## 已提供什么

服务端使用 Hono 注册路由，不是 Swagger-first 框架。提供代码生成的
[OpenAPI 3.1 JSON 路由清单](api/openapi.json)，可将这份**公开源码文档**导入
本地 Swagger UI/Editor 或其他 OpenAPI 阅读器。线上服务不新增文档接口，
不加载外部 UI 脚本；JSON 不含实例地址或访问密钥。

这**不是完整 SDK schema**。各操作的 `x-aod-sources` 指向实现文件/行号，保留
原始路径，响应契约有意不虚构。认证、角色/授权、正文、状态码、WebSocket/SSE、
IPC 帧需阅读源码与测试。清单未声明 `security` **不代表匿名可调用**。
不要开启对生产实例的盲目 “Try it out”。

## 路由模块

| 接口族 | 实现与用途 |
| --- | --- |
| `/api/auth/*` | [`routes/auth.ts`](../apps/server/src/routes/auth.ts)：登录/状态/退出、Passkey、审计；登录限流，受保护操作需有效授权。 |
| `/api/hub/v1/*` | [`routes/hub.ts`](../apps/server/src/routes/hub.ts) 和 `routes/hub-*.ts`：连接、成员/共享授权、会话/队列/命令、看板/卡片/笔记/布局/文件绑定、浏览/研究、用量；成员与机器作用域不同。 |
| `/api/connector/v1/*` | [`connector`](../apps/server/src/connector)：节点资源、原生会话、文件、执行授权、更新/维护、自动化；供已授权连接或执行客户端使用，不是无约束浏览器接口。 |
| `/api/workspace-agent/v1/*` | [`routes/workspace-agent.ts`](../apps/server/src/routes/workspace-agent.ts)：看板机器访问；使用单独委托能力，不共享操作者密钥。 |
| `/api/sessions/*`、消息/命令和历史 | [`routes`](../apps/server/src/routes) 及 `application-*-http.ts`：应用角色门面；身份、游标、修订和历史准备语义按运行时区分。 |
| 事件、终端、媒体/产物 | [`routes/events.ts`](../apps/server/src/routes/events.ts) 和媒体路由：实时/流式资源、资源权限、受限根目录；HTTP清单不描述流帧。 |
| 健康与系统观察 | [`application-system-reads-http.ts`](../apps/server/src/application-system-reads-http.ts)：健康、Gateway和系统；健康不证明原生执行或旧会话已恢复。 |

类型/校验见 [`packages/shared/src`](../packages/shared/src)，尤其
[`protocol.ts`](../packages/shared/src/protocol.ts)、
[`history-transport.ts`](../packages/shared/src/history-transport.ts)、
[`workspace-board.ts`](../packages/shared/src/workspace-board.ts) 和
[`apps/web/src/lib`](../apps/web/src/lib) 客户端。沿用命令身份、ETag、请求作用域
与修订检查，不创建平行写入/重试系统。

## 认证与安全客户端

- 操作者使用实例私有密钥登录。原认证层处理会话 cookie、配置的 key/Bearer 头；
  端点成员/机器授权是独立约束。
- 凭据不能出现在 URL 用户信息、查询示例、版本库请求、截图或 API JSON 中。
  远程访问前配置来源/代理策略，见 [配置](configuration.zh-CN.md)。
- `outcome_unknown`、回执未确认及历史准备不允许盲目重发；保留原执行身份，
  阅读客户端观察/恢复代码。
- 集成测试只操作临时实例；导入文档或 schema 校验不等于供应商端到端验收。

## 更新与测试

生成器解析静态字面量/常量/模板路径及字面量循环。
`x-aod-unresolved-registrations` 记录未解析工厂/参数的源码位置，不静默遗漏。
同路径不同角色可共享操作但保留多个来源；`x-aod-static-registrations` 是注册数，
不是唯一接口数。
参数名不同但结构相同的模板路径会归并；原始别名保留在
`x-aod-alternate-raw-paths` 及源码引用中。

```sh
mkdir -p .local
node scripts/api-docs.mjs > .local/openapi.json
pnpm check:api
node scripts/run-script-tests.mjs api-docs.test.mjs
```

必要时先建立已忽略的 `.local/`。审查生成文件后更新 `docs/api/openapi.json`；
CI 会阻止文档漂移。完整请求/响应 schema 应在已有路由/共享校验边界逐步补充，
附带正文和授权测试；不能为了交互浏览器看起来完整而编造契约。

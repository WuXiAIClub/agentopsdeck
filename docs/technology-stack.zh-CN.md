# 技术栈与 package 审查

**简体中文 · [English](technology-stack.md)**

快照：2026 年 11 月 22 日，AgentOpsDeck 1.0.0。下列版本是当前冻结锁文件的
实际解析结果，**不是宣称所有上游均使用最新版本**。结合[模块导航](modules.zh-CN.md)
和[审查规范](open-source-review-standard.zh-CN.md)阅读。

## 架构

- ESM TypeScript/pnpm 9.15.0 单仓库，4 个 private manifest，apps/packages 下
  3 个工作区包。private 表示不发布 npm 包，不等于源码不能按适用许可分发。
- Node 最低 22.13.0，验证/托管 CI 用 22.22.1；TypeScript 5.9.3、tsx 4.22.4、
  Prettier 3.8.4。lint 实际为类型检查，不是独立 ESLint 安全分析。
- 后端 Hono 4.13.20 + Node adapter 2.1.11；Node 原生 SQLite，异步/worker
  边界及 HTTP/WebSocket/流式传输。已验证 Node 22 上 SQLite 仍为实验性；隐藏
  启动警告不会使 API 稳定。
- 认证包括访问/会话密钥、精确授权/签发者版本、SimpleWebAuthn 通行密钥。
  Hub 管工作区/会话/权限，Connector 管配置的资源，all 角色一体运行。
- 前端 React/ReactDOM 19.2.7、Vite 6.4.6、Tailwind 4.3.1、TipTap 3.31.3/
  ProseMirror、xterm 6.0.0、Markdown、Lucide、二维码；响应式中英 PWA。
  生产由应用提供编译资源，不用 Vite 开发服务对外提供生产页面。
- shared 是协议/版本/构建信息/资源与上限约定，不是独立部署的额外服务。
- 可选 agent/provider 单独配置且默认关闭；node-pty 1.1.0 要原生工具链，
  playwright-core 1.63.0 不等于附带已验收浏览器。
- Android Java/Gradle、iOS Swift、Windows C/PowerShell/安装器是源码骨架，
  不是已验收的 1.0.0 原生发行物；Docker 仍为实验路径。
- 测试沿用隔离 Node 运行器；GitHub CI 托管/只读/纯测试，本机结果不代表远端已运行。

## Manifest 审查结论

**当前依赖告警门槛通过；完整公开发布审查未批准。** 本轮重新运行生产与明确包含
开发依赖的 registry 审计，各严重度均为 0。只能检测已知告警，不能证明代码零漏洞、
供应链未失陷、许可无问题或环境信息未泄露。

4 个 manifest 的产品版本都是 1.0.0，Apache-2.0 元数据一致；工作区为本地链接。
上一轮已通过冻结安装/构建/类型检查。Node adapter 跨大版本有真实临时 HTTP
路径/权限/Cookie/流式回归；6 条限定父依赖且兼容语义版本的覆盖防止传递依赖
回落，没有引入审计豁免。

保留意见：

- Vite、React plugin、Tailwind/Vite plugin 放在 web 的运行依赖，实际为构建/
  开发参与者，使生产安装/审计范围偏大。调整需审查锁文件并回归构建/容器，不能盲改。
- Docker 复制全部构建工作区，保留开发依赖且 Node 基础镜像为浮动 tag；尚无
  镜像摘要、OS、SBOM 或容器验收。
- JS 冻结锁不覆盖独立安装的 agent、浏览器、平台包管理器及所有平台可选二进制。
- 特征扫描通过不证明无密钥；继承源码权利、资源来源及最终第三方声明仍为发布门槛。

## 全部直接依赖声明

Placement 按实际代码分类，不代表建议。^ 范围允许同大版本更新；可复现依赖靠
冻结安装和审查锁文件，而不是单靠声明范围。

| Workspace | Package | Declared | Locked/installed | Placement |
| --- | --- | --- | --- | --- |
| `agentopsdeck` | `@types/node` | `^22.10.2` | `22.19.21` | `devDependencies` |
| `agentopsdeck` | `prettier` | `^3.4.2` | `3.8.4` | `devDependencies` |
| `agentopsdeck` | `typescript` | `^5.7.2` | `5.9.3` | `devDependencies` |
| `@agentopsdeck/server` | `@agentopsdeck/shared` | `workspace:*` | `link:../../packages/shared` | `dependencies` |
| `@agentopsdeck/server` | `@hono/node-server` | `^2.1.3` | `2.1.11` | `dependencies` |
| `@agentopsdeck/server` | `@simplewebauthn/server` | `^13.3.2` | `13.3.3` | `dependencies` |
| `@agentopsdeck/server` | `hono` | `^4.13.16` | `4.13.20` | `dependencies` |
| `@agentopsdeck/server` | `nanoid` | `^5.1.16` | `5.1.16` | `dependencies` |
| `@agentopsdeck/server` | `node-pty` | `1.1.0` | `1.1.0` | `dependencies` |
| `@agentopsdeck/server` | `playwright-core` | `1.63.0` | `1.63.0` | `dependencies` |
| `@agentopsdeck/server` | `ws` | `^8.18.0` | `8.21.0` | `dependencies` |
| `@agentopsdeck/server` | `@types/ws` | `^8.5.13` | `8.18.1` | `devDependencies` |
| `@agentopsdeck/server` | `tsx` | `^4.19.2` | `4.22.4` | `devDependencies` |
| `@agentopsdeck/server` | `typescript` | `^5.7.2` | `5.9.3` | `devDependencies` |
| `@agentopsdeck/web` | `@agentopsdeck/shared` | `workspace:*` | `link:../../packages/shared` | `dependencies` |
| `@agentopsdeck/web` | `@simplewebauthn/browser` | `^13.3.0` | `13.3.0` | `dependencies` |
| `@agentopsdeck/web` | `@tailwindcss/vite` | `^4.3.1` | `4.3.1` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/extension-image` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/extension-table` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/extension-task-item` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/extension-task-list` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/markdown` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/pm` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/react` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/starter-kit` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@vitejs/plugin-react` | `^4.3.4` | `4.7.0` | `dependencies` |
| `@agentopsdeck/web` | `@xterm/addon-fit` | `0.11.0` | `0.11.0` | `dependencies` |
| `@agentopsdeck/web` | `@xterm/xterm` | `6.0.0` | `6.0.0` | `dependencies` |
| `@agentopsdeck/web` | `class-variance-authority` | `^0.7.1` | `0.7.1` | `dependencies` |
| `@agentopsdeck/web` | `clsx` | `^2.1.1` | `2.1.1` | `dependencies` |
| `@agentopsdeck/web` | `lucide-react` | `^1.21.0` | `1.21.0` | `dependencies` |
| `@agentopsdeck/web` | `marked` | `17.0.6` | `17.0.6` | `dependencies` |
| `@agentopsdeck/web` | `qrcode.react` | `4.2.0` | `4.2.0` | `dependencies` |
| `@agentopsdeck/web` | `react` | `^19.0.0` | `19.2.7` | `dependencies` |
| `@agentopsdeck/web` | `react-dom` | `^19.0.0` | `19.2.7` | `dependencies` |
| `@agentopsdeck/web` | `react-markdown` | `^10.1.0` | `10.1.0` | `dependencies` |
| `@agentopsdeck/web` | `remark-gfm` | `^4.0.1` | `4.0.1` | `dependencies` |
| `@agentopsdeck/web` | `tailwind-merge` | `^3.6.0` | `3.6.0` | `dependencies` |
| `@agentopsdeck/web` | `tailwindcss` | `^4.3.1` | `4.3.1` | `dependencies` |
| `@agentopsdeck/web` | `vite` | `^6.4.4` | `6.4.6` | `dependencies` |
| `@agentopsdeck/web` | `@types/react` | `^19.0.2` | `19.2.17` | `devDependencies` |
| `@agentopsdeck/web` | `@types/react-dom` | `^19.0.2` | `19.2.3` | `devDependencies` |
| `@agentopsdeck/web` | `typescript` | `^5.7.2` | `5.9.3` | `devDependencies` |

## 重要传递依赖

PostCSS 8.5.33、其 NanoID 3.3.20（不能与后端 5.1.16 混成跨大版本覆盖）、
Browserslist 4.29.6、baseline-browser-mapping 2.11.39、source-map-js 1.2.4。

## API、文档与边界

OpenAPI 3.1 是静态路由清单，上一已验证快照有 481 注册、325 规范路径、137
未解析注册，不是完整请求体/认证/流式 schema 或在线 Swagger。394 个动态翻译
调用不在字面量目录检查的覆盖内。提供商、真实浏览器/触控、macOS/Windows、
原生、HTTP2/TLS 和容器需要另行验收。见[API](api.zh-CN.md)、[CI](ci.zh-CN.md)、
[许可状态](../LICENSE-STATUS.md)和[验证记录](validation-1.0.0.md)。


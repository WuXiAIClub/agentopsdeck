# AgentOpsDeck（AOD）

**简体中文 · [English](README.md)**

面向智能体会话的双语、自托管运维工作台。AgentOpsDeck 1.0.0 从已整合的
前身项目的纯源码快照独立出来，使用新的 Git 历史和独立的应用配置。
当前是**公开发布前的源码草稿**，分发前必须确认 [许可状态](LICENSE-STATUS.md)。

**发布阻断：**[详细源码审查](docs/open-source-review-1.0.0.zh-CN.md)记录了未修复风险
和未完成的语义覆盖；依赖零告警不等于源码安全通过。

**从这里开始：**[安装](docs/installation.zh-CN.md) · [使用](docs/user-guide.zh-CN.md) ·
[配置](docs/configuration.zh-CN.md) · [全部文档](docs/README.zh-CN.md)

## 官网与联系

- 官网：[agentopsdeck.com](https://agentopsdeck.com)
- 项目联系邮箱：[AOD@wuxiaiclub.com](mailto:AOD@wuxiaiclub.com)

## 包含的能力

- Hub / Connector / all 一体化角色、响应式 React PWA、英文和简体中文界面。
- 会话历史、消息和工具时间线、队列、工作区看板、笔记、文件和权限管理。
- 原有执行身份恢复、历史同步，以及结果未知任务的保护机制。
- 可选原生智能体适配器，不包含供应商账号、凭据、历史或本机工作区。

核心包名、协议头、cookie和Connector令牌采用独立AOD命名空间；剩余隔离及验收
缺口见审查报告。上游补丁移植前需规范化并审查。产品版本与协议版本独立，
核心包和共享产品版本统一为 **1.0.0**。
Android / iOS / Windows 的源码骨架保留，但不作为 1.0.0 已验收的原生安装包。

## 开发环境启动

使用已审查的源码检出／压缩包，在其根目录执行命令；当前不承诺已有公开
clone 地址或预编译安装包。Linux 源码启动已验证，其他平台及容器需另行验收。

需要 Node.js 22.13+、pnpm 9.15.0，以及现有终端依赖需要的 C++ 构建工具。
原生智能体需另行安装和配置，默认不启用。

```sh
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile --prod=false
```

生成独立访问密钥并直接写入被忽略的 `.env`，不打印密钥：

```sh
node scripts/create-local-config.mjs
pnpm dev
```

工具在需要时读取 `.env.example`，保留已有设置，拒绝替换非空密钥。
不要覆盖已有 `.env`；登录密钥仅用本机私有编辑器查看，不能放进支持日志。

工具用独占的 `.env.aod-config.lock` 拒绝并发生成。如果进程被终止，先私下核对
已没有生成器运行，才能移除残留锁；工具不会抢占已有锁。

打开 `127.0.0.1:5180`，API 默认绑定 `127.0.0.1:8890`。登录时使用自己的
私有访问密钥。这些是 AgentOpsDeck 的开发默认端口；此命令不会创建系统服务。

编译后运行：

```sh
pnpm --workspace-concurrency=1 -r build
pnpm --filter @agentopsdeck/server start
```

编译后访问 `http://127.0.0.1:8890`，API 与网页由同一服务提供。

开启适配器或远程访问前，先阅读 [独立实例配置](docs/configuration.zh-CN.md)。
界面沿用现有语言切换；未设置偏好时，按浏览器语言选择 `en` 或 `zh-CN`。

详细环境要求、健康检查及实验性本机 Docker 示例见
[安装指南](docs/installation.zh-CN.md)。仓库不会安装守护服务或修改现有服务。

## 架构与安全操作

```text
浏览器 → Hub（会话、工作区、权限）
          → Connector（已配置资源和原生智能体）
```

默认 `all` 将 Hub 与 Connector 一体化运行；拆分部署需要独立状态、授权和
验收，见 [集成指南](docs/integrations.zh-CN.md)。原生执行需主动开启，使用
操作者权限，不是不可信用户沙箱。凭据、原生 HOME 和历史保留在源码外。

执行失败、历史同步失败和后台工作是不同状态。恢复不能把超时当停止证明，
不能重放 `outcome_unknown`。维护活跃实例前先读
[使用指南](docs/user-guide.zh-CN.md)、[故障排查](docs/troubleshooting.zh-CN.md)
及 [运维指南](docs/operations.zh-CN.md)。

## 验证与贡献

```sh
pnpm check:publication
pnpm check:i18n
pnpm --filter @agentopsdeck/shared build
node scripts/run-source-tests.mjs server config-agentopsdeck.test.ts config-portability.test.ts connector/version.test.ts
node scripts/run-source-tests.mjs web lib/i18n.test.ts
node scripts/run-script-tests.mjs documentation.test.mjs publication-check.test.mjs upstream-patch.test.mjs write-build-info.test.mjs create-local-config.test.mjs
pnpm --workspace-concurrency=1 -r build
```

测试选择器、文档测试及全量边界见 [开发指南](docs/development.zh-CN.md)，
实际执行结果见 [验证记录](docs/validation-1.0.0.md)。

## 许可证

AgentOpsDeck 自有代码采用 [Apache-2.0](LICENSE)。第三方代码和资源保留各自
许可证及声明。公开分发前仍需确认继承源码的分发权并审核发行物中的第三方
声明，详见 [许可状态](LICENSE-STATUS.md)。

参阅 [贡献规范](CONTRIBUTING.md)、[安全规范](SECURITY.md)、
[上游移植与双远端同步](docs/upstream-sync.md) 和 [1.0.0 范围](docs/release-1.0.0.md)。
验证结果与未验证边界见 [本地验证记录](docs/validation-1.0.0.md)。
本地验证不代表远端 CI 已通过，也不代表旧故障业务会话已验收。

主要使用 [GitHub测试CI](docs/ci.zh-CN.md)，另提供可移植GitLab测试镜像；不部署、不上传产物。
代码导航参阅 [模块图](docs/modules.zh-CN.md)、[API/OpenAPI](docs/api.zh-CN.md)、
[安全审查](docs/security-review.zh-CN.md)、[双语指南](docs/i18n.zh-CN.md)。
OpenAPI由代码生成，但不虚称完整的正文或授权schema。

当前提取不会配置 GitHub 远端、登录、创建初始提交或标签，也不会部署新实例。
首次公开推送前需要维护者确认分发权、第三方合规和发布仓库。

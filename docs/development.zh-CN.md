# 开发与文档维护

**简体中文 · [English](development.md) · [文档导航](README.zh-CN.md)**

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `apps/web` | React PWA、工作区及双语翻译。 |
| `apps/server` | Hub／Connector、认证、队列、适配器及投影。 |
| `packages/shared` | 共享协议、产品版本和构建元数据。 |
| `scripts` | 现有测试、发布扫描及上游移植工具。 |
| `docs` | 公开安装、使用及发布边界。 |
| `.github/workflows` | 源码 CI，无自动部署或私有凭据。 |

统一使用 `@agentopsdeck/*` 和AOD协议标识，上游补丁先规范化。不混淆第三方与
AOD产品版本。参阅 [模块图](modules.zh-CN.md)、[API参考](api.zh-CN.md)、
[双语指南](i18n.zh-CN.md)、[CI](ci.zh-CN.md)。原生源码保留为骨架。

常规构建只生成溯源信息，不从 Git tag 或不一致的包版本推断/改写产品版本。
四个 manifest 与共享协议版本需通过明确审查的发行变更对齐。
`syncWorkspaceVersion` 为显式调用工具，不是构建钩子。

## 工作流程

1. 读 [贡献规范](../CONTRIBUTING.md)、[安全规范](../SECURITY.md) 和适用 `AGENTS.md`。
2. 按 [安装指南](installation.zh-CN.md) 准备依赖，忽略私有 `.env`，开发用独立状态。
3. 在现有组件／服务最小修改，不加平行恢复／菜单／队列系统，保留键盘、焦点、
   触控及无障碍。
4. 同步中英文 UI 和文档，说明配置及未支持边界。
5. 先定向再按需扩大测试，准确报告范围，不把 fixture 当生产验收。

## 验证命令

安装依赖后，在仓库根目录运行：

```sh
pnpm check:publication
pnpm check:i18n
pnpm --filter @agentopsdeck/shared build
node scripts/run-script-tests.mjs documentation.test.mjs publication-check.test.mjs create-local-config.test.mjs upstream-patch.test.mjs write-build-info.test.mjs
node scripts/run-source-tests.mjs server config-agentopsdeck.test.ts config-portability.test.ts connector/version.test.ts
node scripts/run-source-tests.mjs web lib/i18n.test.ts
pnpm --workspace-concurrency=1 -r build
```

源码选择器为相对 server／web 源码树的准确路径，脚本选择器为相对 `scripts`
的准确路径。只有明确做全量时才省略选择器：

```sh
node scripts/run-source-tests.mjs web
node scripts/run-script-tests.mjs
```

定向通过不是全量通过，完整后端、浏览器 E2E、真实供应商、Docker／原生及
远端 CI 需另行规划。已有 `pnpm typecheck`、`pnpm lint`，不为文档加新框架或
格式化器。

## 文档维护

同步双语文件和导航表，使用相对链接、实际命令、合成路径，不含秘密。
`documentation.test.mjs` 检查本地 Markdown 目标、配对和部分安装／配置合同；
不验证外站、不执行每条命令，也不证明容器或供应商可用。

## 提交与发布

AOD 无继承历史；后续按 [上游同步](upstream-sync.md) 移植审查补丁，不合并
私有引用，不复制本地设置、不改其他工作树，不覆盖 AOD 版本／隔离。
初始身份为仓库本地 `WuXiAIClub <hi@wuxiaiclub.com>`，联系邮箱为
`AOD@wuxiaiclub.com`，第三方署名保留。提交／推送／标签／部署需明确授权。
GitHub 与可选 GitLab 发布同一已审查 AOD 提交，不是私有历史。

授权发布前确认分发权和发行物声明，再对干净已提交源码运行
`pnpm check:publication:release`。扫描不是许可批准、绝对无秘密或部署证明，
见 [许可状态](../LICENSE-STATUS.md) 与 [验证记录](validation-1.0.0.md)。

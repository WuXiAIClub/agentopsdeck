# 以测试为主的 CI

**简体中文 · [English](ci.md) · [文档目录](README.zh-CN.md)**

[GitHub Actions](../.github/workflows/ci.yml) 是主要CI，支持PR、`main`推送及手动触发。
使用托管Ubuntu、workflow声明的Node/pnpm、固定action修订、只读权限、不保留凭据的检出。
无需供应商账号、自托管runner、本机代理、服务重启、部署或产物发布。

验证job执行冻结安装、安全、双语、API漂移、构建/类型检查、完整脚本及Web源码单测。
两条流水线还执行 `pnpm check:review`，拒绝漏文件、重复或过期的审查证据。
这是清单/证据门禁，不是语义批准；更严格的 `pnpm check:review:complete`
作为独立发布复审门禁。未完成的深审及未关闭的问题不能称为可公开发布。
12个独立后端分片通过已有隔离runner精确覆盖全部发现的 `*.test.ts`，关闭fail-fast，
避免一片失败掩盖其他结果。测试不读取操作者目录/密钥。原生/真实供应商和物理浏览器
交互不在该workflow范围内，不能记为通过。

源码检查后执行 `pnpm audit --prod --audit-level=high` 及
`pnpm audit --audit-level=high`，显式使用 `NODE_ENV=development`，覆盖构建/测试
依赖，避免继承生产模式而漏审。注册表报告的高危/严重告警阻止绿色 CI，
不等于已证明实际可利用。2026年11月22日定向修复
将生产依赖的35项告警降为0，包含开发依赖的审计也为0，本地高危门禁通过。
脚本全量测试同时检查已审查的依赖安全下限。实时注册表门禁继续保留；本地通过
不代表远端GitHub CI已运行，也不代表许可/产物声明及部署验收门槛已完成。

[可选GitLab测试镜像](../.gitlab-ci.yml) 在无专用标签的兼容runner上运行同样检查/测试；
不镜像私有上游历史、不部署。历史高级契约仅保留于
[`scripts/fixtures/gitlab-ci.json`](../scripts/fixtures/gitlab-ci.json)，用于CI工具回归，
不是活跃流水线。

## 本地等价命令

```sh
pnpm install --frozen-lockfile --prod=false
export NODE_ENV=development
pnpm check:security
pnpm check:i18n
pnpm check:api
pnpm check:review
pnpm --workspace-concurrency=1 -r build
pnpm --workspace-concurrency=1 -r typecheck
node scripts/run-script-tests.mjs
node scripts/run-source-tests.mjs web
pnpm audit --prod --audit-level=high
pnpm audit --audit-level=high
node scripts/github-source-tests.mjs 1 12
```

最后一条只执行**一个**分片；全部后端需运行1–12或
`node scripts/run-source-tests.mjs server`。输出公开前需审查意外敏感诊断。
远端验证需授权推送后实际完成GitHub jobs；有配置不等于远端已通过。

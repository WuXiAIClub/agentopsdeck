# Upstream ports and mirrors / 上游移植与双远端同步

## No inherited history

The initial AOD tree is an exported source snapshot, not a clone or an orphan
branch containing the old object database. The new `.git` starts with no commits,
tags, remotes or predecessor objects. Record the private source path/baseline in
ignored `.local/` or repository-local Git configuration, never in public docs.

Do not `merge`, mirror-push or force-push predecessor history into AOD. Even
cherry-picking normally retains the original author; use a reviewed patch port
followed by a fresh AOD commit for the requested initial maintainer identity.

## Selective code ports

`prepare-upstream-patch.mjs` exports one single-parent upstream commit's core
source diff. It normalizes the initial branding/config namespace adaptations,
excludes product-version and generated build metadata, and refuses obvious
credential/private content. It does not fetch objects, write source files,
contact a provider, commit or apply anything.

```sh
mkdir -p .local
node scripts/prepare-upstream-patch.mjs /absolute/path/to/private/source FULL_COMMIT_SHA > .local/upstream.patch
git apply --check .local/upstream.patch
git apply .local/upstream.patch
git diff --check
pnpm check:publication
```

If context conflicts, resolve intentionally in the existing AOD implementation.
Do not replace whole config/recovery files with upstream versions. Config defaults,
versioning, private-runtime boundaries and source sanitization must remain AOD-owned.
Version manifests, lockfiles, native installers and deployment scripts require
manual review; the helper deliberately does not auto-port them.

Run the relevant existing tests, review the final diff, then commit only when
authorized. Do not include `.local/upstream.patch` or operational receipts.
The helper is a conservative porting aid, not proof that an upstream fix is safe.

## GitHub and optional GitLab mirror

After redistribution-rights review and explicit repository/push authorization,
configure `origin` for the public GitHub
repository and an optional `gitlab` remote for the AOD source mirror. URLs must
contain no tokens; use existing credential helpers or SSH outside the repository.
No remote is configured by default.

Use normal fast-forward pushes of the **same reviewed commit** and selected AOD
tags to each destination. Never use `--mirror`, `--all`, force pushes, or publish
private upstream refs. Fetch and reconcile collaborators' work before pushing;
do not overwrite divergent branches. A mirror push is an explicit operation,
not an automatic hook.

The first commit and subsequent initial-release commits must use the repository
identity `WuXiAIClub <hi@wuxiaiclub.com>`. Keep the repository-local identity;
do not alter global Git settings or rewrite other repositories' authors.

Future local deployment should use an immutable checkout/archive at the exact
published AOD commit, with configuration/data mounted outside that checkout.
Record deployed commit + manifest separately in private operational evidence.
Local edits are source changes, not runtime configuration; test and commit them
before publishing/deploying. This preparation does not deploy an instance.

## 中文

从源码快照建立全新仓库，不携带旧 `.git`。上游改动通过定点补丁移植，审查、
测试后再用 AOD 身份创建新提交；不合并上游历史、不镜像推送全部引用。
工具只生成核心源码补丁，不自动应用，不移植产品版本、部署配置或原生安装包。
GitHub 和 GitLab 应推送同一个已审查提交；凭据由仓库外 Git helper/SSH 管理。
后续本机实例使用对应提交的不可变代码，运行配置和数据始终放在仓库外。

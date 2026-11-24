# Security / 安全

Setup and maintenance guidance: [installation](docs/installation.md) /
[安装](docs/installation.zh-CN.md), [operations](docs/operations.md) /
[运维](docs/operations.zh-CN.md).

This is a trusted-operator control plane, not a sandbox for untrusted users.
Native adapters and terminals may run tools with the operator's filesystem access.
Keep the default loopback binding. Before remote use, configure a fresh access
key, TLS, public URL/origin policy, trusted proxies and resource permissions.

Project contact: [AOD@wuxiaiclub.com](mailto:AOD@wuxiaiclub.com).
Confirm mailbox availability and a private reporting process before public launch;
do not send credentials or unredacted business data.

The [detailed source audit](docs/open-source-review-1.0.0.md) / [详细源码审查](docs/open-source-review-1.0.0.zh-CN.md)
currently blocks release. Clean dependency audits and source signature scans do
not resolve the documented authentication, native/media isolation and UI findings.

- AOD-owned settings use `AOD_*`; credentials from another instance must not be imported.
- Configured AOD roots select separate data, Codex/OpenClaw homes and workspace. Scoped media/native-launch isolation repairs have source-test evidence, not complete platform acceptance; follow the audit blockers. Never select another active instance's state.
- Native execution defaults to disabled. Enabling it requires separately provisioned credentials and trusted workspaces.
- `.env`, `.local/`, databases, runtime state, logs, private keys and release data are ignored. Ignore rules are not a substitute for review.
- `pnpm check:publication` checks files eligible for Git, product versions and known credential/private-path patterns, without printing matched values.
- `pnpm check:publication:release` additionally requires clean initial history/identity, license presence, complete current semantic review, closed findings, and source-bound rights/artifact/acceptance/release decisions. See [release blockers](docs/release-blockers.md).
- These checks are heuristic; they cannot prove absence of all secrets or business information. Review diffs before every push.
- Synthetic URL-userinfo rejection tests have an exact-file SHA-256 allowlist. Any change invalidates that exception and requires a fresh private review; real credential patterns are never exempted.
- Do not post credential files, full histories or unredacted requests in public issues. Private vulnerability reporting must be configured before public launch.

这是可信操作者的控制面，不是面向不可信用户的沙箱。默认仅监听本机，原生
执行默认关闭；远程访问需自行设置新密钥、TLS、来源策略和权限。
发布扫描只报告安全错误类别和文件路径，不打印匹配内容；扫描仍不能替代人工
审查。项目联系邮箱为 AOD@wuxiaiclub.com；公开上线前仍需确认邮箱可用并建立
私有漏洞报告流程，不要发送凭据或未脱敏的业务数据。

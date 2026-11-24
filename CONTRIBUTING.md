# Contributing / 贡献规范

See [development](docs/development.md) / [开发指南](docs/development.zh-CN.md)
for repository layout, exact test selectors and bilingual documentation checks.

- Use the existing Hub, Connector and web architecture; do not introduce a parallel menu, queue or recovery system.
- Keep product version independent of wire protocol and third-party channel versions.
- Add English UI source strings and matching Simplified Chinese translations; run `pnpm check:i18n`.
- Use the existing source/script test runners. Document targeted versus full-suite validation honestly.
- Never commit native homes, provider configuration, access keys, tokens, database state, business histories or local deployment receipts.
- Put local overrides in ignored `.env` / `.local/`, or an explicit external `AOD_CONFIG_FILE`.
- Preserve execution identities and `outcome_unknown` protections. A timeout is not proof of termination; recovery must not duplicate execution.
- No direct host-service stop/restart from a hosted agent session. Future deployment requires separately reviewed, independent maintenance.
- Preserve native keyboard, focus, touch and accessibility behavior when changing UI. Reuse safe-polygon/menu-aim capabilities if present; do not add blanket hover delays.
- Do not push, deploy, force-push, merge upstream history or alter unrelated worktrees without explicit authorization.

The initial maintainer identity is `WuXiAIClub <hi@wuxiaiclub.com>`, configured
only in this repository. Future external contributors must use their own truthful
identities; do not impersonate them. The initial release commits must use the
requested identity, and the publication gate checks that release history.

## Contribution licensing / 贡献许可

Unless explicitly stated otherwise, contributions intentionally submitted for
inclusion in AgentOpsDeck are provided under Apache-2.0, as described in
Section 5 of [LICENSE](LICENSE). Submit only code you have the right to contribute.
Preserve third-party copyright, license and attribution notices; do not relicense
third-party material merely by copying it into this repository.

除明确另有声明外，有意提交给 AgentOpsDeck 的贡献按 [LICENSE](LICENSE)
第 5 条采用 Apache-2.0。仅提交有权贡献的代码，保留第三方版权、许可证和署名。

沿用现有架构、双语机制和测试方式。私有配置放在忽略目录或仓库外，不入库。
恢复逻辑必须保留执行身份和结果未知保护，超时不能当作停止证明。
涉及部署需另行授权；不得从宿主会话内直接停启宿主服务。提交身份只在当前
仓库设置；不可篡改第三方贡献者的身份或版权声明。

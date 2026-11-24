# AgentOpsDeck development

- Read README.md, SECURITY.md and docs/upstream-sync.md before changing release/config boundaries.
- Use the existing application architecture and test runners. Keep English and Simplified Chinese translations aligned.
- Keep public setup/usage guides paired in English and Simplified Chinese, update docs navigation, and run scripts/documentation.test.mjs through the existing script runner after documentation changes.
- AOD-owned configuration uses AOD_* and separate runtime directories. Never import another instance's settings or credentials.
- All publishable package names, protocol headers, native identifiers and examples use the AOD brand. Keep legacy branding only in privately supplied upstream inputs; normalization and publication tests must reject reintroduction.
- GitHub-hosted CI tests source without deployment, credentials or self-hosted runners. Add regression tests for security, i18n and API documentation changes.
- Do not copy or merge upstream Git history. Reviewed code patches must not overwrite AOD versions/isolation.
- Do not commit, push, deploy or create release tags without explicit authorization. Never force-push without separate authorization.
- Initial release identity: WuXiAIClub <hi@wuxiaiclub.com>, repository-local only; do not rewrite third-party attribution.
- AOD-owned code uses Apache-2.0; preserve third-party licenses and attribution. Public release still requires inherited-source rights and artifact-notice review.
- Do not print credentials or business histories. Check eligible source with pnpm check:publication; public release additionally needs pnpm check:publication:release and explicit authorization.
- No direct restart of a service hosting the current agent session. No active private database access or unknown-outcome replay.
- Keep keyboard, focus, touch and accessibility behavior; reuse existing menu-aim support rather than adding parallel menu systems.
- Follow docs/open-source-review-standard.md for publication review. Record exact file hashes, review depth, findings and verification gaps in docs/review/file-review.json; structural coverage is not semantic approval.
- Run pnpm check:review after changing eligible source. Publication additionally requires pnpm check:review:complete, resolved security findings, rights/notice review and explicit authorization; an evidence-valid draft is not release approval.

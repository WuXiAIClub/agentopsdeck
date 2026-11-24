# License status / 许可状态

Apache-2.0 was selected on November 22, 2026 for AgentOpsDeck-owned code.
The unmodified license text is in [LICENSE](LICENSE). Third-party code and assets
remain subject to their own licenses and notices; this selection does not
relicense them. See [the dependency and upstream licensing review](docs/licensing-review.md)
for remaining distribution checks.

Publication is pending confirmation that the
maintainer has permission to redistribute the inherited source and assets.
No license file was found in the extracted baseline. Selecting Apache-2.0 does
not establish ownership of inherited code or resolve third-party obligations.
This status document is not the license text or a rights approval.

Rights, final-artifact attribution, acceptance and explicit publication decisions
remain pending in [the source-bound release record](docs/review/release-approval.json).
The [release blocker workflow](docs/release-blockers.md) explains the enforced gate;
neither a license file nor passing tests can automatically approve those decisions.

The configured Git author (`WuXiAIClub <hi@wuxiaiclub.com>`) identifies new commits;
it does not transfer copyright in inherited code or third-party dependencies.
Keep dependency license notices in generated artifacts. Do not rewrite historical
copyright notices or claim that third-party code belongs to the new maintainer.

2026 年 11 月 22 日已选择 Apache-2.0 用于 AgentOpsDeck 自有代码，正文见
[LICENSE](LICENSE)。第三方代码和资源仍遵守各自许可证及声明，不被重新授权。
公开发布前仍需确认有权分发继承的代码和资源，并完成第三方发行物审核。
基线未发现许可证文件；本状态文档不是许可证正文或权利确认。
Git 提交身份不等于版权归属。依赖的许可声明必须保留。
权属、发行物声明、验收及发布授权仍在[绑定源码的决策记录](docs/review/release-approval.json)
中保持待定；门禁流程见[发布阻断](docs/release-blockers.zh-CN.md)，不得由许可证存在
或测试通过自动批准。

After rights and artifact-notice review, run `pnpm check:publication:release`
before publishing. License-file presence alone does not establish legal compliance
or a complete native release. No commit, push or deployment is authorized by
the license selection.

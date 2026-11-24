# Licensing review / 许可证调查

Reviewed on November 22, 2026. This is an engineering compliance inventory,
not legal advice, a redistribution approval, a LICENSE or final third-party notices.
Following this review, Apache-2.0 was selected and applied to AOD-owned code on
November 22, 2026; see [LICENSE](../LICENSE). This does not establish inherited-source
rights or replace third-party licenses and artifact notices.

## Scope and evidence

### November 23 follow-up: not an artifact clearance

The tables below retain the November 22 pre-remediation snapshot; they are not
the current lockfile inventory. A fresh recursive **production** dependency graph
has **281 distinct readable installed external name/version pairs**: MIT 259,
ISC 9, Apache-2.0 5, MPL-2.0 3, BSD-3-Clause 2, 0BSD 2 and CC-BY-4.0 1.
There are **94 distinct unresolved installation paths**, including uninstalled
platform variants; repeated graph occurrences are not package counts. Stale
directories left in the package store were excluded by following the active graph.

Current resolved metadata includes Hono 4.13.20, its Node adapter 2.1.11,
SimpleWebAuthn server 13.3.3, Vite 6.4.6, and caniuse-lite 1.0.30001826.
These are metadata observations, not complete license-text, bundled-component,
cross-platform SBOM or final NOTICE review. No redistribution permission was
inferred. [Release decisions](review/release-approval.json) remain pending; the
[workflow](release-blockers.md) requires exact-source evidence and human approval.

11 月 23 日跟进：下表保留修复依赖前的历史快照，不代表当前锁文件。按当前工作区
递归生产依赖图核对得到 281 个可读外部包／版本组合（MIT 259、ISC 9、Apache-2.0 5、
MPL-2.0 3、BSD-3-Clause 2、0BSD 2、CC-BY-4.0 1）；另有 94 个不可读安装路径组合，
包含未安装的平台变体。已排除包缓存中遗留的旧版本，重复依赖图节点不当作不同包。
这不是完整许可证正文、嵌套组件、跨平台 SBOM 或最终 NOTICE 审核，不推断任何
分发权利。[发布决策](review/release-approval.json)仍待定，见[阻断流程](release-blockers.zh-CN.md)。

- Read the root, server, web and shared manifests and the source lockfile.
- The lockfile contains 376 package records. The current Linux installation contains
  283 distinct external name/version pairs with readable package manifests.
- Installed package metadata declares: MIT 260, ISC 9, Apache-2.0 6,
  MPL-2.0 3, BSD-3-Clause 2, 0BSD 2 and CC-BY-4.0 1.
- These are installed-package counts, not dependency-graph occurrence counts or
  a complete cross-platform SBOM. Platform variants and uninstalled optional
  packages still require review. Top-level metadata cannot identify every
  bundled component or replace reading full license/NOTICE texts.
- Inspected representative installed licenses, Lucide's Feather attribution,
  Playwright NOTICE, node-pty's bundled winpty license, Gradle wrapper headers
  and the icon generator's font provenance.
- Upstream repository/default-branch information below is supplementary; release
  artifacts must be audited against the exact versions actually distributed.
  Direct raw-file retrieval failed for several optional runtimes; do not treat
  repository license information as an exact-version runtime release audit.
- The pre-license extraction had no inherited LICENSE/NOTICE/COPYING evidence.
  The current AOD-owned Apache-2.0 LICENSE does not establish inherited-source
  redistribution rights. Confirm source and asset ownership separately.

### Selected installed license-file evidence (November 23, 2026)

The [selected byte inventory](review/third-party-license-inventory.json) records
top-level LICENSE/NOTICE files for eight installed package/version pairs:
Playwright core, node-pty, class-variance-authority, Lucide, caniuse-lite and
three Lightning CSS packages. Package-relative paths, sizes and SHA-256 values
identify those files without exposing installation paths or private settings.
This is inventory evidence, not a completed license-text interpretation or
redistribution approval. Embedded notices such as bundled winpty, development-only
dependencies, absent optional packages, browser binaries, fonts, native resources
and container OS packages remain outside this selected evidence. No final NOTICE
or source-offer compliance is asserted.

## Core source-instance dependencies (historical snapshot)

Versions below come from the November 22 historical installation and lockfile, not a promise
that upstream's latest version has the same terms.

| Component | Version(s) inspected | Declared license |
| --- | --- | --- |
| React / React DOM | 19.2.7 | MIT |
| Hono / Node adapter | 4.12.25 / 1.19.14 | MIT |
| SimpleWebAuthn browser / server | 13.3.0 / 13.3.1 | MIT |
| Tiptap core and included open-source extensions / ProseMirror packages | 3.31.3 for Tiptap | MIT; commercial Tiptap products are not covered by this conclusion |
| xterm / fit addon | 6.0.0 / 0.11.0 | MIT |
| node-pty / bundled winpty | 1.1.0 / bundled source | MIT; retain both authors' notices |
| ws / direct nanoid | 8.21.0 / 5.1.11 | MIT |
| marked / react-markdown / remark-gfm | 17.0.6 / 10.1.0 / 4.0.1 | MIT |
| Tailwind / Vite | 4.3.1 / 6.4.3 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| Playwright core | 1.63.0 | Apache-2.0; also retain NOTICE and review bundled third-party notices |
| TypeScript | 5.9.3 | Apache-2.0; build tool with its own third-party notices |
| Lucide React | 1.21.0 | ISC plus MIT attribution for Feather-derived icons |
| qrcode.react | 4.2.0 | ISC |
| Lightning CSS and installed Linux native variants | 1.32.0 | MPL-2.0 |
| caniuse-lite | 1.0.30001799 | CC-BY-4.0 browser-support data |

## External agents and services

These are operator-provisioned integrations, not mandatory bundled AOD npm
dependencies. Calling a service is different from redistributing its SDK,
runtime, model weights or enterprise source.

- OpenAI Codex CLI: upstream Apache-2.0. Provider/service access has separate terms.
- OpenClaw: upstream MIT; separately review its dependencies if it is bundled.
- Hermes Agent: upstream MIT; separately review Python dependencies if bundled.
- LiteLLM: MIT outside the enterprise exception. The fetched root LICENSE explicitly
  excludes `litellm/enterprise/`, which has separate terms. Do not label the entire
  repository MIT or redistribute enterprise features without reviewing those terms.
- Claude Code and GitHub Copilot CLI: official proprietary/service licensing;
  a public repository or integration capability is not a grant to relicense them.
  Prefer user-installed adapters; do not include credentials or paid runtimes.

## Assets, native wrappers and images

- Preserve the Apache-2.0 headers on generated Gradle wrapper scripts. AndroidX
  and native release dependencies need an exact-artifact notice audit before shipping.
- AOD raster icons use DejaVu Sans. Its Bitstream Vera-derived font license and
  public-domain DejaVu modifications are distinct from the application's license.
  Rendering text into an image is not the same as redistributing a font file.
  Review font obligations if fonts or generation tools are packaged. Debian
  packaging GPL notices do not by themselves make the font or AOD GPL.
- The current Dockerfile copies the full build workspace, including development
  dependencies, into a Debian-based image. It is not runtime-minimized and has
  not been built/audited. Shipping it requires Node/base-OS/package notices and
  any applicable corresponding-source compliance, not just an AOD LICENSE.
- Browser binaries, media components, Windows resources, native installers and
  optional editor distributions are not cleared by this JavaScript inventory.

## Recommendation

Use **Apache-2.0 for AOD-owned code**, subject to ownership approval. It permits
commercial use and closed-source redistribution while making contributor patent
grants and patent-litigation termination explicit. Preserve third-party licenses
separately; Apache-2.0 does not relicense MIT, ISC, MPL or data dependencies.

MIT is a simpler permissive alternative, with no equivalent explicit patent grant
in its short text. Neither option requires downstream proprietary changes to be
published. If reciprocal publication is a product requirement, evaluate GPL/AGPL
instead; AGPL additionally addresses modified software used over a network.

MPL-2.0 applies copyleft to covered files, not automatically to the entire larger
work. When distributing Lightning CSS binaries, provide compliant access to the
covered source and notices. Its presence as a build tool does not automatically
make generated CSS or AOD MPL. CC-BY-4.0 data needs attribution when shared.

Before publication:

1. Confirm AgentOpsDeck/source/asset redistribution rights and the actual rights holder.
2. Apache-2.0 text is now present; confirm its scope and actual rights holders
   without inventing copyright ownership or removing existing notices.
3. Produce exact-version third-party notices/SBOM for source, web bundles and images
   separately, including embedded licenses and applicable MPL/OS source offers.
4. Preserve third-party provenance when porting changes. New Git history or an
   account-level commit identity does not transfer other contributors' rights.
5. Keep private configuration/credentials outside published artifacts and test
   notice retention in the final release, not just this development checkout.

## Primary sources

- [MIT text (OSI)](https://opensource.org/license/MIT)
- [Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0)
- [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [GNU AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html)
- [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
- [Codex repository](https://github.com/openai/codex)
- [OpenClaw repository](https://github.com/openclaw/openclaw)
- [Hermes repository](https://github.com/NousResearch/hermes-agent)
- [LiteLLM root license](https://github.com/BerriAI/litellm/blob/main/LICENSE)
- [Lucide license](https://lucide.dev/license)
- [Lightning CSS repository](https://github.com/parcel-bundler/lightningcss)
- [DejaVu license](https://dejavu-fonts.github.io/License.html)
- [Claude Code license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)
- [Copilot CLI repository](https://github.com/github/copilot-cli)

## 中文摘要

建议 AOD 自有代码采用 Apache-2.0：允许商用和闭源二次开发，并明确贡献者的
专利授权及相关终止条款。MIT 更简洁；两者都不要求使用者公开自己的改动。
若目标是要求修改版持续开放，需另行评估 GPL/AGPL，而非添加“禁止商用”等限制。

本地 283 个已安装外部包并非全部 MIT：Lightning CSS 为 MPL-2.0，caniuse-lite
为 CC-BY-4.0，Lucide 还包含 Feather 的 MIT 署名。它们不强迫整个 AOD 使用同一
许可证，但发行时必须按各自范围履行声明、署名和必要的源码可用义务。

Codex 为 Apache-2.0，OpenClaw/Hermes 为 MIT；LiteLLM 的 enterprise 目录有
单独条款。Claude Code/Copilot 等付费运行时与服务不能随 AOD 重新授权。
这些是可选外部集成，不等于已被打包进 AOD 的必要组件。

尚未完成 376 条锁文件记录的跨平台审核、完整嵌套组件审核、Docker/原生发行物
审计或法律确权。AgentOpsDeck 缺少许可证不代表禁止其所有者自行授权，也不代表
任意贡献者都有分发权。调查后已按维护者选择添加 Apache-2.0 正文，用于 AOD
自有代码。首次公开发布前仍需确认权利，并生成第三方声明与分发物清单。
本次许可选择未执行提交、推送或部署。

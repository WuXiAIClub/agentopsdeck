# AgentOpsDeck 1.0.0 extraction / 提取范围

- Baseline: a predecessor source-only snapshot, not the live private instance's state; provenance stays outside public source.
- Included: tracked application/shared/native/tooling source, lockfile and existing CI contracts.
- Excluded: old Git history/refs, dependencies/build output, operational docs and receipts, screenshots/evidence archives, local configuration and credentials.
- Retained documentation: the synthetic browser inventory required by the existing test runner; new public-facing bilingual guides replace operational history.
- Adaptations: AgentOpsDeck branding; core version 1.0.0; AOD app environment namespace; separate data/native-home defaults; loopback development ports; synthetic private path/domain replacements.
- Compatibility: `@agentopsdeck/*`, the product-version compatibility export and existing API protocol identifiers remain intentional implementation details.
- Native source scaffolds and optional adapters are not a claim of full Windows, Android, iOS or provider acceptance.
- Public distribution: Apache-2.0 selected for AOD-owned code; inherited-source rights and artifact-notice review remain pending. Account authentication and GitHub push are deferred.
- PWA raster icons are generated locally by `python3 scripts/generate-app-icons.py` with optional Pillow and DejaVu Sans tooling; they are not private screenshots.
- Reverse-connect/sandbox blueprints need an operator-provided executable; no nonexistent npm Connector package is advertised as an installation path.
- Public documentation: paired English/Simplified Chinese installation, user, configuration, integration, operations, troubleshooting and developer guides; start at [documentation](README.md) / [文档导航](README.zh-CN.md).

Do not label new-session smoke tests, offline fixtures or health checks as proof
that original private failed sessions have been repaired. Production safety and
unknown-outcome protections are inherited unchanged by this extraction.

这次提取只处理代码，不操作现有服务、不复制线上数据库、不移植业务历史。
自有代码已选择 Apache-2.0；首次公开发布仍需确认分发权与第三方合规。
测试范围需逐项记录，不能将离线验证等同于
生产或故障旧会话验收。

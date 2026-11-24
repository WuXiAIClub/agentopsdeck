# Local validation / 本地验证

Recorded on November 22, 2026 for the uncommitted AgentOpsDeck 1.0.0 source draft.
This is not a GitHub release, remote CI result or production acceptance report.

## Pending-file review checkpoint (November 22, 2026)

This round continues the previously reported **255 pending** files, including
source changes that invalidated earlier reviews and expanded the next baseline
to **445 pending-depth records**. Exact-byte module reports retain full-file
reading evidence and relevant caller contracts; scans and passing tests alone
never promote a file to semantic review.

Of the expanded 445-record baseline, **436 now have semantic evidence,
5 remain pending, and 4 generated/lock inventories remain structural**.
Generated inventories and lockfile review are not full semantic source approval;
the overall structural inventory outside that baseline is still not fully reviewed.

The remaining external-contract blockers are `scripts/verify-hermes-contract.py`
(the supplied gateway implementation) and `scripts/verify-original-application-upgrade.mjs`
(the specified historical 2.3.7 baseline). Their complete AOD source was read,
but the required external implementations were unavailable; current 2.5.0 source
cannot substitute for that historical baseline. These entries remain pending.

The integration checkpoint before this report's final evidence rerecording covers
**3555 files**: **825 semantic, 2718 structural,
5 pending and 7 asset**. Changed-file evidence and the final current
counts are checked by `pnpm check:review`; these documentation checkpoint numbers
are not a recursive claim that the reports have already been rerecorded.
The registry has **135 records: 75 targeted-source-verified and
60 unresolved source/coverage/acceptance records**. Records can overlap and include
verification gaps; these are not counts of independent confirmed vulnerabilities.

Additional scoped fixes include original maintenance/execution response-body
drain ownership, fail-closed process stop proof, private native launch environments,
captured model/history roots, successful Gateway diagnostic projection, notebook
capability and CSS namespaces, browser UID admission, bounded structural telemetry,
strict TAP evidence parsing and redacted public failure receipts. None turns an
elapsed timeout into stop proof or replays protected unknown-outcome work.

Final current local regression: **Web 1350/1350 and scripts 623/623**, zero
failures/cancellations/skips; shared/server/web builds, bundle budgets and all
three package typechecks pass. Targeted selections overlap: notebook namespace
71/71 plus persistence 112/112, original Hub drain 60/60, stop-proof 49/49,
Connector projection/owner 132/132, current-key binding 12/12, local Hub 12/12,
and independent browser/telemetry/TAP/receipt verification 6/6. Do not add these
to the full-suite totals or claim full-backend acceptance.
The additional 19 previously structural script test files now have full-file and
bounded direct-contract review; their two actual selections pass **14/14 and 103/103**.
Documentation/security/review/API/dependency regression selection passes **34/34**.
These selections overlap the full script suite and are not additional whole-project coverage.

Open issues include nested filesystem confinement and input budgets, private
configuration replacement permissions, operator-script diagnostics/resources,
native queue/download/lifecycle guarantees, pending source contracts and final
redistribution/artifact rights. The dated production/all-dependency advisory
snapshots remain zero at every severity (379/382 reported dependencies), not a
zero-risk or latest-version guarantee. Real browser/touch/accessibility, native
devices, providers, complete backend, containers and GitHub CI remain unaccepted.
`check:review:complete` and public release remain blocked; no commit, push, tag,
deployment, business-history replay or production maintenance occurs in this round.

### 待审文件检查点（2026年11月22日）

本轮继续此前报告的**255个待审文件**，同时纳入修复导致原审查失效的源码，
后续基线扩大为**445条pending深度记录**。分模块逐文件证据包含完整阅读与相关
调用契约；扫描、哈希或测试通过不能单独提升为semantic。

扩大后的445条基线中，**436条已有semantic证据、5条仍待审、
4条生成清单／锁文件保持structural**。生成清单与锁文件不冒充完整源码
语义批准；该基线以外的structural库存也仍未全量语义审查。

外部契约阻断为`scripts/verify-hermes-contract.py`（所指定的外部网关实现）及
`scripts/verify-original-application-upgrade.mjs`（所指定的历史2.3.7基线）。
两者AOD源码已完整阅读，但所需外部实现不可用，当前2.5.0源码不能替代历史
基线，因此保留pending，不用测试通过冒充契约审查完成。

本报告最终证据重记前的集成快照覆盖**3555文件**：**semantic 825、
structural 2718、pending 5、asset 7**。
最终当前数量和变更文件证据由`pnpm check:review`核对；文档快照不是递归宣称
报告本身已重记。注册表共**135条：75条定向源码验证，60条源码／覆盖／验收
未闭环记录**。记录可能重叠且包含证据缺口，不等于独立已确认漏洞数量。

新增定向修复覆盖维护／执行原始响应体物理排空、停止证明错误时封闭、原生私有
执行环境、捕获的模型／历史根、成功Gateway诊断投影、笔记能力与CSS命名空间、
浏览器UID准入、有界结构遥测、严格TAP证据解析及公开失败回执脱敏。
没有把超时当停止证明，也没有重放受保护的结果未知工作。

当前最终本地回归：**Web 1350/1350、脚本623/623**，失败／取消／跳过均为0；
shared/server/web构建、产物预算与三包类型检查通过。定向选择存在重叠：笔记
命名71/71及持久化112/112、Hub原始排空60/60、停止证明49/49、Connector投影／
owner132/132、当前key绑定12/12、本地Hub12/12、独立浏览器／遥测／TAP／回执6/6。
不能与全量结果相加，也不能据此宣称完整后端验收。
额外补齐19个此前仅structural的脚本测试文件，完整阅读及有界直接契约审查后，
两组实际测试**14/14、103/103**通过；文档／安全／审查／API／依赖回归选择
**34/34**通过。这些选择与全量脚本重叠，不增加整项目验收覆盖。

未闭环风险包括嵌套路径物理约束及输入预算、私有配置替换权限、运维脚本诊断／
资源、原生队列／下载／生命周期、待审调用契约与最终分发／产物权利。
生产／全部依赖有日期的告警快照各级仍为0（报告依赖379/382），不等于零风险或
所有最新版。真实浏览器／触控／辅助技术、原生实机、供应商、完整后端、容器及
GitHub CI未验收；`check:review:complete`及公开发布仍阻断。本轮未提交、推送、
打tag、部署、业务历史重放或生产维护。

## Earlier scoped source repairs (November 22, 2026)

This historical checkpoint superseded the older source snapshots below without
rewriting their results; the pending-file review checkpoint supersedes it in turn.
The earlier 53-record scoped subset had
46 targeted-verified records (including earlier repairs) and 7 partial or
acceptance-pending records. No whole-file or release approval is inferred.

- Full web source runner: **1,316/1,316 passed**, no failures, cancellations or skips.
  Full script runner: **560/560 passed**, no failures, cancellations or skips.
  Commands: `node scripts/run-source-tests.mjs web` and
  `node scripts/run-script-tests.mjs`.
- Shared build passed; final `pnpm --filter @agentopsdeck/server build` and
  `pnpm --filter @agentopsdeck/web build` passed, including bundle budgets.
  `pnpm --workspace-concurrency=1 -r typecheck` passed for all three packages.
  An earlier combined build found optional-root integration errors; required
  immutable roots and conditional compatibility options resolved those errors.
- API/auth scoped runs: **148/148**, voice policy **16/16**, adjacent current-key
  contracts **94/94**, final config/file-wrapper/credential integration **44/44**.
  Main system/admin diagnostics selection: **69/69**. Successful structured
  Gateway details remain separately unreviewed; AUTH-004 stays partial.
- Connector/Hub final contracts **221/221**, namespace/auth **28/28**, website
  **18/18**, adjacent **63/63**. Execution scoped **37/37** and protection
  regressions **162/162**. The four dispatch-process assertions passed in both
  original and independent environments; an earlier wide-batch timeout cause
  remains unproved. These selections overlap and are not additive full coverage.
- Storage scoped runs: **73 passed / 1 Windows-only skip**. Web-state scoped
  **114/114** and UI scoped **103/103** are covered by the final full web run.
  Docs/native/module/provision selection **26/26** is covered by the script run.
  Native reviewers also ran **14/14** existing offline JavaScript routing tests.
  Native download regressions are source assertions, not Java/Swift execution.
- The bounded exact async-Codex sidecar completed **50 passing top-level cases**,
  including the eight failures seen in an earlier broad run, but exited **124**
  at 175 seconds without final TAP totals. It is not a complete-file pass. The
  earlier failures localize to post-save token reply processing; the exact
  historical rejected field and pre-change baseline are not established. No
  unknown-outcome retry, production token replay or storage-guard relaxation occurred.
- `pnpm audit --audit-level=high --json` exited zero: **0 at every severity**,
  379 reported dependencies. This is a dated advisory snapshot, not zero risk.
  `check:publication`, `check:i18n`, `check:api` and `check:review` passed.
  Publication scanned 3,547 files; the ledger covers 3,546, excluding only itself.
  Current depths after documentation rerecording: semantic 343, structural 2,751,
  pending 445, asset 7.
- `check:review:complete` deliberately exits **1**: full semantic approval,
  seven finding/acceptance gaps, rights and artifact acceptance remain open.
  OpenAPI 3.1 is a static inventory: 482 registrations, 326 paths, 137 unresolved
  registrations. Catalog guards do not approve 395 dynamic translation calls.

中文：本次源码修复检查点取代下文旧快照，但保留历史结果。53条注册记录中46条
已有定向验证（包含此前修复），7条部分修复／待验收；不等于整文件批准。
Web全量1316/1316、脚本全量560/560、三包构建与类型检查通过；API/auth定向148、
voice16、相邻94、配置／文件包装／凭证44、主集成诊断69，Connector/Hub合同221、
命名28、website18、相邻63，执行37及保护回归162通过。Storage73通过／Windows跳过1，
Web状态114和UI103、文档／原生／模块／令牌26、原生离线路由14通过。统计有重叠，
不能相加宣称独立全量。async-Codex有界sidecar完成50个通过用例（含原8项失败），
175秒超时退出124、无完整TAP总数，不能宣称整文件或完整后端通过；历史具体拒绝字段
及是否早于并行变更未证明，未重放结果未知操作。依赖各级告警0；publication、i18n、
API、review一致性通过。文档重记后台账3546文件：semantic343、structural2751、pending445、
asset7；严格全审按设计退出1。原生实机、浏览器／麦克风／触控／辅助技术、真实供应商、
完整后端、容器、远端CI、最终产物与分发权仍未验收。未提交、推送、打tag或部署。

## Latest dependency remediation (November 22, 2026)

This section supersedes the dependency blocker in the initial audit below.
It does not turn that earlier report into full-backend or release acceptance.

- The initial **35 production advisories (8 high / 23 moderate / 4 low)** are
  now **0 at every severity**, using the remediated lockfile. Both
  `pnpm audit --prod --json` and `NODE_ENV=development pnpm audit --json` exited
  zero. The unchanged CI command `pnpm audit --prod --audit-level=high` passed.
  These are registry snapshots on the recorded date, not a zero-risk guarantee.
- Targeted updates cover nine affected package families; exact old/new versions
  are in the [English](security-review.md) and [Chinese](security-review.zh-CN.md)
  security records. Six parent-scoped compatible transitive constraints replace
  vulnerable resolutions without an audit exemption. Nano ID 3.x and 5.x remain
  separate; the Node adapter is the only direct major upgrade. Product versions
  remain **AgentOpsDeck 1.0.0**.
- Frozen all-dependency installation, complete shared/server/web build, web
  bundle budgets and full workspace typecheck passed with the new lockfile.
- Full web source tests: **175 files, 1,256 passed, 0 failed/skipped**.
- Full script tests: **82 files, 525 passed, 0 failed/skipped**. Four new offline
  dependency regressions check every affected resolution, old-version rejection,
  reviewed majors, manifest floors and scoped constraints. Final documentation,
  dependency/security, publication and CI regressions: **23 passed**.
- Targeted backend tests: **32 of 1,157 files, 467 passed, 0 failed/skipped**.
  Coverage includes HTTP body/auth/rate limits, passkeys and their storage,
  authority/file/media boundaries, existing sockets, lifecycle/request drain,
  async ownership, file binding reconciliation and static bundles. The final
  adapter/bundle rerun passed **7 tests in 2 files** after test cleanup refinements.
  This is not a full local backend run.
- New real HTTP/1.1 loopback tests verify raw backslashes cannot be rewritten
  into protected routes; encoded/malformed static requests do not bypass prefix
  authorization; normal GET/HEAD, Unicode/spaced filenames, JSON/cookies and
  streaming work. An initial build caught the adapter's HTTP/HTTP2 server union
  in the test cleanup helper; narrowing it to HTTP before closing connections
  fixed the type error. Build and typecheck were rerun successfully afterward.
- Fresh compiled disposable instance: health **200/ok**, HTML **200/no-store**,
  entry JavaScript HEAD **200/immutable**, unauthenticated Hub **401**, graceful
  SIGTERM exit **0**. Private temporary HOME/config/data were used, adapters were
  disabled and state was removed. Only that owned child was stopped.
- Publication/security scan passed **3,501 eligible files**. Existing i18n
  guards and API inventory drift gate passed; no application route or UI copy
  change was necessary for the dependency remediation.

### Boundaries still unverified

Full local backend execution, actual Windows/macOS filesystem behavior, HTTP/2,
malformed WebSocket upgrade/reverse-proxy combinations, remote TLS, real browser
keyboard/touch/accessibility, provider/native integrations, Docker, penetration
testing and remote GitHub/GitLab CI remain unverified. Existing source socket
tests are not proof of all live proxy transports. No operator credentials,
production services, historical tasks or unknown outcomes were accessed/replayed.
No commit, push, tag or deployment was performed. Inherited-source rights and
artifact/third-party notices remain independent public-release gates.

### 最新中文摘要

定向修复9类依赖，生产依赖35项告警（高危8）降为所有级别0项；包含开发依赖的
审计也为0，原有CI高危门禁通过。保留Nano ID 3.x/5.x边界，只对Node适配器直接
跨主版本升级，没有压制告警，AOD仍为1.0.0。冻结安装、完整构建/类型检查/产物预算、
前端全量1256项、脚本全量525项、后端定向32文件467项、最终安全/文档23项及
适配器/网页7项复核通过。新回归覆盖路径绕过、认证、GET/HEAD、中文/空格文件、
JSON/cookie/流式响应；隔离编译实例健康/HTML/JS/匿名Hub拒绝/正常关闭通过。
源码3501文件隐私门禁、i18n及API门禁通过。首次新增测试类型错误已修正并重跑。
完整后端、真实Windows/HTTP2/代理/浏览器/供应商/原生/容器/远端CI仍未验收；
许可权利与产物声明门槛不因告警清零而免除。未提交、推送或部署，不影响生产。

## Initial open-source audit (before dependency remediation)

This section supersedes the earlier checkpoints below. All operations used the
AOD source draft and disposable test state, not any production instance.

### Passed source checks

- Frozen dependency installation; shared/web/server builds, web bundle budget and
  all workspace typechecks passed after namespace cleanup.
- Full web source suite: **175/175 files, 1,256 tests passed**.
- Targeted backend source suite: **18/1,156 files, 292 tests passed**. Coverage:
  config/version/portability, authentication and request authority, auth limiting
  and persistence, issuer/file-binding reconciliation, async standalone/Connector
  boundaries, request draining, history transport and built web assets. This is
  explicitly not the full backend suite.
- Full script suite: **81/81 files, 521 tests passed**. The suite covers security,
  publication, GitHub sharding, docs, i18n catalog, API drift, private-config
  creation, source-only upstream ports and inherited isolated utility fixtures.
- Eligible-source publication/security scan: **3,499 files passed**, version
  1.0.0, LICENSE present, no initial commit. The gate scans binary bytes and
  rejects source links, credential signatures, legacy branding and fixed runtime
  workstation/LAN defaults. Synthetic environment fixtures do not exempt keys.
- i18n: static JSX guard **155 files**; catalog guard **366 files, 3,699 entries,
  3,256 literal calls** passed. **394 dynamic calls** are counted, not exhaustively
  verified. Catalog duplicates, empty strings and interpolation mismatches fail CI.
- API source inventory: **481 static registrations, 325 templated paths**;
  **137 unresolved registrations** remain explicit. Determinism, source links,
  lexical shadowing, literal loops and equivalent-path canonicalization passed.
  No complete request/response/auth schema or external OpenAPI validator is claimed.
- Fresh compiled disposable loopback instance: startup, health, built HTML,
  unauthenticated Hub rejection (401) and graceful shutdown passed. Adapters were
  disabled; only that owned child was stopped and temporary state removed.
- Main README is English; Chinese README and **13 paired guide families** cover
  setup, configuration, usage, integrations, operations, troubleshooting,
  development, upstream ports, modules, API, security, i18n and CI. The module map
  links all 20 top-level backend directories plus application/shared/web/native
  and tooling boundaries; documentation tests verify local links and navigation.
- GitHub workflow is hosted, read-only and test-focused; 12 backend shards cover
  every discovered source test exactly once. Optional GitLab mirror needs no
  private runner tags or proxy. Neither performs deployment or release upload.

### Initial dependency blocker (resolved above)

`pnpm audit --prod --json` reported **35 advisories: 8 high, 23 moderate, 4 low,
0 critical**. Counts are registry advisories, not proof of equivalent runtime
exploitability. The impacted package list and remediation boundary are recorded
in both [security guides](security-review.md). No advisories were suppressed and
no blind cross-version dependency upgrades were performed. CI runs
`pnpm audit --prod --audit-level=high` after source tests: **this draft cannot have
green release CI until the high/critical dependency findings are resolved**.
This was the pre-remediation result; the latest section records its resolution.

Apache-2.0 is selected for AOD-owned code; inherited-source redistribution rights
and artifact/third-party attribution remain independent release gates. Secret
signature scanning is heuristic and cannot prove absence of every private value.

### Corrections and unverified boundaries

Earlier namespace validation found duplicate renamed exports/imports; API scope
fixtures caught dynamic-loop shadowing and templated-path alias conflicts. Those
issues were fixed and rerun successfully; failed initial attempts are not counted.
A mistyped backend selector was rejected rather than silently running no tests.

Full backend local execution, real browser keyboard/touch/accessibility, dynamic
i18n copy, provider calls, native installers, Docker, multi-host/TLS and the
optional browser-stream runtime remain unverified. GitHub/GitLab remote CI has
not executed. No commit, push, tag, production deployment or private history replay.
The repository has zero inherited commits/refs/remotes; settings/provenance remain
private ignored files, not part of the eligible public source.

### 最新中文摘要

三包构建/类型检查、前端全量1256项、后端定向292项、脚本全量521项及隔离启动/
健康/网页/匿名Hub拒绝/正常关闭通过。源码3499文件隐私门禁通过；双语目录3699项、
3256个字面调用通过，394个动态调用未穷举；API清单325路径、137处动态注册未解析。
README主英文、中文副本及13类双语指南完整链接现有代码模块。
当时依赖审计有35项告警（高危8），CI阻断；后续清零结果见顶部最新记录；
未经授权的提交/推送/部署均未执行。完整后端/浏览器/模型/原生/容器/远端CI仍需验收。

## Earlier checkpoints (superseded by the audit above)

## Passed

- Full web source suite: 175 files, 1,256 tests passed.
- Targeted server suite: 99 tests passed, covering AOD configuration/data/home
  isolation, inherited-credential rejection, dotenv boundaries, version/auth,
  Weixin identification, Docker blueprint contracts and artifact normalization.
- Script suite: 28 tests passed, covering publication checks, history-free patch
  ports, build metadata, safe private-config creation and inherited maintenance
  observation/reconciliation/no-replay fixture contracts.
- Shared, web and server builds passed; web bundle budget check passed.
- i18n static JSX guard passed for 155 files. Dynamic copy needs separate review.
- Compiled temporary instance: startup, health, Hub version 1.0.0, built web HTML
  and graceful shutdown passed. Adapters were disabled, configuration/data were
  temporary, and no production service or original private session was touched.
- Git-eligible source privacy/version gate passed. No inherited objects,
  commits, refs or remotes exist; repository-local initial identity is configured.

## Corrections during validation

Initial runs caught missing generated/shared exports, stale escaped private-domain
test assertions and a synthetic credential-URL false positive. They were corrected
and the corresponding suites rerun. A mistyped test path was refused by the exact
test selector rather than silently skipped. These earlier failures are not hidden
or counted as successful runs.

## Documentation completion checks (November 22, 2026)

- Added paired English/Simplified Chinese navigation, installation, usage,
  configuration, integrations, operations, troubleshooting and development guides.
- Existing script runner: 20/20 targeted tests passed across documentation,
  publication, private config creation, upstream patches and build metadata (5 files).
  The 4 documentation tests check local link targets, pairing/navigation, matching
  command examples and selected package/configuration contracts.
- Existing server runner: 11/11 targeted config/isolation/portability and product
  version tests passed (3 files); this is not the full backend suite.
- Publication source scan: 3479 files passed; `licensePresent: true`, `committed: false`.
  i18n static guard: 155 files passed, with dynamic copy still requiring review.
- Existing compiled server started with disposable external config, home/data and
  an OS-assigned loopback port. Unauthenticated `/api/health`, built HTML and
  graceful shutdown passed; all starter adapters remained disabled. Only that
  child was stopped and its temporary state removed; no production was touched.
- No fresh full build/application suite or browser login/keyboard/touch test for
  these docs changes. Native providers, multi-host pairing, Docker, other platforms,
  real TLS proxy origins, external websites and remote CI remain unverified.

## Detailed review checkpoint — November 22, 2026

The [bilingual detailed audit](open-source-review-1.0.0.md) supersedes earlier
assumptions of complete namespace/instance isolation. Nine modules have individual
baseline-file records; much semantic review remains pending. The exact-byte ledger
is an evidence-consistency gate, not approval. There are 47 unresolved finding or
acceptance-gap records (some describe related boundaries): 12 high, 24 medium,
11 low. Two high UI findings are explicitly conditional; Android redirect/Cookie
and asset provenance findings require platform/rights evidence, not proven exploits.

- Frozen all-dependency install passed. Final workspace build/typecheck passed.
- Full script rerun: **536/536 passed**, no skipped/cancelled tests.
- Full web checkpoint: **1,256/1,256 passed** across 175 test files.
- Final local-Hub/automation/board selectors: **21/21 passed** across three files.
- Production and development-inclusive audits: zero known advisories.
- Publication, i18n, API inventory and review-consistency checks passed. The strict
  complete-review gate correctly refused the incomplete/unresolved source (exit 1).
- Full backend attempted once: 900-second infrastructure timeout, six failures
  observed before timeout and then fixed with targeted regressions. No completed
  full-backend TAP summary and no remote GitHub/GitLab execution are claimed.
- Native build/install/signing, real browser/touch/provider, image/SBOM/OS and
  inherited-source/asset-rights acceptance remain unverified. No production touched.

中文：最新开源化审查仍阻断发布，47条问题／验收缺口未关闭；未把结构台账称为
逐文件完整语义通过。脚本536、Web1256、最终后端定向21项通过；构建与类型检查、
依赖审计及证据一致性门禁通过。完整后端超时，真实浏览器／原生／供应商、产物和
权利审查仍未验收，严格全审门禁按设计拒绝。没有提交、推送或部署。

## Deliberately not claimed

- No full backend-suite, browser E2E, real keyboard/touch or native/provider tests.
- No Docker build/runtime, Windows/Android/iOS build/signing or real-device release.
- No original private-session replay, production migration or independent deployed instance.
- No GitHub/GitLab push or remote CI execution.
- No legal license/redistribution approval or automatic proof that all source is secret-free.

Apache-2.0 was subsequently selected for AOD-owned code and its text added.
License-only checks on November 22, 2026 passed: canonical Apache-2.0 text
byte comparison, four core manifest SPDX fields, publication scan of 3463 files
(`licensePresent: true`, `committed: false`) and all 5 publication-check tests.
Application suites were not rerun for this license/documentation-only change.
The release gate intentionally refuses this draft until an initial authorized
commit, clean source and an approved LICENSE are present. A LICENSE file check
only establishes presence; rights approval remains a maintainer decision.

## 中文

前端全量 1256 项、后端定向 99 项、脚本 28 项通过；三包构建、包体积检查、
i18n 静态检查以及隔离实例启动/版本/网页/正常关闭验证通过。没有操作生产。
尚未验收完整后端、浏览器交互、真实模型、Docker 或原生端；未提交、推送或部署。
自有代码随后已选择 Apache-2.0 并添加正文；公开发布仍需确认分发权和第三方
合规，隐私扫描也不能替代人工审查。

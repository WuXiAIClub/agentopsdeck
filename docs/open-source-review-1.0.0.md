# AgentOpsDeck 1.0.0 detailed open-source review

**English · [简体中文](open-source-review-1.0.0.zh-CN.md) · [Documentation](README.md)**

## Verdict: blocked, not a completed semantic audit

### Pending-file review checkpoint (November 22, 2026)

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

### Source remediation checkpoint

Targeted repairs cover authentication admission, independent runtime roots,
bounded media/file handling, execution diagnostics, recovery receipts, browser
trust boundaries, native scaffolds and public namespaces. Current per-finding
remediation and test limits are recorded in [the finding registry](review/findings.json).
Original observations and baseline counts below are historical evidence, not
claims that repaired source still has the same defect. Changed ledger entries
are conservatively downgraded pending complete re-review; passing regressions do
not grant semantic, platform or redistribution approval.
See [validation evidence](validation-1.0.0.md) and [native boundaries](native-security.md).

The earlier scoped 53-record subset had **46 targeted-verified records and 7 partial or
acceptance-pending records**, including earlier fixes. This historical subset is
superseded by the pending-file review checkpoint and current registry. It is not 46 newly fixed
independent defects or whole-file approval. Remaining records cover structured
Gateway diagnostics, sealed Windows dependency inputs, device download acceptance,
native localization/version acceptance and redistribution rights.

Review checkpoint: November 22, 2026. Package consistency, frozen installation,
workspace build/typecheck and known dependency-advisory audits have passing local
evidence. **That does not approve the source for public release.** The initial
review found authentication, isolation, execution/logging, recovery and UI gaps;
current source and acceptance status is recorded above. High severity is a triage
priority, not proof of live exploitation.
No actual credential leak was observed. Legal/artifact gates are independent.
The baseline registry had **47 unresolved finding/acceptance-gap records**: 12 high,
24 medium and 11 low, including related/overlapping boundaries. Two high UI
entries are conditional; Android redirect and asset rights entries are evidence
gaps, not proven exploits. Six other records already had targeted remediation
evidence at that baseline.

This is a detailed staged review, not a claim that every file received complete
semantic analysis. Nine module reviewers worked from 3,503 eligible files.
Every baseline file has an individual record, including hashes, kind, depth,
checks, file-specific observations and finding references. Most still have only
structural evidence. Testing a module does not promote all its files to approved.

## Stack and package assessment

See [all direct declarations, ranges and exact locked versions](technology-stack.md).
The workspace is ESM/TypeScript with shared contracts, Hono APIs and React/Vite UI.
Locally verified tools: Node 22.22.1 (minimum 22.13), pnpm 9.15.0, TypeScript 5.9.3.
Core locked versions include Hono 4.13.20, its Node adapter 2.1.11, React/DOM 19.2.7,
Vite 6.4.6, Tailwind 4.3.1, TipTap 3.31.3, ws 8.21.0, node-pty 1.1.0 and
playwright-core 1.63.0. Built-in SQLite is an experimental Node API here. Browser
binaries and provider credentials are not bundled. Package `private: true`
prevents accidental npm publication; it does not prevent a public source repo.

Both production and development-inclusive registry audits returned **zero known
advisories** after the previous targeted remediation of 35 advisories. This does
not assert every package is newest or that custom source/OS images are safe.
Six parent-scoped compatible overrides remain visible and tested, not suppressed.
Build tooling currently sits partly in web runtime dependencies; classification
needs separate lockfile/build/container regression. Docker uses a floating Node
base and copies development dependencies; image/SBOM/OS acceptance is outstanding.

## File-by-file evidence and coverage

[Review standard](open-source-review-standard.md) · [Current exact-byte ledger](review/file-review.json)
· [Detailed finding evidence](review/findings.json)

The following is each agent's **baseline** coverage, before main-review additions
and conservative downgrades of changed files. Current counts come from
`pnpm check:review`, not from summing only semantic agent results.

| Module | Baseline files | Semantic | Structural | Asset | Pending depth |
| --- | ---: | ---: | ---: | ---: | ---: |
| api-auth | 401 | 51 | 350 | 0 | 0 |
| hub | 566 | 46 | 520 | 0 | 0 |
| connector | 590 | 51 | 539 | 0 | 0 |
| execution | 465 | 50 | 415 | 0 | 0 |
| storage | 219 | 15 | 204 | 0 | 0 |
| web-ui | 410 | 27 | 379 | 4 | 0 |
| web-state | 385 | 107 | 278 | 0 | 0 |
| native | 141 | 6 | 132 | 3 | 0 |
| governance | 326 | 8 | 35 | 0 | 283 |

- `semantic`: stated complete reading/call-chain review for that file, not a whole-module guarantee.
- `structural`: indexing, syntax/import/operation or pattern inspection; typically disposition pending.
- `asset`: asset inspection only; rights and final artifact notices can still remain unresolved.
- Changed snapshots are never blindly rehashed as approved. Main fixes carry explicit
  review notes; unrelated stale records are downgraded with the prior evidence retained.
- The ledger excludes only its own bytes to avoid recursive hashing. It includes
  the review standard, this report, finding registry, CI and new tests. Added or
  modified eligible files make the gate fail until their evidence is updated.
- Private provider histories, active databases, secrets and real workstation
  settings were not reviewed/copied. Public findings redact predecessor aliases
  and private paths. Chinese/technical raw observations remain in the JSON registry.

## Findings, supported claims and boundaries

Every entry below links to source; exact lines and detailed trigger/evidence,
trust boundary, impact, recommendation and test gaps are in the finding registry.
For newly scoped areas, missing live proof is an explicit limitation, not an
assumption of exploitability. The descriptions and source lines retain the original
observation; consult each registry remediation for current behavior. A passing
defect-reproduction test confirms the defect, **not its remediation**.
`fixed-targeted-verified` means scoped source repair verified, not platform approval.

| ID | Severity | Status | Source | Supported claim and limit |
| --- | --- | --- | --- | --- |
| AOD-AUTH-001 | high | fixed-targeted-verified | [apps/server/src/auth/original-json-command-store.ts:56](../apps/server/src/auth/original-json-command-store.ts) | JSON administrator sessions survive access-key changes without current-key binding or server expiry. Confirmed with disposable owner rebuilds; holders of an old token are required. SQLite has binding/expiry and is not implicated. |
| AOD-AUTH-002 | high | fixed-targeted-verified | [apps/server/src/config.ts:198](../apps/server/src/config.ts) | Non-loopback standalone listening can be configured without an access key. Anonymous access requires reachability and absence of extra gateway authentication. Default loopback and Hub-specific guards are not an unauthenticated public deployment proof. |
| AOD-AUTH-003 | medium | fixed-targeted-verified | [apps/server/src/application-http-shell.ts:34](../apps/server/src/application-http-shell.ts) | Voice work precedes mutation Origin/write admission. Read authentication still applies; a synthetic bad-Origin probe does not establish browser CSRF or a completed unauthorized send. |
| AOD-AUTH-004 | medium | partially-remediated | [apps/server/src/routes/auth.ts:453](../apps/server/src/routes/auth.ts) | Raw downstream error messages can reach the public auth response. Confirmed using inert diagnostic markers only; no real secret was observed. |
| AOD-AUTH-005 | high | fixed-targeted-verified | [apps/server/src/routes/files.ts:378](../apps/server/src/routes/files.ts) | File browsing can select the ambient native home instead of the configured instance root. A disposable two-root fixture demonstrated unintended other-instance scope. This is not proof of arbitrary unauthenticated traversal. |
| AOD-AUTH-006 | medium | fixed-targeted-verified | [apps/server/src/routes/files.ts:69](../apps/server/src/routes/files.ts) | Multipart and several file-operation limits apply too late or are incomplete. The upload cap follows full parsing; allocation/stream/download bounds require additional adversarial regression. |
| HUB-001 | medium | fixed-targeted-verified | [apps/server/src/hub/workspace-board-file-service.ts:231](../apps/server/src/hub/workspace-board-file-service.ts) | Hash-only stale-reply rejection permits an ABA projection rollback. Two disposable board/card reproductions confirm acceptance of delayed content after B-to-A changes; no remote disk loss or authorization bypass was demonstrated. |
| HUB-002 | low | fixed-targeted-verified | [apps/server/src/hub/queue-http.test.ts:93](../apps/server/src/hub/queue-http.test.ts) | Queue HTTP tests leave some disposable roots behind. Close and remove all temporary resources in finally/test cleanup. |
| AOD-CONNECTOR-001 | medium | fixed-targeted-verified | [apps/server/src/connector/terminals.ts:154](../apps/server/src/connector/terminals.ts) | Terminal kill failure is treated as stopped without process-exit proof. Synthetic PTY failure demonstrates premature quota release; real OS/process acceptance remains untested. |
| AOD-CONNECTOR-002 | medium | fixed-targeted-verified | [apps/server/src/connector/website-access.ts:74](../apps/server/src/connector/website-access.ts) | An uncooperative fetch can retain website-access admission during drain. The reproduction deliberately ignores AbortSignal. Ordinary fetch abort tests pass; default-fetch remote DoS was not proved. |
| AOD-CONNECTOR-003 | low | fixed-targeted-verified | [apps/server/src/connector/async-connector-surface.ts:272](../apps/server/src/connector/async-connector-surface.ts) | Predecessor Connector/service/token aliases remain in public identity contracts. Requires coordinated protocol migration and regression, not blanket replacement. The current publication heuristic misses these aliases. Exact predecessor spellings are omitted from this report. |
| EXE-001 | high | fixed-targeted-verified | [apps/server/src/hermes/process.ts:35](../apps/server/src/hermes/process.ts) | Default Hermes launch inherits ambient HOME and credential-bearing environment. Native execution must first be enabled; this is instance-isolation risk, not an OS sandbox escape. No real credentials or provider were accessed. |
| EXE-002 | high | fixed-targeted-verified | [apps/server/src/codex/app-server.ts:3618](../apps/server/src/codex/app-server.ts) | Native Codex stderr is written verbatim to service logs. The unsafe sink is confirmed in source, but real credential leakage was not observed. Default drain/static bounded diagnostics need synthetic regression. |
| EXE-003 | high | fixed-targeted-verified | [apps/server/src/openclaw/cli.ts:93](../apps/server/src/openclaw/cli.ts) | Optional native CLI fallback bypasses the configured instance home. Requires explicitly enabled CLI fallback and the relevant gateway failure. No actual native/provider execution was performed. |
| EXE-004 | medium | fixed-targeted-verified | [apps/server/src/openclaw/cli.ts:112](../apps/server/src/openclaw/cli.ts) | Native CLI failure text is preserved in message failure summaries. Output length limits do not redact sensitive diagnostics; test inert markers instead of real provider errors. |
| EXE-005 | medium | fixed-targeted-verified | [apps/server/src/codex/native-output.ts:29](../apps/server/src/codex/native-output.ts) | Native NDJSON buffering has no cumulative incomplete-frame byte cap. The existing FIFO tests pass but do not cover oversized unterminated or complete lines. |
| EXE-006 | medium | fixed-targeted-verified | [apps/server/src/config.ts:326](../apps/server/src/config.ts) | Private board-tool directory validation omitted the actual native HOME. Fixed by including HOME/USERPROFILE independently of AOD state; rejection tests preserve the existing authority boundary. |
| AOD-STORAGE-001 | high | fixed-targeted-verified | [apps/server/src/messages/send-message.ts:109](../apps/server/src/messages/send-message.ts) | Default inbound media ignores configured AOD roots and selects ambient native storage. Disposable default upload demonstrates outside-instance placement; not arbitrary credential reads. |
| AOD-STORAGE-002 | high | fixed-targeted-verified | [apps/server/src/messages/media-bridge.ts:46](../apps/server/src/messages/media-bridge.ts) | After-stat file replacement bypasses bridge allowlist and byte limits. Deterministic synthetic symlink replacement read outside-allowlist bytes. Requires local/agent write control of an allowed path; no private data was accessed. |
| AOD-STORAGE-003 | medium | fixed-targeted-verified | [apps/server/src/messages/send-message.ts:128](../apps/server/src/messages/send-message.ts) | Attachment permissions depend on ambient umask. A 022 fixture produced 0755/0644; actual exposure depends on ancestor traversal. Windows ACL and second-user acceptance are untested. |
| AOD-STORAGE-004 | low | fixed-targeted-verified | [apps/server/src/messages/send-message.ts:129](../apps/server/src/messages/send-message.ts) | A definitively invalid later batch item leaves earlier files without a returned receipt. Synthetic two-item fixture leaves one file. Global retention/cleanup is not fully traced; do not remove unknown external effects. |
| AOD-STORAGE-005 | low | fixed-targeted-verified | [apps/server/src/messages/media-bridge.ts:20](../apps/server/src/messages/media-bridge.ts) | Media-bridge cache retains all distinct path revisions without eviction. Full-file source confirms no bound/TTL/clear; no production load or memory benchmark. |
| WEBUI-001 | high | fixed-targeted-verified | [apps/web/src/components/WorkspaceOsDesktop.tsx:1729](../apps/web/src/components/WorkspaceOsDesktop.tsx) | A browser-command catch can retry a write after an unknown or rejected result. Conditional high risk: the second same-ID write is established, but duplicate execution depends on consumer idempotency. No live replay was attempted. |
| WEBUI-002 | medium | fixed-targeted-verified | [apps/web/src/components/WorkspaceOsDesktop.tsx:1713](../apps/web/src/components/WorkspaceOsDesktop.tsx) | Desktop browser commands use a fixed instance target rather than configured resource identity. A portable configured resource must drive the target; a fixed private target is not acceptable in the public adapter. |
| WEBUI-003 | high | fixed-targeted-verified | [apps/web/src/components/WorkspaceOsDesktop.tsx:8676](../apps/web/src/components/WorkspaceOsDesktop.tsx) | An iframe combines scripts and same-origin without rejecting untrusted same-origin HTML. Conditional high risk: exploitation requires reachable executable same-origin content and permitting CSP. No server reachability or XSS exploit was demonstrated. |
| WEBUI-004 | medium | fixed-targeted-verified | [apps/web/src/components/messages.tsx:768](../apps/web/src/components/messages.tsx) | External Markdown images load without explicit consent. Potential tracking/IP/referrer disclosure, not evidence of credential theft. |
| WEBUI-005 | medium | fixed-targeted-verified | [apps/web/src/components/FileBrowser.tsx:304](../apps/web/src/components/FileBrowser.tsx) | PDF preview trusts content kind/download URL without iframe sandboxing. Conditional malformed-connector/HTML risk; actual serving headers and browser exploit remain unverified. |
| WEBUI-006 | low | fixed-targeted-verified | [apps/web/src/main.tsx:1179](../apps/web/src/main.tsx) | Session deletion confirmations and a default confirm label are untranslated. Literal-catalog parity alone does not cover these non-JSX labels. |
| WEBUI-007 | low | fixed-targeted-verified | [apps/web/src/components/SharedSessionView.tsx:194](../apps/web/src/components/SharedSessionView.tsx) | Shared-session status values are rendered as raw English enums. Translate display labels while preserving transport enums. |
| WEBUI-008 | low | fixed-targeted-verified | [apps/web/src/components/WorkspaceNativeDrawio.tsx:197](../apps/web/src/components/WorkspaceNativeDrawio.tsx) | Native drawing dialogs lack accessible names. Add names through the existing dialog architecture; real assistive-technology acceptance is outstanding. |
| WEBUI-009 | medium | fixed-targeted-verified | [apps/web/src/components/WorkspaceOsDesktop.tsx:8507](../apps/web/src/components/WorkspaceOsDesktop.tsx) | Iframe-mode URL submission still writes a backend navigation command. Separate renderer-mode admission before writes; do not replay outcome-unknown commands for verification. |
| WS-001 | high | fixed-targeted-verified | [apps/web/src/lib/moderator-stt.ts:285](../apps/web/src/lib/moderator-stt.ts) | Pending microphone start/transcription can outlive stop or unmount. Synthetic delayed permission and HTTP callbacks reproduced continued capture/batches. Real browser/device/provider acceptance was not performed. |
| WS-002 | medium | fixed-targeted-verified | [apps/web/src/lib/moderator-stt.ts:441](../apps/web/src/lib/moderator-stt.ts) | Audio transcription/socket paths lack in-flight caps and backpressure. Three synthetic six-second windows yielded concurrent pending requests; no real provider load test. |
| WS-003 | medium | fixed-targeted-verified | [apps/web/src/lib/command-recovery.ts:528](../apps/web/src/lib/command-recovery.ts) | Malformed accepted receipts can clear an exact outcome-unknown journal. An exact-key isolated simulation showed journal removal; actual automatic replay was not established. Preserve unknown protection until authoritative result validation. |
| WS-004 | medium | fixed-targeted-verified | [apps/web/src/lib/cache-storage-budget.ts:24](../apps/web/src/lib/cache-storage-budget.ts) | Cross-scope cache budgeting only evicts the current scope. A synthetic storage fixture exceeded the soft aggregate budget while deleting the new scope; not a hard browser quota bypass. |
| WS-005 | low | fixed-targeted-verified | [apps/web/src/lib/i18n.ts:24](../apps/web/src/lib/i18n.ts) | A rejected Chinese translation chunk promise is permanently cached. VM dynamic-import rejection confirmed that retries do not reimport. Browser rejection handling remains untested. |
| WS-006 | low | fixed-targeted-verified | [apps/web/src/lib/session-cache.ts:59](../apps/web/src/lib/session-cache.ts) | A legacy browser-storage probe alias remains. Migrate public namespace carefully and add publication regression; no private state was accessed. |
| NAT-001 | high | fixed-targeted-verified | [native/windows/control-source/desktop-launcher.cjs:12](../native/windows/control-source/desktop-launcher.cjs) | Desktop launch retains ambient application data/config/provider settings. Five inert prepare-only assertions reproduced inherited cross-instance configuration. No server, Windows launcher, credentials or provider was started. |
| NAT-002 | medium | fixed-targeted-verified | [native/windows/control-source/ui-config.cjs:3](../native/windows/control-source/ui-config.cjs) | Native settings validation and server loading disagree on the key-file setting. Disposable prepare-only fixture drops the required non-secret key-file path; no real key or native server initialization. |
| NAT-003 | medium | mitigated-acceptance-pending | [native/windows/control-source/ui-dependencies.cjs:14](../native/windows/control-source/ui-dependencies.cjs) | Native dependency installation is not reproducible and suppresses npm audit. Source-only supply-chain/release gap; installer was not executed and no compromised package was demonstrated. |
| NAT-004 | medium | partially-remediated | [apps/android/app/src/main/java/com/agentopsdeck/MainActivity.java:677](../apps/android/app/src/main/java/com/agentopsdeck/MainActivity.java) | Android delegated authenticated downloads lack verified redirect/cancellation guarantees. Platform-verification gap, not a proved Cookie leak. Requires device/OS behavior and stale-identity cancellation acceptance. |
| NAT-005 | medium | partially-remediated | [apps/ios/Sources/DownloadCoordinator.swift:34](../apps/ios/Sources/DownloadCoordinator.swift) | iOS download/share queues lack explicit byte and concurrency bounds. Source confirms missing app-level caps; no WebKit/storage-pressure/platform tests or native build. |
| NAT-006 | medium | acceptance-pending | [apps/ios/Sources/WebViewController.swift:35](../apps/ios/Sources/WebViewController.swift) | Native user-facing strings are not aligned for English and Simplified Chinese. Source literals/resources inspected; full locale/device/accessibility acceptance remains pending. |
| NAT-007 | medium | acceptance-pending | [native/windows/installer/packaging/AgentOpsDeck.iss:8](../native/windows/installer/packaging/AgentOpsDeck.iss) | Native versions and packaging inputs remain historical scaffolds. Core source stays 1.0.0, but wrappers/installers require independent version and reproducible input policy. No native builds/signing/installer execution. |
| NAT-008 | medium | acceptance-pending | [apps/ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png:1](../apps/ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png) | Native assets and artifact notices lack closed provenance approval. Hashes/formats do not establish rights. No finding of illegality; visual/rights/final artifact review is outstanding. |
| GOV-001 | medium | fixed-targeted-verified | [scripts/prepare-upstream-patch.mjs:14](../scripts/prepare-upstream-patch.mjs) | Upstream normalization overwrites reserved product VERSION/BUILD symbols. Pure-function reproduction emits nonexistent exports. Helper does not automatically apply or execute patches; add symbol-preservation regression. |
| GOV-002 | low | fixed-targeted-verified | [packages/shared/src/model-set.ts:62](../packages/shared/src/model-set.ts) | Shared Connector service contract retains a predecessor alias. Shared declaration and producers disagree with the public namespace policy; coordinate type/producer/test migration. No auth bypass. |
| GOV-003 | low | fixed-targeted-verified | [scripts/ci-bootstrap-pnpm.mjs:17](../scripts/ci-bootstrap-pnpm.mjs) | Bootstrap archive caps apply only after the transfer writes. Pinned registry/time/hash controls remain; oversized-transfer early termination was not tested. This is disk-budget risk, not integrity bypass. |
| MAIN-001 | medium | fixed-targeted-verified | [scripts/create-local-config.mjs:1](../scripts/create-local-config.mjs) | Concurrent config creation could rotate/overwrite a newly created key. Exclusive owned lock plus atomic private write; 8 targeted tests including deterministic cross-process contention. |
| MAIN-002 | medium | fixed-targeted-verified | [scripts/write-build-info.mjs:1](../scripts/write-build-info.mjs) | Normal build metadata generation could promote product versions from HEAD tags. Metadata write no longer calls version promotion; isolated v9.9.9 tag leaves all five product-version sources at 1.0.0. |
| MAIN-003 | medium | fixed-targeted-verified | [scripts/publication-check.mjs:1](../scripts/publication-check.mjs) | Missing Git-indexed source was silently skipped. Fail closed as missing-source; disposable tracked/deleted fixture plus eight publication tests. |
| MAIN-004 | medium | fixed-targeted-verified | [scripts/open-source-review.mjs:1](../scripts/open-source-review.mjs) | An asset-depth record could wrongly describe runtime source. Validator rejects incompatible asset depth and inconsistent finding disposition; six evidence-schema tests. |
| MAIN-005 | low | fixed-targeted-verified | [apps/server/src/application-local-hub-async.test.ts:1](../apps/server/src/application-local-hub-async.test.ts) | Local Hub test seeds assumed an enabled native Connector under disabled-native defaults. Seed from the real default connection status; stale authority rejection remains intact. Before: 3 failures; targeted fix: 12/12. |

## Historical validation baseline

The config generator now serializes cooperating writers; stale locks are not
stolen. Build provenance no longer promotes product versions. Missing indexed
source fails the publication gate. Review evidence cannot classify executable
source as an asset. Private board-tool HOME exclusion was repaired without
loosening worker authorization. Local Hub and automation fixtures were corrected
to match disabled-native defaults and actual projected history; the missing-history
rejection case remains covered. These are bounded fixes, not remediation of the
other open findings.

- Frozen all-dependency install, shared/server/web build and final typecheck passed locally.
- Full web source suite: **1,256 passed** across 175 discovered files; no failures/cancellations/skips.
- Full script suite final rerun: **536/536 passed**, no failures/cancellations/skips.
  Review/publication subset **14/14**
  and CI/documentation subset **7/7** passed after the relevant gate changes.
- Final targeted backend selectors cover local Hub, automation hooks and board
  configuration: **21/21 passed**. Execution reviewer separately ran **240 passing tests / 28 files**;
  these counts overlap and must not be summed as unique full-suite coverage.
- API/auth reviewer: existing **44/44**, inert boundary probes **8/8** confirming
  current defects. Connector **22/22**, Hub ABA probes **2/2**, web UI isolated
  probes **7/7**, web state **365** regressions plus **5** defect simulations.
- Storage reviewer: **712 passed** over 13 selected files, then **85 passed / 1 skipped**
  over six files (overlap possible). Governance **14/14**. Native used isolated
  prepare-only assertions and source/format inspection, not platform installation.
- Full local backend attempt **did not pass**: the existing wrapper timed out at
  900 seconds (infrastructure exit 2), with six failures observed before timeout.
  Three local-Hub fixture failures, two automation fixture failures and one real
  HOME validation gap were then fixed with targeted regression. There was no
  completed full-backend TAP summary; no fabricated full pass/count is claimed.
- GitHub defines 12 discovered-file backend shards. Hosted execution has not been
  performed. GitLab's unsharded backend command retains the local wrapper timeout
  limitation. No remote CI, Docker image, native installer or production switch occurred.

## Required next review rounds

1. Finish the successful structured Gateway diagnostics review; static exception
   sinks do not establish that every successful detail payload is safe.
2. Supply separately reviewed immutable Windows dependency inputs and establish
   reproducible artifacts. Deliberate fail-closed refusal is not install acceptance.
3. Validate Android/iOS exact-byte bounds, redirects, identity changes, cancellation,
   storage pressure and share cleanup on devices; source assertions are insufficient.
4. Complete remaining native EN/CN labels, locale bridging and sealed native-to-core
   version policies. Validate browser microphone, keyboard, touch and accessibility.
5. Finish semantic rereview of changed and pending files and a completed backend
   run. Keep exact execution identity, real-drain proof and unknown-outcome protection;
   no timeout-to-idle conversion, private replay or blind retry for acceptance.
6. Establish inherited-source/asset redistribution rights and final notices, then
   request explicit publication authorization. No source test can substitute for this.

`pnpm check:review` validates coverage/evidence consistency and deliberately
allows an honestly incomplete draft. `pnpm check:review:complete` must currently
fail for open findings or structural/pending evidence. Neither gate proves the
human observations are true, approves licenses, nor authorizes publication.

OpenAPI remains a static 3.1 inventory (482 registrations, 326 paths, 137 unresolved
registrations), not complete request/response/auth schemas or a deployed Swagger UI.
Catalog parity does not settle the 395 dynamic translation calls. Real browser,
touch/accessibility, multi-tab, malformed HTTP/WS, provider, Windows/macOS, native
and container acceptance remain explicitly unverified. No commit, push, tag,
GitHub authentication or deployment is part of this review.

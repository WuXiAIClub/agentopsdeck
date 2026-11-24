# Release blocker workflow

**English · [简体中文](release-blockers.zh-CN.md) · [Documentation](README.md)**

## Separate evidence from permission

AgentOpsDeck 1.0.0 is still a draft. A passing source scan, dependency audit,
license-file check or scoped regression does not authorize publication. GitHub
authentication is deferred; no commit, push, tag or deployment is authorized.
See the [source audit](open-source-review-1.0.0.md) and
[validation record](validation-1.0.0.md) for historical checkpoints.

| Blocker | Required evidence | Current handling |
| --- | --- | --- |
| Source defects | Minimal repair, regression and current-byte semantic review | Repair API, execution, scripts and UI in bounded batches; retain independent gaps |
| Incomplete source review | Complete file reading and relevant direct contracts | Structural inventory is not semantic approval |
| External contracts | Exact supplied implementation and matching-version contract review | Historical 2.3.7 commit is now available for read-only investigation; current 2.5.0 cannot substitute |
| Hermes gateway contract | Supplied replay/server/entry source identity and explicit trust review | Required implementation is not supplied; do not execute arbitrary upstream to clear a gate |
| Inherited rights | Actual rights-holder approval covering source, contributions and assets | Apache-2.0 selection and new Git author do not establish inherited ownership |
| Artifact attribution | Exact distributed-file inventory, full licenses/notices and applicable source obligations | Installed package metadata is only a starting inventory; no image/native artifact clearance |
| Acceptance | Dated test commands/results, exclusions and real runtime/platform evidence | Isolated local tests are allowed; provider/business replay and production maintenance are not |
| Release permission | Explicit approval of the exact final source and distribution scope | Pending; GitHub login is not release permission |

## External-contract checkpoint — November 23, 2026

The exact historical 2.3.7 commit and 15 identified source bodies were recovered
for read-only inspection. This supersedes the November 22 observation that the
baseline was unavailable; it does **not** close compatibility finding `S1-009`.
The verifier still resolves history through the new repository, whose inherited
history is intentionally absent. Raw historical configuration does not honor
the current `AOD_*` isolation settings, and historical build exports, identity,
protocol and file-binding headers require a reviewed normalization contract.
Do not execute that raw baseline, import its Git history or substitute a different
version. A source/provenance adapter and isolated before/after fixtures remain
necessary. The separately supplied Hermes gateway ABI is still unavailable.

Source findings also remain independent of these contracts: the durable receipt
gap in generic execution recovery (`EXE-APP-COMPLETE-003`) and the concurrent
filesystem mutation boundary (`AOD-API-COMP-001`) are not closed by the current
logging, output-budget or API-body fixes. Unknown outcomes must not be replayed.

## Repair and acceptance checkpoint — November 23, 2026

The current scoped repairs retain the existing application architecture:

- Successful Connector probes project explicit DTOs and public URL fields, not
  arbitrary upstream objects. Message, creation and model uploads enforce wire-byte
  budgets before admission. Legacy archive/pin uploads now have bounded reads and
  final original-token/abort checks; deliberate malformed-JSON defaults remain.
- Runtime model overrides use the same whole-object validation for startup and
  writes: 128-character keys/models, 512 entries and 64 KiB of encoded UTF-8.
  Unsupported updates and invalid existing files fail before persistence or ACK;
  accepted boundary values reload. The outer settings API's 4096-character input
  allowance is not a promise that this runtime can persist every such value.
- Optional completion-marker storage failures no longer block existing sessions.
  Creation uses the native modal; the narrow-screen caller now forwards and awaits
  the creation promise instead of immediately dismissing loading controls.
  Reduced-motion boot retains visible static status and progress.
- Compatibility and permission probes retain actual transport ownership and
  execution identity. A deadline is not stop proof, and unknown work is not replayed.

Current parent-run API projection/body/preference tests passed **83/83**; the
separate six-file preference/settings compatibility selection passed **114/114**.
Runtime override/output/environment plus settings-ACK tests passed **30/30**
(17 + 13); these selections overlap and must not be added as independent coverage.
The first combined runtime run failed on a repeated synthetic queue ID; the rerun
uses distinct IDs and retains unchanged queue/execution and unknown-outcome checks.
Earlier interrupted, heap-exhausted or failed fixture attempts are not successes.

The final current-source web test runner passed **1356/1356**, and the final
script runner passed **665/665**, both with no failed, cancelled or skipped tests.
These results cover their respective runners, not the full backend suite or
remote GitHub CI. Successful draft gates do not constitute release approval;
complete-review and release gates must still reject unresolved blockers.

The integrated exact-byte ledger covers **3567 files**: **839 semantic**, **2719
structural**, **2 pending** and **7 assets**. The registry has **139 records**;
**90** have targeted-verification labels, but only **85** satisfy the closure
evidence contract, leaving **54** unresolved for release. Records include
overlapping observations and acceptance gaps, not independent vulnerabilities.
Structural coverage is not semantic approval, and labels alone do not close a
finding. These are dated snapshots; the current JSON ledger and registry govern.

Actual headless browser fixtures passed creation/recovery at **1440/390 px** and
startup/auth/storage recovery at **1440/390/320 px**. Creation verifies native
modal focus containment, inert background, Escape/Cancel/Close restoration, auth
dismissal and disabled loading controls. Both boot phases measured **11** animated
element/pseudo-element entries normally and **0** with reduced motion, with visible
status/progress and completed fallback/auth/welcome lifecycle. HTTP/WebSocket
fences and synthetic accounts prevent provider or business-history replay.
Viewport emulation is not physical touch, screen-reader or native-platform
acceptance; the existing browser executable's provenance is not certified for
redistribution. Passing these fixtures does not approve all UI source or CSS.

A fresh development-inclusive dependency registry audit reported **0** advisories
at every severity. Selected installed license/NOTICE file hashes are recorded in
the [inventory](review/third-party-license-inventory.json), marked inventory-only.
Neither observation completes dependency, artifact, rights or platform review.
Current shared/web and server builds passed, including TypeScript checks and web
bundle budgets. The freshly compiled disposable loopback instance passed health
200, authenticated Hub version 1.0.0, anonymous Hub 401, built HTML/asset HEAD 200
and SIGTERM physical child close with exit 0, without forced cleanup. Native,
provider, update and setup adapters were disabled; no production instance changed.
Complete backend, native/containers, live providers and remote CI remain unverified.

The generic durable-recovery receipt gap and model-reconciliation write-authority
continuity (`AOD-API-COMP-005`) remain unresolved, independently of these repairs.
Structural/generated-file coverage and unproven UI hypotheses remain explicit;
neither hashes nor scoped test success promote them to semantic approval.

## Enforced release gate

`pnpm check:publication` remains the draft privacy/version scan.
`pnpm check:publication:release` also checks clean initial history/identity,
license presence, current complete semantic evidence, no unresolved finding
records, and [release decisions](review/release-approval.json).

The release decision file is deliberately pending. Each of `inheritedRights`,
`artifactAttribution`, `acceptance` and `releaseAuthorization` must have:

- `status: "approved"`, an actual `approvedBy`, and an ISO UTC `approvedAt`;
- nonempty `evidence` entries containing repository-relative `path` and exact `sha256`;
- the root `sourceVersion` and `sourceSha256` matching the reviewed source inventory.

The source digest includes eligible files and their bytes, excluding only the
decision file itself and the self-recording file ledger. The ledger is separately
validated against all current eligible source bytes. Evidence cannot refer to the
decision file itself, ignored private files, missing files or symbolic links.
Changes invalidate approval. Missing/malformed decisions fail closed without
printing their contents. A LICENSE longer than the gate's minimum length proves
only that a license file exists, not that anyone approved redistribution.

The checker cannot authenticate a signer, establish legal title or prove that
an evidence document tells the truth. Maintainers must review the underlying
records and the actual distribution scope; never auto-fill approvals from tests.
Historical coverage observations must be explicitly reconciled, not deleted or
silently relabeled to make the finding registry pass.
Source fixes use `fixed-targeted-verified` with `remediation`; disproved findings
use `reviewed-no-finding`, and completed evidence gaps use `verification-complete`,
both with `resolution`. Closure requires a summary, nonempty `testEvidence`, limits
and an explicit `liveAcceptance: false`; runtime acceptance remains a separate gate.

## Human decisions still needed

1. Identify the inherited source/asset rights holder and authority to publish it
   under Apache-2.0, including other contributors' rights and retained notices.
2. Specify source-only versus web/image/native distribution. Audit each final
   artifact separately; optional external agents are user-provisioned, not relicensed.
3. Confirm the public contact and private security reporting process.
4. Supply the missing gateway implementation with verifiable identity. Treat its
   executable probe as trusted operator code, not a sandbox or read-only guarantee.
5. Plan actual browser/keyboard/touch/accessibility and advertised platform/provider
   acceptance with fresh isolated accounts. No business-history replay is implicit.
6. Approve publication separately, only after all applicable blockers are closed.

No final NOTICE, rights approval or complete acceptance is invented by this
workflow. Review [licensing](licensing-review.md) and [native security](native-security.md).

# Open-source review standard

**English · [简体中文](open-source-review-standard.zh-CN.md)**

This is the review contract for AgentOpsDeck 1.0.0 and later upstream patches,
not publication approval. Read repository instructions, [security policy](../SECURITY.md),
[license status](../LICENSE-STATUS.md) and [upstream rules](upstream-sync.md).

## Scope and evidence

Inventory Git-eligible tracked **and untracked** files with
`git ls-files --cached --others --exclude-standard -z`, deduplicate and sort.
Do not stage files to inventory them. Exclude ignored dependencies, outputs,
private provenance/configuration and runtime state. Never open live databases,
expose credentials/business histories, exercise private providers, restart
services or replay unknown-outcome work during source review.

Assign non-overlapping modules. Each file record needs relative path, SHA-256,
size, kind, depth, checks performed, specific observations and finding IDs.
Changed hashes invalidate records; additions require review. Report snapshot
size, assignments, missing/duplicate records and stale hashes.

- `semantic`: complete file and relevant callers/contracts/tests inspected;
  identify checks and limitations in notes.
- `structural`: syntax, metadata, patterns or test structure inspected; **not**
  full semantic/security approval.
- `asset`: binary/generated asset identified, with provenance/license/exposure
  checked as evidence permits. Reading bytes is not image inspection.
- `pending`: unreviewed or insufficient evidence, with an explicit reason.

Dispositions: `no-finding`, `finding`, `pending`, `not-applicable`.
`no-finding` is limited to the stated depth, not proof of safety. Searches,
scanners, automatic ledgers, tests and zero dependency advisories do not establish
full file-by-file semantic review. Separate tests, generated inventories, native
scaffolds and assets from runtime code in coverage counts.

The public ledger is `docs/review/file-review.json`. `pnpm check:review` validates
coverage, hashes and evidence shape; it does **not** approve semantic completeness.
`pnpm check:review:complete` additionally refuses structural/pending evidence and
unresolved findings. Only the ledger itself is excluded from its hash inventory
to avoid self-referential hashes; its JSON shape is validated and its bytes still
undergo the publication scan. Neither command grants publication authorization.
Any source change requires an actual re-review, not a blind hash refresh.

## Required checks

| Area | Checks |
| --- | --- |
| Package/supply chain | Every manifest, workspace, engine/peer contract, ranges versus lock versions, runtime/build classification, lifecycle scripts, scoped overrides, registry origins, frozen install, immutable/read-only CI actions; no audit suppression. Audit production and development explicitly. |
| Privacy/portability | No predecessor branding, fixed private home/domain/network defaults, credentials, histories or environment-specific deployment receipts. Independent documented `AOD_*` settings; inspect fixtures, generated files and assets too. |
| Auth/authority | Fail-closed HTTP/WebSocket/stream entry points, Origin/CSRF/cookies/passkeys, issuer versions/grants/revocation, owner/member and read/write isolation. Trace entry point to operation. |
| Untrusted input | Path canonicalization/authorization without traversal/symlink/encoding bypass; body/frame/collection/time/concurrency limits; SSRF/redirects, HTML/Markdown/URL sinks, shell/argument injection, upload/archive safety, error/log redaction. |
| Execution/recovery | Exact execution identity, monotonic terminal state, stale-event rejection, disconnect recovery, cancellation/cleanup, continuation after proven completion, maintenance fencing. Timeout is not stop proof; protect `outcome_unknown`. |
| Storage/files | Transactions/migrations, atomic writes, permissions/backups, independent runtime homes, bounded retention, authority continuity/file-binding repair. Disposable test state only. |
| UI/i18n | Unsafe rendering, focus/keyboard/touch/a11y, event/timer cleanup, concurrent requests, EN/CN dynamic keys and non-JSX labels. Reuse menu architecture; no blanket hover delays. |
| Native/tools | Download/install/build commands, archive paths, privilege/service boundaries, platform settings, signing material, subprocess outputs, user settings. Do not call experimental scaffolds accepted releases or sandboxes. |
| API/docs | Examples match code, EN/CN contracts align, auth/body/error/stream contracts documented. Route inventory is not a complete normative OpenAPI schema or deployed Swagger endpoint. |
| Licenses/artifacts | Inherited-source rights, asset provenance, third-party notices, exact versions and separate final source/web/image/native audits. Apache-2.0 and new authorship do not establish third-party ownership. |

## Findings and verification

Each finding needs ID, severity (`critical`, `high`, `medium`, `low`, `info`),
paths/lines, evidence, trust boundary, realistic trigger/impact, minimal fix,
regression or explicit gap. Label hypotheses; redact sensitive values. Fix in
the existing architecture with disjoint delegated write scopes. Reviewers write
assigned reports only unless specifically assigned a fix. Never swallow errors,
weaken assertions, suppress audits or invent legal approval to pass gates.

Use existing isolated test runners, first relevant regressions, then build,
typecheck and broader suites. Record selectors/counts/failures/exclusions. Local
success is not remote CI execution. Real browser/touch, provider, native/platform
and container acceptance require separate evidence. Minimum source gates include:

```sh
pnpm check:publication
pnpm check:i18n
pnpm check:api
pnpm audit --prod --json
NODE_ENV=development pnpm audit --json
```

Also require frozen install and script/web/backend tests. These are necessary,
not sufficient: report review depth, unresolved risks, actual test coverage,
rights, artifact notices and authorization separately. Review does not authorize
commit, push, tag, production replay or deployment.

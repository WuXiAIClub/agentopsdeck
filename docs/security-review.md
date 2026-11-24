# Security and open-source review

**English · [简体中文](security-review.zh-CN.md) · [Documentation](README.md)**

## Scope and safeguards

**Latest verdict (November 22, 2026): source release blocked.** The dependency
audit is clean, but the subsequent [file-by-file review](open-source-review-1.0.0.md)
found unresolved authentication, instance isolation, execution/logging and UI
risks. Targeted source remediation is now recorded in the finding registry;
original observations describe the pre-repair snapshot. The table below describes
controls and targeted checks, not complete semantic approval. Publication now
also rejects predecessor Connector/service/token aliases without exemptions.

This is a source review, not a penetration test or a guarantee of zero secrets.
The release is a trusted-operator control plane. Native agents, shell terminals
and tool execution have operator privileges; approvals are not a sandbox.
Review [SECURITY](../SECURITY.md), [configuration](configuration.md) and
[operations](operations.md) before remote use.

| Reviewed boundary | Source and regression coverage |
| --- | --- |
| Public branding and source isolation | Core metadata uses AOD; the publication gate scans eligible names and bytes. The detailed review found predecessor-connector/storage aliases and instance-isolation gaps not covered by this heuristic gate; coordinated fixes remain required. |
| Credential material | [`publication-check.mjs`](../scripts/publication-check.mjs) rejects private-key headers, provider/Git/cloud token signatures, JWT patterns, long literal credential assignments and URL-userinfo credentials. Findings show category/path only, never matched values. |
| Private runtime files | `.env` except the empty example, signing material, databases, histories/state/private directories and logs are rejected when eligible for Git; forcibly tracked ignored files remain rejected. |
| Access and portability | [`config.ts`](../apps/server/src/config.ts) defaults loopback and disabled native execution; [`auth`](../apps/server/src/auth) owns current auth/request scopes; targeted auth/config tests validate these boundaries. |
| Scoped resource access | [`connector/read-authority.ts`](../apps/server/src/connector/read-authority.ts), route guards, shared validators and root configuration retain grant/version checks. No permission system or recovery protection was bypassed for publication. |
| CI and API documentation | Hosted GitHub runners, pinned action revisions, read-only checkout, isolated tests and no deploy/upload/provider credentials; generated API JSON has no instance server or secrets. Optional GitLab config needs no private runner tags/proxy. |
| Safe upstream ports | [`prepare-upstream-patch.mjs`](../scripts/prepare-upstream-patch.mjs) normalizes legacy names without embedding their literal branding, excludes release metadata/history and rejects detected unsafe source. Operator must privately scrub environment-specific content before porting. |

Configuration **field names** such as `AOD_ACCESS_KEY` or `apiKey`, blank values
and placeholders are necessary API contracts, not embedded credentials. Fresh
keys are generated only into ignored private configuration by
[`create-local-config.mjs`](../scripts/create-local-config.mjs).

Runtime defaults cannot contain fixed workstation home paths or LAN IP origins.
Synthetic path/network fixtures remain allowed for portability tests; this narrow
environment-fixture allowance never exempts credentials or legacy branding.
The optional browser-stream daemon now uses private runtime directories and an
explicit Chromium executable, never a fixed release/worktree or browser-cache path.
It is an experimental operator-controlled helper, not a shipped sandbox service.

Synthetic URL-userinfo rejection tests have exact path/category/SHA-256 exceptions.
Changing any bytes invalidates the exception. Only deliberately inert test URLs
may qualify; credential signatures, private files and legacy branding are never
exempt. This is not a general “ignore tests” policy.

## Required checks

```sh
pnpm check:security
pnpm check:publication
node scripts/run-script-tests.mjs security-review.test.mjs publication-check.test.mjs create-local-config.test.mjs upstream-patch.test.mjs github-ci.test.mjs
```

GitHub also runs the complete script suite and partitions **all discovered**
backend source tests. Regression tests cover unsafe signatures, redacted findings,
tracked runtime state, exact-byte fixture exceptions, brand regressions,
version/identity drift, fresh private-key generation and invalid CI sharding.

## Remaining risks and release gates

The initial production-dependency registry audit on November 22, 2026 reported
**35 advisories: 8 high, 23 moderate, 4 low, 0 critical**. A targeted remediation
on the same date brought the locked production graph to **0 advisories at all
severities**. The development-inclusive audit also returned zero; the existing
`pnpm audit --prod --audit-level=high` gate exited successfully. These are registry
snapshots, not a penetration test or a guarantee against future advisories.

| Package | Previous locked version | Remediated locked version |
| --- | --- | --- |
| `@hono/node-server` | 1.19.14 | 2.1.11 |
| `hono` | 4.12.25 | 4.13.20 |
| `@simplewebauthn/server` | 13.3.1 | 13.3.3 |
| `nanoid` (server / PostCSS) | 5.1.11 / 3.3.12 | 5.1.16 / 3.3.20 |
| `vite` | 6.4.3 | 6.4.6 |
| `postcss` | 8.5.15 | 8.5.33 |
| `browserslist` | 4.28.2 | 4.29.6 |
| `baseline-browser-mapping` | 2.10.37 | 2.11.39 |
| `source-map-js` | 1.2.1 | 1.2.4 |

Direct manifest minimums now exclude the reviewed vulnerable versions. Six
parent-scoped `pnpm.overrides` enforce compatible transitive security floors:
Babel → Browserslist, Browserslist → baseline mapping, Vite → PostCSS,
PostCSS → Nano ID / source maps, and Tailwind's Node helper → source maps.
The Tailwind path was also affected even when the registry returned an empty
finding-path list. Nano ID 3.x consumers remain on 3.x; no global major-version
override, audit exemption or suppression was added. The only direct major
upgrade is the Node adapter, whose [v2 release](https://github.com/honojs/node-server/releases/tag/v2.0.0) documents an unchanged public API;
the project Node minimum already exceeds its Node 20 requirement.

[`dependency-security.test.mjs`](../scripts/dependency-security.test.mjs) checks
every locked affected resolution, manifest minimums, parent-scoped constraints
and unchanged AOD 1.0.0 versions. It rejects the old versions and prereleases;
this offline regression guard does not replace the live registry audit.
[`node-adapter-security.test.ts`](../apps/server/src/node-adapter-security.test.ts)
uses a disposable loopback server to test raw-backslash rejection, encoded and
malformed static paths with prefix authorization, GET/HEAD, Unicode/spaced file
names, JSON/cookies and streaming. Existing auth, passkey, socket, request-drain
and bundle suites are included in the regression scope. No production server,
credential or historical request is used. All-source backend acceptance remains
the responsibility of the complete CI shards; see the actual local scope below.

```sh
pnpm install --frozen-lockfile --prod=false
node scripts/run-script-tests.mjs dependency-security.test.mjs
node scripts/run-source-tests.mjs server node-adapter-security.test.ts web-bundle.test.ts
pnpm audit --prod --audit-level=high
NODE_ENV=development pnpm audit --json
```

- Signature scanning cannot detect every short token, encrypted secret, arbitrary
  business information or proprietary endpoint. Review every source diff, binary
  asset, generated document and dependency artifact before publication.
- Existing asynchronous ownership/recovery is retained. Do not bypass
  `outcome_unknown`, use timeout as stop proof or retry historical provider calls
  as part of a source audit.
- Native installers, provider integration, real browser authorization, remote TLS,
  container OS/dependency attribution and penetration testing require separate
  acceptance. No production data or services are touched by this review.
- Apache-2.0 selection does not resolve inherited-source rights or every bundled
  notice obligation; [license status](../LICENSE-STATUS.md) remains a release gate.
- The source gate is not a leak cleanup tool. If a real secret is discovered,
  privately quarantine it and arrange authorized rotation/history cleanup;
  deleting the visible string alone is insufficient.

See [validation](validation-1.0.0.md) for checks actually run. A configured
workflow is not proof that remote GitHub Actions has executed successfully.

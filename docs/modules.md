# Modules and execution boundaries

**English · [简体中文](modules.zh-CN.md) · [Documentation](README.md)**

This map describes the actual source tree, not a proposed architecture. Server
directories are checked against this map by documentation tests. For endpoint
registrations, see the generated [API inventory](api/openapi.json) and [API guide](api.md).
An adapter being present does not imply it is installed, authenticated or enabled.

## Application roots and roles

[`apps/server/src/index.ts`](../apps/server/src/index.ts) owns process signals and
starts [`application-process.ts`](../apps/server/src/application-process.ts).
[`config.ts`](../apps/server/src/config.ts) reads private settings and defaults
native execution off. [`server-role.ts`](../apps/server/src/server-role.ts) selects
`all`, `hub` or `connector`; [`application.ts`](../apps/server/src/application.ts)
and the `application-*-async.ts` roots compose the existing synchronous/worker
ports. [`application-http-shell.ts`](../apps/server/src/application-http-shell.ts)
owns HTTP admission, request-source context, CORS and history transport.
`application-*-http.ts` modules connect domain ports to HTTP without making
admission timeouts proof of execution termination.

## Server modules

| Source module | Responsibility and boundary |
| --- | --- |
| [`apps/server/src/antigravity`](../apps/server/src/antigravity) | Experimental Linux ACP transport, private HOME ownership and journal/cleanup-gated execution contracts. Not connected to production or the agent picker; see [CLI development](antigravity-cli.md). |
| [`apps/server/src/antigravity`](../apps/server/src/antigravity) | Linux Antigravity CLI ACP transport, isolated configuration and synthetic protocol tests; production lifecycle, durable identity binding and UI integration are not yet implemented. |
| [`apps/server/src/auth`](../apps/server/src/auth) | Access keys, sessions/cookies, passkeys, audit/rate limits, trusted request sources and original request scopes; never log authentication material. |
| [`apps/server/src/claude`](../apps/server/src/claude) | Claude adapter, worker turns, permissions, transcript reading and owned execution. Requires an independently configured runtime. |
| [`apps/server/src/codex`](../apps/server/src/codex) | App-server RPC, turn identity, history/rollout readers, projection, tool details and background work; history failures and execution failures are separate. |
| [`apps/server/src/commands`](../apps/server/src/commands) | Idempotent command receipts, compact/message command observation and queued commands; unconfirmed commands are not blindly replayed. |
| [`apps/server/src/connector`](../apps/server/src/connector) | Node resources, grants, native sessions, file/card sync, Git trees, execution issuers, automation, update/maintenance ports and async request ownership. File operations require scoped roots/grants. |
| [`apps/server/src/copilot`](../apps/server/src/copilot) | Copilot worker/environment, request/stream handling, history, tool-policy and result projection; provider errors do not establish stop proof. |
| [`apps/server/src/diagnostics`](../apps/server/src/diagnostics) | Bounded performance/guarded traces and operational diagnostics. Do not attach unredacted provider requests to public reports. |
| [`apps/server/src/execution`](../apps/server/src/execution) | Independent native-process environments and bounded, redacted diagnostics shared by agent adapters. |
| [`apps/server/src/gateway`](../apps/server/src/gateway) | Gateway RPC, discovery and configured resource/execution integration; addresses and credentials come from private settings. |
| [`apps/server/src/git-status`](../apps/server/src/git-status) | Operator-configured GitHub account definitions and read-only repository status aggregation (pull requests, open issue counts, and GitHub Actions runs) with caching, singleflight and strict URL/slug validation. |
| [`apps/server/src/hermes`](../apps/server/src/hermes) | Hermes execution/history integration; opt-in adapter with separately provisioned native home. |
| [`apps/server/src/hub`](../apps/server/src/hub) | Hub stores/workers, member identity, connection grants, shared sessions, execution continuity, queues, workspace boards/cards/layouts, file binding, browser/research and usage; authorization versions are authoritative. |
| [`apps/server/src/lifecycle`](../apps/server/src/lifecycle) | Drain, pause/resume, independent maintenance and shutdown ownership; elapsed time is not an execution completion certificate. |
| [`apps/server/src/messages`](../apps/server/src/messages) | Message history transfer/stream processing and request-scoped transport; preserve message/tool association. |
| [`apps/server/src/openclaw`](../apps/server/src/openclaw) | OpenClaw native/Gateway integration and history/resource access; no bundled account or provider configuration. |
| [`apps/server/src/projection`](../apps/server/src/projection) | Bounded deck/session/message read projections. A read view is not authorization or execution ownership. |
| [`apps/server/src/refresh`](../apps/server/src/refresh) | Refresh signatures, request merging, revisions and read reconciliation; stale events must not revive a finished turn. |
| [`apps/server/src/routes`](../apps/server/src/routes) | Auth, Hub, Connector/application session, workspace, media, event and terminal HTTP boundaries; inspect route guards and tests before client integration. |
| [`apps/server/src/storage`](../apps/server/src/storage) | Store workers, startup ownership, request persistence and database access boundaries. Use APIs, not direct access to another running instance's databases. |
| [`apps/server/src/system`](../apps/server/src/system) | System/process/resource metrics and platform helpers; metrics are observations, not stop proof. |
| [`apps/server/src/tools`](../apps/server/src/tools) | Tool resources and policy helpers; execution uses the operator's permissions. |
| [`apps/server/src/utils`](../apps/server/src/utils) | HTTP body, paths, redaction and common validation utilities; callers still enforce domain authorization. |

Root modules also contain server configuration, agent/session orchestration,
queues, artifacts/media, voice messages, native files, notebook and terminal
ports. Their HTTP adapters delegate to the domains above. Follow adjacent
`*.test.ts` files for authorization, failure, persistence and recovery examples.

## Browser, contracts and packaging

- [`apps/web/src/components`](../apps/web/src/components): workspace desktop and
  panes, session messages/tools/queues, boards/cards/notes/files, permissions,
  connection settings, authentication and media/terminal views. Recovery controls
  are conditional, not a universal force-unlock operation.
- [`apps/web/src/lib`](../apps/web/src/lib): API clients, request/cache governors,
  event/history/receipt reconciliation, layout/menu intent, source/resource URL
  policy and [bilingual catalog](../apps/web/src/lib/translations.ts). User content
  stays user content; do not translate it as a catalog key.
- [`packages/shared/src`](../packages/shared/src): shared session/message/queue,
  execution/goal, board/card/file and native-resource types, validators and
  transport constants. [`protocol.ts`](../packages/shared/src/protocol.ts) keeps
  product version **1.0.0** separate from Connector protocol range.
- [`apps/android`](../apps/android), [`apps/ios`](../apps/ios),
  [`native/windows`](../native/windows): native web/resource routing, cache,
  media/voice and launcher/install scaffolds. Application IDs use AOD. These are
  not verified release packages; OS signing/distribution is outside source CI.
- [`scripts`](../scripts): isolated source/script/browser test runners, sharding,
  build metadata, install/package checks, publication/security/i18n/API gates and
  source-only upstream ports. Historical CI contracts are inert
  [fixtures](../scripts/fixtures/gitlab-ci.json), not deployment configuration.
- [GitHub CI](../.github/workflows/ci.yml), [optional GitLab test mirror](../.gitlab-ci.yml)
  and [`Dockerfile`](../Dockerfile): source checks and an experimental container
  build. Neither CI file deploys services or publishes artifacts.

## Trace a feature

Start at a component → browser `lib` API client → `routes` or
`application-*-http.ts` → Hub/Connector domain → store or adapter → shared
validators/contracts. Inspect the tests at each boundary; never infer success
from a spinner, a healthy HTTP endpoint or a timeout alone. See
[development](development.md) for focused module test commands.

# API reference and OpenAPI

**English · [简体中文](api.zh-CN.md) · [Documentation](README.md)**

## What is available

The server uses Hono route registration, not a Swagger-first framework. AOD ships
a generated [OpenAPI 3.1 JSON route inventory](api/openapi.json). Import this
**public source document only** into a local Swagger UI/Editor or another OpenAPI
reader. No documentation endpoint is enabled in the live server, no external UI
script is loaded, and no origin or access key is embedded in the document.

This is **not a complete SDK schema**. Each operation links implementation files
and lines via `x-aod-sources`, preserves the original path, and has a deliberately
unspecified response contract. Authentication, role/grant requirements, payloads,
status codes, WebSocket/SSE and IPC frames must be read in those sources and tests.
Do not assume a route is anonymous because the inventory omits `security`.
Do not enable blind “Try it out” against a running production instance.

## Route families

| Family | Implementation and usage |
| --- | --- |
| `/api/auth/*` | [`routes/auth.ts`](../apps/server/src/routes/auth.ts): login/status/logout, passkeys and audit. Login is rate-limited; protected operations require current authorization. |
| `/api/hub/v1/*` | [`routes/hub.ts`](../apps/server/src/routes/hub.ts) and `routes/hub-*.ts`: connections, member/shared grants, sessions/queues/commands, workspace boards/cards/notes/layouts/file bindings, browser/research and usage. Member and machine operations have different scopes. |
| `/api/connector/v1/*` | [`connector`](../apps/server/src/connector): node resources, native runtime sessions, files, execution grants, update/maintenance and automation. Intended for granted Hub/Connector or scoped execution clients, not unrestricted browser access. |
| `/api/workspace-agent/v1/*` | [`routes/workspace-agent.ts`](../apps/server/src/routes/workspace-agent.ts): delegated board machine access. Use a separately scoped capability, not the operator's shared access key. |
| `/api/sessions/*`, message/command and history paths | [`routes`](../apps/server/src/routes) and `application-*-http.ts`: application role facades. Identity, cursors, revision and history-pending semantics vary by runtime. |
| Events, terminal and media/artifacts | [`routes/events.ts`](../apps/server/src/routes/events.ts) and route/media modules: live and streaming resources, resource authority, scoped roots and media access. HTTP inventory does not describe stream frames. |
| Health and system observations | [`application-system-reads-http.ts`](../apps/server/src/application-system-reads-http.ts): health, gateway and system reads. Healthy HTTP does not prove native execution or old-session recovery. |

For types/validators inspect [`packages/shared/src`](../packages/shared/src),
especially [`protocol.ts`](../packages/shared/src/protocol.ts),
[`history-transport.ts`](../packages/shared/src/history-transport.ts),
[`workspace-board.ts`](../packages/shared/src/workspace-board.ts) and the API client
modules under [`apps/web/src/lib`](../apps/web/src/lib). Use the implementation's
existing command IDs, ETags, request scopes and revision checks rather than
inventing a second write/retry system.

## Authentication and safe clients

- Operator login uses the private instance key. Session cookies and configured
  key/Bearer headers are handled by the existing auth layer; endpoint-specific
  member/machine grants remain separate.
- Never put credentials in URL userinfo, query examples, checked-in requests,
  documentation screenshots or generated API JSON. Origin/proxy policy must be
  configured before remote access; see [configuration](configuration.md).
- `outcome_unknown`, receipt uncertainty and history preparation are not permission
  to resend commands. Preserve the original execution identity and inspect existing
  client observation/recovery code.
- Only call a disposable instance when testing integration. Document imports and
  schema validation alone are not end-to-end provider acceptance.

## Update and test

The generator parses static literal/constant/template routes and literal loops.
`x-aod-unresolved-registrations` records unresolved factories/parameters, including
source locations; this is an explicit coverage boundary, not a silent omission.
Registered aliases/role-specific paths can share an operation with multiple sources.
Equivalent templated paths are grouped even when parameter names differ; alternate
original names remain in `x-aod-alternate-raw-paths` and source references.
`x-aod-static-registrations` is a registration count, not unique endpoint count.

```sh
mkdir -p .local
node scripts/api-docs.mjs > .local/openapi.json
pnpm check:api
node scripts/run-script-tests.mjs api-docs.test.mjs
```

Create ignored `.local/` first when necessary. Review the generated file and replace
`docs/api/openapi.json` with the reviewed document. CI fails if it drifts from code.
Future normative request/response schemas should be added at existing route/shared
validation boundaries, with payload and authorization tests; do not fabricate
schemas just to make an interactive explorer appear complete.

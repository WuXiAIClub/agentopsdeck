# Antigravity CLI connector development

**English · [简体中文](antigravity-cli.zh-CN.md) · [Documentation](README.md)**

## Current status

This development work preserves AOD **1.0.0**. The Linux ACP transport,
isolated configuration parser, owned-execution orchestration, Connector runtime
integration and Web UI entry are implemented in `apps/server/src/antigravity/`,
`apps/server/src/connector/`, `apps/server/src/routes/connector.ts`, and
`apps/web/src/`.
Setting `AOD_ANTIGRAVITY_ENABLED=true`, `AOD_ANTIGRAVITY_DEDICATED=true`,
`AOD_ANTIGRAVITY_COMMAND`, `AOD_ANTIGRAVITY_HOME`, and `AOD_ANTIGRAVITY_WORKSPACE`
enables the owner-only `antigravity` runtime in the Connector and Web UI.
Image/text `attachments`, bounded tool output details, context and token usage
metrics (`usage_update` / `session/prompt` `usage`), dynamic model discovery via
`agy models` (with optional `AOD_ANTIGRAVITY_MODEL` default and optional
`AOD_ANTIGRAVITY_MODEL_CHOICES` allowlist override + `session/set_model`),
and workspace board context are supported. Unsupported capabilities (`compact`,
`interactions`) remain disabled and are explicitly rejected with `409`.
No native binaries are shipped.

## Account quota card

On the AOD instance that runs the CLI, open **Layout presets → Antigravity account quota**
in the workspace, or open **Antigravity account quota** from the desktop's tools.
No task board is needed. The standalone card reads `agy --output-format json -p '/usage'`
using the configured AOD Antigravity home, and shows the remaining percentage
and reported reset time for each model group and quota window. The card opens
directly to the model groups (without a duplicate top banner) and places the
quota check timestamp inline on the Gemini Models group header row (falling back
to the first group when Gemini Models is not present). This is account quota,
not per-session token usage or billing. Open the card to check it or use
**Refresh**; the card auto-refreshes every 60 seconds while visible and the
server shares a successful snapshot for up to 30 seconds.

The local administrator endpoint `GET /api/antigravity/usage` does not accept
connector transport grants or a remote connector selector. It returns
`{ "usage": null }` if disabled, `403` if unauthorized, and `503` when quota
cannot be read (for example, sign-in is required or the CLI does not return
structured `/usage` JSON). Responses are not cached by browsers.

## Implemented contracts

- Launch an explicitly configured absolute executable with
  `agy acp --disable-telemetry` (adding `--sandbox` when
  `AOD_ANTIGRAVITY_PERMISSION_MODE=deny`), without a shell.
- Negotiate ACP version 1, then create a session or resume an independently
  verified owned session. Never list or load foreign sessions to recover a turn.
- Require the caller to persist intent before transmitting a prompt. Use only
  one prompt per subprocess; a failed or disconnected delivery is never retried.
- Decode fragmented UTF-8 and newline-delimited JSON-RPC with bounded frames.
  Reject invalid responses, foreign session updates and incompatible versions.
- Control tool permissions via `AOD_ANTIGRAVITY_PERMISSION_MODE` (defaults to
  `allow`, approving ACP `session/request_permission` requests for local file
  and command tools; set `deny` to enable `--sandbox` and cancel permission
  requests). Do not advertise client-side filesystem or terminal capabilities
  and never pass `--dangerously-skip-permissions`.
- Use an allowlisted environment with a dedicated HOME, XDG directories and
  temporary directory. Do not inherit API keys, ADC, provider settings or proxy
  variables. Credentials must be provisioned independently in the dedicated home.
- Require canonical paths, a service-owned `0700` home and private subdirectories.
  The parser is off by default and requires `DEDICATED=true`, absolute `COMMAND`,
  `HOME`, `WORKSPACE`, and a bounded `STARTUP_TIMEOUT_MS`; all names use the
  `AOD_ANTIGRAVITY_` prefix. Windows native execution is not implemented.
- Reuse `PrivateAgentHomeLease` with Antigravity-specific owner and binding
  markers. Bind the dedicated HOME to an exact Connector database and node;
  reject Claude/Copilot homes even after their clean shutdown. Same-boot owner
  markers are never reclaimed automatically; on Linux, an owner marker recorded
  with a prior kernel `boot_id` is reclaimed only when both the persistent
  binding and `nodeId` match the exact owner.
- Gate execution on an immutable AOD session/execution/owner-epoch identity.
  Recheck owned resume bindings after asynchronous setup, bind and persist intent
  before transmission, and reject foreign or late transcript updates.
- Drain the worker before durable terminal settlement and HOME release. Missing
  physical cleanup or failed settlement retains the owner fence. In
  `AntigravitySdkTurn`, verified ACP terminal outcomes and clean
  `AntigravityAcpError` replies settle without wedging the session once
  `stopAndDrain()` proves the process group is empty (`cleaned === true`). Hard
  transport crashes or unconfirmed outcomes remain `unknown` until explicit
  owner-authorized in-process recovery (`POST .../recovery`), which verifies
  cleanup and native binding before releasing the session; cancellation during
  setup or persistence does not manufacture provider stop proof or trigger replay.
- Preserve the Connector's canonical history page order (`sequence`-ordered
  durable transcript rows followed by active stream and queued rows) across Hub
  message proxy, workspace sync, and shared read routes so `before` pagination
  anchors remain valid during long tool-heavy turns and while messages are
  queued. On the Web UI, upward scroll gestures at `scrollTop === 0` (including
  panes whose collapsed tool timelines fit inside the viewport) trigger older
  history loading directly and pause bottom-following to keep reading position.

`assertOwnership` and `persistIntent` are integration boundaries, not an
implemented journal or permission system. ACP cancellation results and
`inspectTransportClosed()` prove neither durable history nor descendant-process
quiescence. CLI permission rules and sandbox behavior are separate from AOD
authorization. This module is not an untrusted-user execution sandbox.

`AntigravityOwnedExecution` coordinates with `AntigravityJournal` (`DatabaseSync`
with `observedSavepoint`) and `AntigravityProcessWorker` (`AntigravityAcpClient`
with process-group drain). The journal atomically fences the exact execution/owner
epoch, enforces owned-session binding, and persists intent before acknowledging it.
Settlement reconciles uncertain intent acknowledgements as `unknown`, remains
monotonic and idempotent for that execution, and rejects stale owners or
conflicting terminal results. No automatic retry is performed on a failed
acknowledgement. An omitted native session ID in an undispatched result never
clears or rebinds an existing durable session.

`AntigravityProcessWorker.stopAndDrain()` provides independent, bounded process-tree
cleanup evidence. `cleaned` permits physical HOME release only after settlement;
`quiescent` additionally requires no forced cleanup before a known terminal
outcome. A raw `AntigravityAcpClient` is deliberately not an execution worker:
its `finished` and `inspectTransportClosed()` cannot fill this evidence port.
Worker allocation failure retains the HOME fence because it does not prove that
no child started. No live database or real provider is used by these tests.

## Remaining acceptance

1. Run harmless live-CLI verification against a separately installed `agy`
   binary with a dedicated `AOD_ANTIGRAVITY_HOME` and `AOD_ANTIGRAVITY_WORKSPACE`.
2. Complete publication review (`pnpm check:review` and `pnpm check:publication`)
   before any public release.

Protocol fixture tests do not authenticate with Google or exercise a real
provider. They cannot establish native compatibility, operational acceptance,
license rights or release approval.

## Verification

Run the existing source runner from the repository root:

```bash
pnpm test:module agent:antigravity
pnpm test:scripts documentation.test.mjs test-modules.test.mjs
```

The fixture launches only a synthetic local executable in temporary directories.
Do not use private business histories, shared credentials or a failed production
session as acceptance inputs.

## Subagent observation compatibility

ACP `tool_call` / `tool_call_update` events for Antigravity subagent tools (`Run invoke_subagent`, `Run define_subagent`, `Run send_message`, `Run manage_subagents`) are projected onto `ChatMessage['codexSubagent']` (`CodexSubagentObservation`) so the Web UI subagent panel can display Antigravity subagent activity alongside Codex.

## Protocol references

- [Google Antigravity CLI ACP](https://antigravity.google/docs/cli/acp)
- [Google Antigravity ACP integration](https://antigravity.google/docs/ide/extensions/acp)
- [ACP version 1 schemas](https://github.com/agentclientprotocol/agent-client-protocol/tree/main/schema/v1)

These are protocol references, not a pinned compatibility matrix or a claim that
third-party source or runtime binaries are distributed with AOD.

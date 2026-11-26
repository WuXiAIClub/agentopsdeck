# Troubleshooting

**English · [简体中文](troubleshooting.zh-CN.md) · [Documentation](README.md)**

Start read-only, with redacted reproduction. Never delete state, replay protected
queues, rotate keys or restart blindly to hide a symptom.

| Symptom | Safe next step |
| --- | --- |
| pnpm missing/wrong version | Check Node requirements; provision pnpm 9.15.0. |
| Native build fails | Check Python/make/C++ and OS support; keep lockfile, redact logs. |
| Frozen install fails | Check package manager and complete source; do not silently regenerate lockfile. |
| Config helper refuses | Existing keys are preserved; use regular `.env`, don't force rotation/overwrite. |
| Explicit config missing | Check absolute `AOD_CONFIG_FILE` and service-account rights; refusal is intentional. |
| Port occupied | Inspect owner read-only; choose unused API port and matching Vite target, don't kill unrelated processes. |
| Compiled UI unavailable | Confirm matching shared/web/server builds; Vite preview is not the production API. |
| Dev API fails | Check API port and `AOD_VITE_API_TARGET`; restart only your disposable dev process if needed. |
| No agents/sessions | Starter adapters are disabled; provision runtime, connection grant and workspace. |
| Login rejected | Check intended instance/key, hostname cookie scope and origins; never disclose keys. |
| Login lockout | Diagnose stale/wrong-instance credentials and rate limiting; don't delete auth records. |
| Container unreachable | Check installation's explicit host/port overrides; `.env` overrides image defaults. |
| Container data denied | Check non-root volume ownership; never reuse another instance's volume. |
| Files/preview absent | Check minimal roots and grants; empty starter allowlists are intentional. |
| Board/note file sync fails | Distinguish app edits from binding authority/state; use supported UI/API, not active SQLite. |

## Session and upstream failures

Upstream HTTP 400/5xx indicates execution/provider failure, not proof the thread
ended, history is complete or background work stopped. Collect only status category,
time and a synthetic example; diagnose request compatibility separately from lifecycle.

1. Confirm connection/agent and distinguish execution failure, history sync failure,
   background activity and unconfirmed outcomes.
2. Once completion, history and no-background-work are proven, the UI may allow a
   next message. For Codex sessions whose finished turn left owned background
   terminals running (`background-work`), explicit user-queued follow-up messages
   are permitted when the thread accepts input while compaction and maintenance
   remain protected; use **Stop background terminals** (`POST .../background-terminals/stop`)
   to terminate owned post-turn terminals without disturbing active turns.
3. If recovery is offered (`POST .../recovery` for Codex, Claude Code, Copilot or
   Antigravity), follow its inspection workflow; SDK in-process recovery requires
   confirmed physical process cleanup (`cleaned`) and releases retained driver
   intents without restarting the Connector. Refusal/409/503 means runtime proof
   is unavailable, not permission to force idle.
4. Preserve accepted/queued receipts; do not resend after lost responses or disconnects.
   Old events must not become evidence of a new run.
5. Preserve `outcome_unknown`; escalate exact-identity observation. Time elapsed,
   empty history and process restarts are not termination proof. On Linux, Codex
   process-group drain escalates from `SIGTERM` to `SIGKILL` after a 10s grace
   period, and `PrivateAgentHomeLease` reclaims stale owner locks across an OS
   reboot only when the recorded kernel `boot_id` differs and the persistent
   binding matches.

A separately authorized new session for a different task is a workaround, not old
session repair. Never automatically repeat a possibly executed business action.
See [user guide](user-guide.md) and [operations](operations.md).

## Safe diagnostics

For an already installed local all-in-one instance:

```sh
node --version
pnpm --version
curl --fail --silent --show-error http://127.0.0.1:8890/api/health
```

Use the configured port if different; health isn't execution/provider acceptance.
Run relevant [development tests](development.md) for source issues, never against
live runtime state. Report version/revision, platform, role, redacted category and
exact steps, not `.env`, databases, native homes, histories, tokens or raw upstream
bodies. Confirm a private contact process before sensitive reports; see [security](../SECURITY.md).

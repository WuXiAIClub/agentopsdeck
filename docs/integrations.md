# Agents and Hub/Connector integrations

**English · [简体中文](integrations.zh-CN.md) · [Documentation](README.md)**

## Execution boundary

Native execution is opt-in. AOD is not a provider subscription, credential broker
or untrusted-user sandbox. Install and authenticate an agent separately through
its supported process; use a dedicated native home, project workspace and OS
account. Never import an existing private instance's configuration/history.
Provider and proprietary runtime terms remain independent of AOD's license.

## Codex adapter configuration

After separately provisioning a compatible native executable, configure private
values in your own `.env` or external server file:

```dotenv
AOD_CODEX_ENABLED=true
AOD_CODEX_HOME=/srv/agentopsdeck/codex-home
AOD_CODEX_DEFAULT_CWD=/srv/agentopsdeck/workspace
AOD_CODEX_APPROVAL_POLICY=on-request
```

These are example absolute paths, not directories the repository has provisioned.
Create and secure them for the service account before use. The command defaults
to `codex` on POSIX and `codex.cmd` on Windows; `AOD_CODEX_COMMAND` overrides it.
Leave model/provider overrides unset to let the native runtime choose its defaults.
Keep actual provider configuration outside source. Provider API keys referenced by
`<AOD_CODEX_HOME>/config.toml` (`env_key`) can be placed in a private
`<AOD_CODEX_HOME>/.env` file (`chmod 600`, owned by the service account) or
forwarded from the service environment by listing their variable names in
`AOD_CODEX_ENV_PASSTHROUGH`.

Accepted approval values are `never`, `on-request` and `untrusted`; the inherited
default is `never`. **Approval policy is not a filesystem sandbox**: the harness
can run with the service account's filesystem access. Use OS/container boundaries
and a narrow trusted workspace; review tool permissions before the first task.
Changing approval policy alone does not make multi-tenant execution safe.

Start in a new synthetic session with a harmless task in a disposable workspace.
Check history, tool result and shutdown/background state. Do not use an original
failed business session as an installation smoke test or automatically replay it.
No pinned native/provider compatibility matrix is claimed for this source draft.

## Other adapters

Starter toggles `AOD_LOCAL_OPENCLAW_CLI`, `AOD_HERMES_ENABLED`,
`AOD_CLAUDE_ENABLED` and `AOD_COPILOT_ENABLED` are false. Merely changing a toggle
does not install a CLI, authenticate it or validate provider compatibility.
OpenClaw gateway integration uses `AOD_OPENCLAW_GATEWAY_WS_URL`,
`AOD_OPENCLAW_GATEWAY_ADMIN_RPC_URL`, `AOD_OPENCLAW_GATEWAY_OWNER_TOKEN` and,
when needed, `AOD_OPENCLAW_GATEWAY_PASSWORD`. Keep them private; a local CLI and
a remote gateway are distinct integration paths.

Adapter-specific optional settings are defined in `apps/server/src/config.ts`
and neighboring `config-*.ts` modules. Review those contracts and licenses before
enabling an adapter; real provider execution is not included in local acceptance.

## Server roles

| `AOD_SERVER_ROLE` | Use |
| --- | --- |
| `all` | Default: local Hub and Connector in one process. Recommended first setup. |
| `hub` | Control plane and web UI; execution is supplied by separately granted Connectors. |
| `connector` | Execution/resource endpoint; not a substitute for the Hub workspace UI. |

Every process needs a unique port, runtime directory and native home. Do not
share an active database, token store or queue between processes.

For a reviewed direct Hub→Connector configuration, the server accepts these
**private** fields:

- Connector: `AOD_CONNECTOR_ENV_ID`, `AOD_CONNECTOR_ENV_LABEL`,
  `AOD_CONNECTOR_BOOTSTRAP_TOKEN` (falls back to its `AOD_ACCESS_KEY`).
- Hub: `AOD_HUB_LOCAL_CONNECTOR_URL`, `AOD_HUB_LOCAL_CONNECTOR_TOKEN`,
  `AOD_HUB_LOCAL_CONNECTION_ID`, `AOD_HUB_LOCAL_CONNECTION_LABEL`.
- Hub vault: `AOD_HUB_VAULT_SECRET`, falling back to the Hub access key.

Provision grants through existing connection/authority workflows, restrict network
access and preserve token/vault state. These field names are configuration reference,
not a claim that multi-host pairing was tested. Do not expose bootstrap tokens in
command arguments or publish example real values. Use all-in-one mode until the
separate deployment has passed its own acceptance.

## Not shipped

The `agentopsdeck-connector` executable and sandbox/reverse-connect image used by
optional blueprints are operator-supplied. There is no corresponding published
npm bootstrap package in this repository. Core server source is the supported
starting point. Windows/Android/iOS sources are scaffolds, not accepted installers.

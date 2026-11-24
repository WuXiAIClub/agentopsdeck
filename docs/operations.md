# Operations and upgrades

**English · [简体中文](operations.zh-CN.md) · [Documentation](README.md)**

This is an operator checklist, not a deployment. No daemon is installed or host
service restarted. Read [security](../SECURITY.md) and [verification scope](validation-1.0.0.md).

## Independent runtime layout

Keep reviewed immutable source/builds separate from private config and mutable
state. Example paths, provisioned separately by your administrator:

```text
/opt/agentopsdeck/releases/<reviewed-revision>/  matching source and build
/etc/agentopsdeck/server.env                   private configuration
/srv/agentopsdeck/data/                        databases, queues and state
/srv/agentopsdeck/codex-home/                  optional native home
/srv/agentopsdeck/workspace/                   permitted project workspace
```

Use a dedicated non-root account. Inventory additional native homes, delegated
files and project directories outside the data root. Never bootstrap from another
live instance's state. A future local instance and GitHub/GitLab mirror should
use the same reviewed immutable AOD commit, with runtime settings outside it.

After building and provisioning a complete external config, a foreground server
can be started from its release root:

```sh
AOD_CONFIG_FILE=/etc/agentopsdeck/server.env node apps/server/dist/index.js
```

The example file must exist, containing the private key, independent paths and
disabled/explicitly configured adapters. This is not an instruction to modify an
existing production service. A service manager needs separately reviewed account,
unit, working directory, environment and shutdown policy; no automatic service
installer/updater is supplied by this draft.

## Remote access checklist

- Prefer loopback plus an operator-controlled TLS reverse proxy. Never expose
  development or preview listeners as production endpoints.
- Set `AOD_PUBLIC_BASE_URL`, exact allowed origins and only your own trusted
  proxy addresses; do not trust arbitrary clients' forwarded headers.
- Preserve authentication, streaming responses and WebSocket upgrades where used;
  do not log keys or credential cookies.
- Separate independent authenticated instances by hostname. Restrict network
  access and review filesystem/resource grants.
- Rebuild when build-time resource origins change; verify assets, login,
  streaming, reconnect and permission denial from every real origin.

No universal production-tested proxy configuration is claimed. Review passkey,
secure-context and actual network/proxy behavior separately.

## Backup and restore

1. Inventory data, per-file overrides, native homes, delegated files and workspaces;
   include configured roots outside the default directory.
2. Obtain maintenance authorization, pause new admissions through existing
   workflows and prove exact execution completion plus background-work state.
   Unknown outcomes remain protected; no visible sessions is not idle proof.
3. If an agent is hosted by the service being maintained, stop/start only through
   an independent external maintenance unit; never directly stop your own host.
4. After verified shutdown, take and verify a consistent backup of all configured
   roots, private settings, secrets and matching code/build metadata. Keep it
   encrypted/access-restricted outside Git. Opening/copying a live SQLite file
   is not a consistent backup procedure.
5. Test restore in an isolated execution-disabled instance with no upstream task
   replay. Preserve vault secrets and grants; restored protected queues must not
   automatically resubmit work.

Backups can contain provider credentials and business histories. Never attach
them to public issues or ship them with source.

## Upgrade or roll back

- Prepare a separate candidate at the reviewed AOD revision; use the lockfile,
  build and run publication/docs/targeted tests, recording actual evidence.
- Preserve external config, native homes and queues. Never initialize over existing
  keys; validate migrations on offline disposable copies.
- Obtain independent maintenance/idle proof and back up before switching matching
  code and build together. Never pair new API code with stale web assets.
- Verify version/revision, login, origins/assets, grants, file sync and native/session
  recovery as applicable. HTTP health alone is not whole-system acceptance.
- On failure, never blindly rerun one-shot controllers or overwrite new work with
  old state. Prove data compatibility and execution outcomes before an authorized
  rollback; restore matching code/data when required.

1.0.0 remains a source draft until rights, artifact notices, authorized clean
commits and deployment acceptance are complete. A publication scan is heuristic,
not legal or production approval.

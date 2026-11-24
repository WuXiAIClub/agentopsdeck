# Configuration / 独立实例配置

**English · [简体中文](configuration.zh-CN.md) · [Documentation](README.md)**

Start with [installation](installation.md); never share another instance's active state.

## Defaults

| Setting | AOD default |
| --- | --- |
| API | `127.0.0.1:8890` |
| Web development | `127.0.0.1:5180`, strict port |
| Data (Linux/macOS) | `${XDG_DATA_HOME:-$HOME/.local/share}/agentopsdeck` |
| Data (Windows) | `%LOCALAPPDATA%/agentopsdeck` (profile fallback) |
| Codex home | `<AOD_DATA_DIR>/codex-home` |
| Workspace | `<AOD_DATA_DIR>/workspace` |
| OpenClaw home | `<AOD_DATA_DIR>/openclaw-home` |
| Codex / local OpenClaw CLI | Disabled unless explicitly enabled |
| Hermes / Claude / Copilot | Existing opt-in adapter rules |

The existing Hub/Connector API and protocol headers remain wire compatible.
AOD authentication uses `agentopsdeck_session`, `agentopsdeck_access` and
`x-agentopsdeck-key`. These identifiers are shared by AOD instances; their names
alone do not isolate two deployments.
Browser locale/cache identifiers are separate too. Isolate instances by origin/port;
cookies are not port-scoped, so use
distinct hostnames or separate browser profiles when authentication instances
share a hostname. Do not expose multiple unrelated same-host authenticated
instances without explicitly reviewing their cookie boundaries.

State filenames use `.agentopsdeck-*` under the data directory. Explicit per-file
overrides still work and are private configuration; never share active databases.
`AOD_PORT` takes precedence over generic `PORT`. Only documented `AOD_*` app
variables configure AOD. Native gateway credentials use
`AOD_OPENCLAW_GATEWAY_*` rather than inherited `OPENCLAW_GATEWAY_*`.

Only the AOD repository root `.env` is auto-loaded. The server does not search
arbitrary parent directories. Set an absolute external `AOD_CONFIG_FILE` for a
server-only production config; a missing explicit file fails closed. Process
environment takes precedence. Vite reads root `.env` only; configure its allowed
public resource origins separately when using an external server config.

## Common settings

| Variable | Meaning |
| --- | --- |
| `AOD_PORT` | API/compiled web port; default `8890`. |
| `AOD_LISTEN_HOST` | Listening IP; default `127.0.0.1`, not a hostname. |
| `AOD_SERVER_ROLE` | `all`, `hub` or `connector`; default `all`. |
| `AOD_ACCESS_KEY` | Private access/bootstrap key; initialize with the helper, never commit it. |
| `AOD_CONFIG_FILE` | Explicit external server dotenv file; use an absolute path. |
| `AOD_DATA_DIR` | Independent absolute non-root state directory. |
| `AOD_PUBLIC_BASE_URL` | Canonical external HTTP(S) base URL. |
| `AOD_ALLOWED_ORIGINS` | Comma-separated allowed origins; not an authentication bypass. |
| `AOD_AUTH_TRUSTED_PROXIES` | Trusted proxy addresses; only trust your own proxies. |
| `AOD_HUB_VAULT_SECRET` | Hub secret, defaulting to the access key; preserve across upgrades. |
| `AOD_VITE_API_TARGET` | Development API target; default `http://127.0.0.1:8890`. |
| `AOD_VITE_ALLOWED_HOSTS` | Explicit development host allowlist; do not expose Vite publicly. |
| `AOD_WEB_RESOURCE_ORIGINS` | Web resource origins, read during Vite build/dev. |

Example independent local instance (private key configured separately):

```dotenv
AOD_SERVER_ROLE=all
AOD_LISTEN_HOST=127.0.0.1
AOD_PORT=8890
AOD_DATA_DIR=/srv/agentopsdeck/data
AOD_CODEX_HOME=/srv/agentopsdeck/codex-home
AOD_CODEX_DEFAULT_CWD=/srv/agentopsdeck/workspace
AOD_OPENCLAW_HOME=/srv/agentopsdeck/openclaw-home
AOD_CODEX_ENABLED=false
AOD_LOCAL_OPENCLAW_CLI=false
AOD_HERMES_ENABLED=false
AOD_CLAUDE_ENABLED=false
AOD_COPILOT_ENABLED=false
```

Provision those example directories for the service account; these docs do not
create privileged paths. Generate the private key with the installation helper
before moving the configuration outside source. Preserve vault/auth secrets with
existing data; do not rotate keys to bypass decryption or login failures.

Changing the development API port also requires `AOD_VITE_API_TARGET`. Changing
web resource origins requires rebuilding compiled web assets. The root `.env`
remains a regular ignored file; external server config does not configure Vite.

## File and preview access

`AOD_FILE_ROOTS_JSON` maps agent IDs to specific absolute project directories,
for example `{"main":"/srv/agentopsdeck/projects/demo"}`. Provision directories
and grants separately; filesystem roots and the user home itself are rejected.
`AOD_FILE_LOCAL_WRITE` is a separate opt-in.

`AOD_SOURCE_PREVIEW_ROOTS` is a JSON array of approved preview roots. Artifact
and media access use `AOD_ARTIFACT_ALLOWED_DIRS`,
`AOD_ARTIFACT_ALLOWED_DIRECT_CHILD_DIRS` and `AOD_MEDIA_BRIDGE_ALLOWED_DIRS`.
Starter allowlists are empty. Scope to specific projects, not all of `/srv` or
another application's state. These settings do not bypass Hub grants or OS rights.
Read the source parsers before using complex policies.

Inbound attachments are bound to `AOD_DATA_DIR/media/inbound`, not a provider's
ambient home. POSIX private media directories require the current owner and
mode `0700`; persisted files use `0600`. Provision or review existing directories
explicitly rather than silently repairing another instance's storage. File
browsing uses the startup configuration's native root and explicit
`AOD_OPENCLAW_CONFIG_FILE`, not inherited native configuration.

The optional local OpenClaw CLI still requires `AOD_LOCAL_OPENCLAW_CLI=true`.
Its configured private home must already exist and be distinct from ambient
provider homes, source and workspace roots. `AOD_OPENCLAW_CLI_PATH` selects an explicitly
trusted executable; otherwise only the controlled runtime search path is used.
Native launches do not inherit parent credentials or arbitrary runtime settings.

## Opt-in Codex

Provision a fresh native home and workspace outside the repository, authenticate
with the native runtime's supported workflow, then set private values:

```dotenv
AOD_CODEX_ENABLED=true
AOD_CODEX_HOME=/srv/agentopsdeck/codex-home
AOD_CODEX_DEFAULT_CWD=/srv/agentopsdeck/workspace
```

Do not copy another instance's credential files or history. Do not commit provider
model IDs, endpoints or private adapter settings merely because they are not passwords.
The inherited default trusted Codex approval policy is `never`; choose a narrower
policy/workspace for your threat model before enabling execution.

Approval policy is not a filesystem sandbox. See [integrations](integrations.md)
for execution boundaries, other adapters and split server roles.

## Container source build

No public AOD registry image is assumed. Build the local source image explicitly:

```sh
docker build -t agentopsdeck:1.0.0 .
```

See [installation](installation.md) for local-only publishing, persistent volumes
and required environment overrides.

This source image is not the optional sandbox reverse-connect image. The image
runs the all-in-one server by default; set
`AOD_SERVER_ROLE=connector` when using a separate Hub. Mount private runtime data
separately and configure adapters yourself. Container runtime and native tool
behavior still require separate acceptance.

The inherited reverse-connect and ephemeral Docker sandbox blueprints require an
operator-provided `agentopsdeck-connector` executable and a separately built local
`agentopsdeck-connector:1.0.0` image. That executable is **not shipped in this
repository or published to npm**. Do not treat generated blueprint commands as
a supported bootstrap path. The Dockerfile snippets intentionally require that
executable in their build context and fail without it; they do not download a
private/nonexistent Connector package. Use the core server's existing direct
Hub/Connector connection configuration for the 1.0.0 source instance.

## Optional browser-stream helper

`scripts/playwright-browser-stream-daemon.mjs` is experimental and not started by
the server or CI. Supply `AOD_CHROMIUM_EXECUTABLE` as an absolute executable path.
Commands/frames default to `browser-stream/` under the private `AOD_DATA_DIR`
(or the independent XDG/home data directory), never an existing release/worktree.
`AOD_BROWSER_STREAM_CMD_FILE` overrides the command file;
`AOD_BROWSER_STREAM_OUTPUT_DIRS` is an optional JSON array of absolute directories.
`AOD_BROWSER_STREAM_LANGUAGE` accepts `en` (default) or `zh-CN`.
Only configuration is regression-tested; browser execution is not validated.
Restrict OS access to command/frame directories; do not expose the raw helper to
untrusted users. Its browser flags and navigation are not a security sandbox.

## 中文

AOD 的端口、数据目录和原生 HOME 均与其他实例分离。只使用 `AOD_*`
应用变量；原生智能体默认关闭，必须显式开启并配置专属凭据与工作区。
`.env` 只读取 AOD 仓库根目录，不向父目录查找。生产配置可通过绝对路径
`AOD_CONFIG_FILE` 指向仓库外文件。浏览器 Cookie 不按端口隔离，两个实例
需要不同主机名或独立浏览器配置；共享主机名的认证边界需另行审查。
容器镜像必须自行从当前源码构建，不能假设已存在公开的 1.0.0 镜像。
反向连接与临时沙箱是保留的蓝图，依赖自行提供的适配器；本仓库不提供该 CLI，
不能将其视为已可用的安装入口。默认 Android 源码不含任何 LAN 白名单。

# AgentOpsDeck (AOD)

**English · [简体中文](README.zh-CN.md)**

A bilingual, self-hosted operations deck for agent sessions. AgentOpsDeck 1.0.0
starts from a source-only predecessor snapshot, with a new Git history
and isolated application configuration. This repository is a **pre-publication
source draft**; see [license status](LICENSE-STATUS.md) before distributing it.

**Release blocked:** the [detailed source audit](docs/open-source-review-1.0.0.md)
records unresolved risks and incomplete semantic coverage despite clean dependency audits.

**Start here:** [Install](docs/installation.md) · [User guide](docs/user-guide.md) ·
[Configuration](docs/configuration.md) · [All documentation](docs/README.md)

## Website and contact

- Official website: [agentopsdeck.com](https://agentopsdeck.com)
- Project contact: [AOD@wuxiaiclub.com](mailto:AOD@wuxiaiclub.com)

## Included

- Hub / Connector / all-in-one server roles, a responsive React PWA, and English / Simplified Chinese UI.
- Session history, messages and tool timelines, queues, workspace boards, notes, files and permissions.
- Existing execution-identity recovery, history synchronization and unknown-outcome protections.
- Opt-in native agent adapters; no provider accounts, credentials, histories or local workspaces are included.

Core packages, protocol headers, cookies and Connector tokens use the independent
AOD namespace; remaining isolation and acceptance gaps are tracked in the audit.
Selective upstream patches require normalization and review;
all core product manifests and the shared version are **1.0.0**.
Android / iOS / Windows source scaffolds remain available, but are not validated
or released as AgentOpsDeck native installers in 1.0.0.

## Quick start (development)

Use a reviewed source checkout/archive and run commands from its root. There is
no public clone URL or prebuilt installer promised yet. Linux source startup is
verified; other platforms and containers require separate acceptance.

Requirements: Node.js 22.13 or newer, pnpm 9.15.0, and a C++ build toolchain for
the existing terminal dependency. Native runtimes are optional and installed separately.

```sh
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile --prod=false
```

Generate a fresh access key into the ignored `.env` file, without printing it:

```sh
node scripts/create-local-config.mjs
pnpm dev
```

The helper uses `.env.example` when needed, preserves existing settings and
refuses to replace a nonempty key. Do not overwrite an existing `.env`. Retrieve
the key only in a private local editor for login; never include it in support logs.

Concurrent generators are refused using an exclusive `.env.aod-config.lock`.
If a process is killed, inspect the lock privately and remove it only after
confirming no generator is active; the helper never steals an existing lock.

Open the web development server on `127.0.0.1:5180`; the API listens on
`127.0.0.1:8890`. Use your private local key when logging in.
This command starts a development instance, not a system service.

For a compiled all-in-one instance:

```sh
pnpm --workspace-concurrency=1 -r build
pnpm --filter @agentopsdeck/server start
```

The server serves the built web assets using the existing application runtime.
See [configuration](docs/configuration.md) before enabling adapters or remote access.
Switch UI language using the existing language selector; browser language is used
when no explicit `en` / `zh-CN` preference is stored.

For detailed prerequisites, health verification and an experimental local Docker
example, follow [installation](docs/installation.md). This repository does not
install a daemon or modify existing services.

## Architecture and safe operation

```text
Browser → Hub (sessions, workspace, permissions)
              → Connector (configured resources and native agents)
```

The default `all` role runs Hub and Connector together. Separate deployments need
independent state, grants and acceptance; see [integrations](docs/integrations.md).
Native execution is opt-in and runs with the operator's permissions, not as an
untrusted-user sandbox. Credentials, native homes and history stay outside source.

Execution failure, history-sync failure and background work are different states.
Recovery never treats elapsed time as stop proof or replays `outcome_unknown`
work. Read [user guide](docs/user-guide.md), [troubleshooting](docs/troubleshooting.md)
and [operations](docs/operations.md) before maintaining an active instance.

## Validation

```sh
pnpm check:publication
pnpm check:i18n
pnpm --filter @agentopsdeck/shared build
node scripts/run-source-tests.mjs server config-agentopsdeck.test.ts config-portability.test.ts connector/version.test.ts
node scripts/run-source-tests.mjs web lib/i18n.test.ts
node scripts/run-script-tests.mjs documentation.test.mjs publication-check.test.mjs upstream-patch.test.mjs write-build-info.test.mjs create-local-config.test.mjs
pnpm --workspace-concurrency=1 -r build
```

The repository retains its isolated test runners. [GitHub CI](docs/ci.md) is the
primary source-test pipeline; an optional portable GitLab mirror is included.
Neither deploys, uploads release artifacts or accesses local credentials.
Remote CI success is not implied by local tests.

For implementation-level navigation, read the [module map](docs/modules.md),
[API / OpenAPI guide](docs/api.md), [security review](docs/security-review.md) and
[English/Chinese guidance](docs/i18n.md). The OpenAPI inventory is generated from
code; it deliberately does not claim complete payload or authorization schemas.

See [development](docs/development.md) for documentation tests, exact test selectors
and full-suite boundaries; [validation](docs/validation-1.0.0.md) records actual runs.

## License

AgentOpsDeck-owned code is licensed under [Apache-2.0](LICENSE). Third-party code
and assets retain their own licenses and notices. Public distribution still
requires inherited-source rights confirmation and artifact-notice review;
see [license status](LICENSE-STATUS.md).

## Contributing and publication

- [English / 中文 contribution guide](CONTRIBUTING.md)
- [Documentation index](docs/README.md)
- [Security and privacy](SECURITY.md)
- [Configuration and separate instances](docs/configuration.md)
- [History-free upstream ports and GitHub/GitLab synchronization](docs/upstream-sync.md)
- [1.0.0 extraction scope](docs/release-1.0.0.md)
- [Local validation and unverified boundaries](docs/validation-1.0.0.md)

No GitHub remote, authentication, initial commit, release tag or deployment is
created by the source extraction. A maintainer must confirm redistribution rights,
third-party compliance and the publication destination before the first public push.

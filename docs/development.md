# Development and documentation

**English · [简体中文](development.zh-CN.md) · [Documentation](README.md)**

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | React PWA, workspace UI and bilingual translations. |
| `apps/server` | Hub/Connector, auth, queues, adapters and projections. |
| `packages/shared` | Shared protocol, product version and build metadata. |
| `scripts` | Existing test runners, publication and upstream-port tools. |
| `docs` | Public setup, usage and release boundaries. |
| `.github/workflows` | Source CI; no automatic deployment or private credentials. |

Use `@agentopsdeck/*` and AOD protocol identifiers consistently; incoming upstream
patches must be normalized. Do not confuse third-party versions with AOD product
version. See the [module map](modules.md), [API reference](api.md),
[i18n guide](i18n.md) and [CI](ci.md). Native sources are scaffolds.

Normal builds generate provenance only; they never infer or rewrite product
versions from Git tags or mismatched package versions. Keep the four manifests
and shared protocol version aligned through an explicitly reviewed release
change. `syncWorkspaceVersion` is an opt-in utility, not a build hook.

## Workflow

1. Read [contributing](../CONTRIBUTING.md), [security](../SECURITY.md) and scoped `AGENTS.md`.
2. Follow [installation](installation.md); ignore private `.env`, use independent dev state.
3. Change existing components/services minimally, not parallel recovery/menu/queue
   systems. Preserve keyboard, focus, touch and accessibility.
4. Keep English/Chinese UI and docs aligned; describe config and unsupported boundaries.
5. Run targeted tests then broader checks as needed; report actual scope, not inferred
   production acceptance from fixtures.

## Validation commands

From repository root after dependencies are installed:

```sh
pnpm check:publication
pnpm check:i18n
pnpm --filter @agentopsdeck/shared build
node scripts/run-script-tests.mjs documentation.test.mjs publication-check.test.mjs create-local-config.test.mjs upstream-patch.test.mjs write-build-info.test.mjs
node scripts/run-source-tests.mjs server config-agentopsdeck.test.ts config-portability.test.ts connector/version.test.ts
node scripts/run-source-tests.mjs web lib/i18n.test.ts
pnpm --workspace-concurrency=1 -r build
```

Source selectors are exact paths relative to the chosen server/web source tree;
script selectors are exact paths relative to `scripts`. Omit selectors only for
deliberate full-suite work:

```sh
node scripts/run-source-tests.mjs web
node scripts/run-script-tests.mjs
```

Targeted success is not full-suite success. Full backend, browser E2E, real providers,
Docker/native and remote CI need separate planning. `pnpm typecheck` and `pnpm lint`
also exist. Do not add a new framework/formatter just for docs.

## Documentation maintenance

Update both languages and navigation tables. Use relative links, actual commands,
synthetic paths and no secrets. `documentation.test.mjs` checks local Markdown
targets, guide pairing and selected setup/config contracts. It doesn't verify
external sites, execute every command or certify containers/providers.

## Commits and publication

AOD starts without inherited history; later changes use reviewed patches from
[upstream synchronization](upstream-sync.md). Never merge private refs, copy local
settings, alter other worktrees or overwrite AOD versions/isolation.

Initial maintainer identity is repo-local `WuXiAIClub <hi@wuxiaiclub.com>`; contact
is `AOD@wuxiaiclub.com`. Preserve third-party attribution. Commit/push/tag/deploy
only under explicit authorization. GitHub and optional GitLab must publish the same
reviewed AOD commit, not private histories.

Confirm rights and final artifact notices before authorized publication, then run
`pnpm check:publication:release` on clean committed source. Scanning cannot approve
licensing, prove absolute secret absence or certify deployment. See [license status](../LICENSE-STATUS.md)
and [validation](validation-1.0.0.md).

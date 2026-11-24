# Technology stack and package review

**English · [简体中文](technology-stack.zh-CN.md)**

Snapshot: November 22, 2026, AgentOpsDeck 1.0.0. Versions below are this
checkout's frozen-lock resolutions, **not a claim to use every upstream's latest
release**. The [module map](modules.md) provides implementation navigation; the
[review standard](open-source-review-standard.md) defines approval evidence.

## Architecture

- ESM TypeScript monorepo: pnpm 9.15.0, four private manifests, three workspace
  packages under apps and packages. Private means not npm-publishable, not that
  the source cannot be distributed under its applicable licenses.
- Node minimum 22.13.0; validation/hosted CI uses 22.22.1; TypeScript 5.9.3,
  tsx 4.22.4 and Prettier 3.8.4. Lint scripts run TypeScript checks, not a
  separate ESLint security analysis.
- Server: Hono 4.13.20 and Node adapter 2.1.11, native Node SQLite storage,
  async/worker boundaries, HTTP/WebSocket/stream transport. SQLite is experimental
  on the validated Node 22 runtime; suppressed experimental startup warnings
  do not make its API stable.
- Authentication: access/session keys, explicit authority/grants and issuer
  versions, SimpleWebAuthn/passkeys. Hub manages workspace/session/permission
  state; Connector controls configured resources; the all role combines both.
- Browser: React/ReactDOM 19.2.7, Vite 6.4.6, Tailwind 4.3.1, TipTap 3.31.3
  and ProseMirror, xterm 6.0.0, Markdown renderers, Lucide icons and QR codes.
  Responsive PWA with English/Simplified Chinese; built assets are served by the
  application, not by a Vite development server in production.
- Shared package: typed protocol, version/build information and resource/limit
  contracts. There is no additional independently deployed shared service.
- Optional integrations: external agent/provider runtimes configured separately,
  disabled by default; node-pty 1.1.0 requires native toolchains, and
  playwright-core 1.63.0 does not bundle an accepted browser installation.
- Android Java/Gradle, iOS Swift and Windows C/PowerShell/installer sources are
  scaffolds, not accepted 1.0.0 native releases. Docker is experimental.
- Tests use the existing isolated Node test runners; GitHub hosted/read-only CI
  is source-test-only. No local result means a GitHub workflow has already run.

## Manifest review decision

**Dependency advisory gate: passed at this snapshot. Full publication approval:
not granted.** Fresh production and development-inclusive registry audits both
reported zero advisories at all severities. This detects known advisories, not
all vulnerable code, compromised packages, license issues or environment leaks.

All four manifests agree on product 1.0.0 and Apache-2.0 metadata. Workspace links
remain local package links; frozen installation/build/typecheck passed in the
previous remediation round. The major Node-adapter change has real ephemeral
HTTP path/auth/cookie/stream regressions. Six parent-scoped compatible overrides
constrain vulnerable transitive fallback; no audit exemptions were introduced.

Review caveats:

- Vite, its React plugin, Tailwind and its Vite plugin are declared in the web
  runtime dependencies even though they participate in build/development. This
  inflates production installs/audit scope; reclassification needs a reviewed
  lockfile change and build/container regression, not a silent blanket update.
- Docker copies the complete build workspace, retains development dependencies
  and uses a floating Node base tag. No image/digest/OS/SBOM acceptance exists.
- Frozen locks cover JS resolutions, not separately installed native runtimes,
  browsers, platform package managers or every platform-specific optional binary.
- Passing signature scans is not proof that no secret exists. Inherited-source
  rights, asset provenance and final third-party notices remain publication gates.

## Every direct declaration

The placement column reflects the code **as declared**, not a recommendation.
Caret ranges permit updates within the stated major; reproducibility comes from
frozen installation and reviewed lock changes, not from the ranges alone.

| Workspace | Package | Declared | Locked/installed | Placement |
| --- | --- | --- | --- | --- |
| `agentopsdeck` | `@types/node` | `^22.10.2` | `22.19.21` | `devDependencies` |
| `agentopsdeck` | `prettier` | `^3.4.2` | `3.8.4` | `devDependencies` |
| `agentopsdeck` | `typescript` | `^5.7.2` | `5.9.3` | `devDependencies` |
| `@agentopsdeck/server` | `@agentopsdeck/shared` | `workspace:*` | `link:../../packages/shared` | `dependencies` |
| `@agentopsdeck/server` | `@hono/node-server` | `^2.1.3` | `2.1.11` | `dependencies` |
| `@agentopsdeck/server` | `@simplewebauthn/server` | `^13.3.2` | `13.3.3` | `dependencies` |
| `@agentopsdeck/server` | `hono` | `^4.13.16` | `4.13.20` | `dependencies` |
| `@agentopsdeck/server` | `nanoid` | `^5.1.16` | `5.1.16` | `dependencies` |
| `@agentopsdeck/server` | `node-pty` | `1.1.0` | `1.1.0` | `dependencies` |
| `@agentopsdeck/server` | `playwright-core` | `1.63.0` | `1.63.0` | `dependencies` |
| `@agentopsdeck/server` | `ws` | `^8.18.0` | `8.21.0` | `dependencies` |
| `@agentopsdeck/server` | `@types/ws` | `^8.5.13` | `8.18.1` | `devDependencies` |
| `@agentopsdeck/server` | `tsx` | `^4.19.2` | `4.22.4` | `devDependencies` |
| `@agentopsdeck/server` | `typescript` | `^5.7.2` | `5.9.3` | `devDependencies` |
| `@agentopsdeck/web` | `@agentopsdeck/shared` | `workspace:*` | `link:../../packages/shared` | `dependencies` |
| `@agentopsdeck/web` | `@simplewebauthn/browser` | `^13.3.0` | `13.3.0` | `dependencies` |
| `@agentopsdeck/web` | `@tailwindcss/vite` | `^4.3.1` | `4.3.1` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/extension-image` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/extension-table` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/extension-task-item` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/extension-task-list` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/markdown` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/pm` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/react` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@tiptap/starter-kit` | `^3.31.3` | `3.31.3` | `dependencies` |
| `@agentopsdeck/web` | `@vitejs/plugin-react` | `^4.3.4` | `4.7.0` | `dependencies` |
| `@agentopsdeck/web` | `@xterm/addon-fit` | `0.11.0` | `0.11.0` | `dependencies` |
| `@agentopsdeck/web` | `@xterm/xterm` | `6.0.0` | `6.0.0` | `dependencies` |
| `@agentopsdeck/web` | `class-variance-authority` | `^0.7.1` | `0.7.1` | `dependencies` |
| `@agentopsdeck/web` | `clsx` | `^2.1.1` | `2.1.1` | `dependencies` |
| `@agentopsdeck/web` | `lucide-react` | `^1.21.0` | `1.21.0` | `dependencies` |
| `@agentopsdeck/web` | `marked` | `17.0.6` | `17.0.6` | `dependencies` |
| `@agentopsdeck/web` | `qrcode.react` | `4.2.0` | `4.2.0` | `dependencies` |
| `@agentopsdeck/web` | `react` | `^19.0.0` | `19.2.7` | `dependencies` |
| `@agentopsdeck/web` | `react-dom` | `^19.0.0` | `19.2.7` | `dependencies` |
| `@agentopsdeck/web` | `react-markdown` | `^10.1.0` | `10.1.0` | `dependencies` |
| `@agentopsdeck/web` | `remark-gfm` | `^4.0.1` | `4.0.1` | `dependencies` |
| `@agentopsdeck/web` | `tailwind-merge` | `^3.6.0` | `3.6.0` | `dependencies` |
| `@agentopsdeck/web` | `tailwindcss` | `^4.3.1` | `4.3.1` | `dependencies` |
| `@agentopsdeck/web` | `vite` | `^6.4.4` | `6.4.6` | `dependencies` |
| `@agentopsdeck/web` | `@types/react` | `^19.0.2` | `19.2.17` | `devDependencies` |
| `@agentopsdeck/web` | `@types/react-dom` | `^19.0.2` | `19.2.3` | `devDependencies` |
| `@agentopsdeck/web` | `typescript` | `^5.7.2` | `5.9.3` | `devDependencies` |

## Important transitive constraints

PostCSS 8.5.33; NanoID 3.3.20 in PostCSS (distinct from server NanoID 5.1.16);
Browserslist 4.29.6; baseline-browser-mapping 2.11.39; source-map-js 1.2.4.
Do not collapse NanoID 3 and 5 into an incompatible global override.

## API, docs and boundaries

The generated OpenAPI 3.1 file is a static route inventory: 481 registrations,
325 canonical paths and 137 unresolved registrations at the previous verified
snapshot. It is not a complete payload/auth/stream schema or a live Swagger UI.
There are 394 dynamic translation calls beyond the literal-catalog check.
Provider, physical browser/touch, macOS/Windows, native, HTTP2/TLS and container
paths need separate acceptance. See the [API guide](api.md), [CI guide](ci.md),
[license status](../LICENSE-STATUS.md) and [validation record](validation-1.0.0.md).


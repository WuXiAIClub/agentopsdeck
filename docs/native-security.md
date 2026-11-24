# Native security and release boundaries

**English · [简体中文](native-security.zh-CN.md) · [Documentation](README.md)**

AOD core remains **1.0.0**. Native directories are development scaffolds, not
approved installers. Wrapper versions are independent; future releases must seal
the wrapper version, exact core commit, dependency locks, byte manifest and notices
together. Renaming an old artifact does not establish install/upgrade acceptance.

## Independent Windows launch

The desktop retains an explicit OS environment allowlist. Arbitrary parent AOD,
provider and Node settings are not imported. State, native HOME and temporary
directories are independent; linked runtime directories and unsafe access-key
files are rejected. This is application isolation, not an OS sandbox. Windows ACL
and junction behavior still require platform acceptance.

`AOD_DATA_DIR`, `AOD_PORT` and an owned empty `desktop-server.env` are explicitly
bound. Only validated fields from the desktop's private state `.env` are passed
to the server; unrecognized settings are not loaded as defaults. Conflicting
`PORT`/`AOD_PORT` values are rejected. Native providers default to disabled.
Codex requires an intentionally saved external workspace, not a parent override.
Claude's non-secret `AOD_CLAUDE_API_KEY_FILE` path is an explicit native setting;
key contents never belong in source, UI, logs or reports.

## Fail-closed dependency installation

Missing reviewed inputs return `reviewed-dependency-plan-required`; there is no
floating Codex or unversioned winget fallback. This is a deliberate refusal,
not an installed dependency. Future sealed SDK/Codex inputs must supply private
`package.json`/`package-lock.json` under `native-dependency-locks/sdk` or
`native-dependency-locks/codex`: one exact direct version, exact external lock
versions, SHA-512 integrity and credential-free HTTPS registry URLs.
The validator checks shape, not rights, vulnerability absence or vendor signature.
Installation uses `npm ci`, auditing enabled, scripts disabled and a version check.
Node/Git need separately reviewed immutable installers; none is supplied here.

## Unverified platform and rights boundaries

Authenticated downloads need device acceptance for redirects, identity changes,
cancellation, cleanup, concurrency and actual bytes. Source tests do not prove
WebKit, DownloadManager or filesystem behavior. Native EN/zh-CN, accessibility,
permissions, install/upgrade/uninstall and final artifact notices remain separate
gates. Inherited icons, video and binaries require origin, author, license,
modifications and redistribution evidence; hashes/formats do not prove rights.
See [license status](../LICENSE-STATUS.md) and [the audit](open-source-review-1.0.0.md).
Source repairs do not authorize native builds, signing, installer execution,
deployment or publication.

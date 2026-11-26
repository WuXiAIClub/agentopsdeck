# Installation from source

**English · [简体中文](installation.zh-CN.md) · [Documentation](README.md)**

## 1. Requirements and scope

- Node.js **22.13.0 or newer**, as declared in `package.json`.
- pnpm **9.15.0**, matching `packageManager` and the lockfile.
- Python 3, make and a C++ compiler for the `node-pty` native dependency.
- A browser and a writable, independent runtime data directory.

Linux source builds and isolated startup were verified locally. macOS, Windows,
WSL, Docker, native wrappers and actual provider execution are not release-tested;
see [the validation record](validation-1.0.0.md). Shell examples below use a
POSIX shell. The Windows native source scaffold is not an AOD installer.

For Debian/Ubuntu, build prerequisites can be installed by an administrator:

```sh
sudo apt-get update
sudo apt-get install -y python3 make g++
```

Install Node.js through your platform's trusted installation process. Do not run
the application as root. On other systems, provide equivalent build tools rather
than assuming the Linux command applies.

## 2. Obtain the source

Use a reviewed source checkout or archive supplied by the maintainer. At this
stage no public clone URL, npm application package or registry image is promised.
Enter its root (replace the example path):

```sh
cd /path/to/agentopsdeck
node --version
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm --version
pnpm install --frozen-lockfile --prod=false
```

If Corepack is unavailable, provision pnpm 9.15.0 separately. If enabling Corepack
requires administrator permissions, use your Node installation's supported setup
instead of installing dependencies with `sudo`. Do not delete or regenerate the
lockfile to work around installation errors.

### Windows source prerequisites

Use Windows PowerShell or PowerShell 7 and verify `git --version`,
`node --version` and `pnpm.cmd --version` in the same account that will run AOD.
After installing tools or changing the user `PATH`, open a new terminal; a
running editor or service can retain its old environment. The `node-pty` package
can use its matching Windows prebuild; if it must compile, provision Python 3
and Visual Studio C++ Build Tools rather than Linux `make`.

The root `.gitattributes` keeps Git-detected text files at LF, including on
Windows. This prevents checkout conversion from invalidating the byte-based
review ledger. For an existing clean checkout, configure
`git config --local core.autocrlf false` and obtain a fresh checkout; preserve
local edits instead of using a destructive reset. Documentation checks also
normalize CRLF when reading files.

Prefer `pnpm.cmd` and `npm.cmd` if PowerShell blocks the corresponding `.ps1`
shims. For a trusted local setup script, when organizational policy permits it,
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File <trusted-script.ps1>`
changes execution policy only for that process. Do not weaken machine-wide
policy, bypass Group Policy, or run downloaded scripts without reviewing them.
Script execution policy is distinct from AOD/Codex tool approval and filesystem
sandboxing; a successful CLI launch does not prove shell tools are authorized.

## 3. Create private configuration

```sh
node scripts/create-local-config.mjs
```

The helper reads the existing root `.env`, or `.env.example` when no `.env` exists,
preserves other settings, and atomically writes a new 64-character random access
key. It prints no key, uses mode `0600` on POSIX and refuses existing nonempty
keys or symlinked configurations. It is setup, **not a key-rotation tool**.
Do not overwrite an existing `.env` with the example.

Open `.env` in a private local editor when you need the `AOD_ACCESS_KEY` for login.
Do not paste it into terminal output, screenshots, issues or this repository.
Use [configuration](configuration.md) to select independent data paths first.
All native agent adapters remain disabled in the starter configuration.

## 4. Choose one run mode

### Development

```sh
pnpm dev
```

Open `http://127.0.0.1:5180`. The API is on `http://127.0.0.1:8890` and Vite
proxies `/api`. The web port is strict: if occupied, startup fails instead of
silently choosing another port. This mode is for editing source, not public hosting.

### Compiled all-in-one instance

```sh
pnpm --workspace-concurrency=1 -r build
pnpm --filter @agentopsdeck/server start
```

Open `http://127.0.0.1:8890`. The API and built web application use the same
server. Internal `@agentopsdeck/*` names are intentional compatibility identifiers;
the product version is AOD 1.0.0. Do not run this and development against the
same state simultaneously.

## 5. Verify and log in

```sh
curl --fail --silent --show-error http://127.0.0.1:8890/api/health
```

This checks HTTP health only, not provider access, session recovery or complete
readiness. For the default all-in-one setup, verify the login screen, enter your
private access key, and check that the workspace loads. Empty agent/session lists
are expected before integrations are configured. Switch English / 简体中文 using
the UI language selector. See [the user guide](user-guide.md) next.

During a disposable no-execution setup, Ctrl+C requests graceful shutdown. For
an instance with tasks or terminals, follow [operations](operations.md) instead;
never stop a service from an agent session hosted inside that service.

## 6. Optional container build

The repository contains a source Dockerfile, **not an accepted production image**.
After reviewing [license obligations](../LICENSE-STATUS.md), a separate Docker
environment can test:

```sh
docker build -t agentopsdeck:1.0.0 .
docker volume create agentopsdeck-data
docker run --rm --name agentopsdeck \
  --publish 127.0.0.1:8890:8890 \
  --env-file .env \
  --env AOD_LISTEN_HOST=0.0.0.0 \
  --env AOD_PORT=8890 \
  --env AOD_DATA_DIR=/data \
  --mount type=volume,source=agentopsdeck-data,target=/data \
  agentopsdeck:1.0.0
```

The explicit overrides are required because `.env` otherwise overrides the
Dockerfile's listening host/data defaults. Use a dedicated configuration with
adapters disabled; external host paths do not automatically exist in a container.
Do not reuse an existing instance's volume. Docker administrators can inspect
container environment values, including keys. Protect host access accordingly.
No native CLI is installed by this image. Image/OS notices and Docker runtime
acceptance remain pending; reverse-connect blueprints are not this installation path.

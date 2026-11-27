# User guide

**English · [简体中文](user-guide.zh-CN.md) · [Documentation](README.md)**

## First login

Complete [installation](installation.md), open the appropriate development or
compiled URL, and enter your private access key in the login UI. This is a
trusted-operator application, not an anonymous public service. Language preference
is stored in the browser; without an explicit choice, Chinese browser languages
select Simplified Chinese and others select English.

Use different hostnames or browser profiles for independent instances: cookies
are not separated by port. Keep credentials out of screenshots and support reports.

## Connections and agents

The Hub presents environments; a Connector provides access to configured native
runtimes and resources. In `all` mode these live in one process. Select the
intended connection and agent before creating a session. Empty lists do not mean
installation failed: starter adapters are disabled. Follow [integrations](integrations.md)
to configure your own runtimes and workspace.

Connection grants and resource permissions remain required. Do not assume that
logging in grants every remote environment or arbitrary local filesystem access.

## Sessions, messages and tools

1. Create or open a session under the intended connection/agent.
2. Confirm its workspace and execution permissions before sending a task.
3. Follow message history and tool entries; they show observed execution, not a
   guarantee of provider success or absence of background work.
4. If a message is accepted or queued, do not resend it merely because the
   history view is delayed. Use existing receipts/recovery instead.

Hide/archive operations are organization actions, not proof of cancellation.
Treat deletion, terminal interruption and other destructive actions separately.
An unavailable resource may be denied, unconfigured or disconnected; investigate
before changing permissions.

## Interpreting status and recovery

| Status | Meaning and safe response |
| --- | --- |
| Running | The observed execution is active; wait or use the existing authorized interruption workflow. |
| Execution failed · ready for your next message | The failed turn has passed the completion/sync/background gates; a new message may be sent. |
| History sync interrupted / incomplete | Message projection is incomplete; this alone says nothing about execution termination. |
| Background terminals still active | A turn may have ended while native work remains; inspect ownership and cleanup permission. |
| Run state unconfirmed / `outcome_unknown` | Outcome is not proven; do not resend, replay, delete protection or force local state to idle. |

“Recover session” is conditional, not an unconditional unlock. When shown,
follow its inspection and confirmation steps. It must still check exact execution
identity, history and background work; refusal can be a safety result. A timeout
or page refresh is not a stop proof. Keep intended long-running services alive.
See [troubleshooting](troubleshooting.md) if a state does not resolve.

## Boards, notes and files

Use workspace cards for boards, notes and permitted resources. Placed notebook
cards integrate their multi-session co-binding controls into the top-right card
header to maximize editor space, and support double-clicking the card title (or
pressing `F2`) to rename inline. You can also open **Layout presets → Multi-session switcher**
in classic workspace mode for a compact split-view card with a collapsible
session list on the left and the active conversation on the right without
switching to OS desktop mode. File-backed
synchronization is separate from an in-app edit: check binding/sync status before
assuming a file was written. A failed binding should be diagnosed rather than
fixed by editing the active database or deleting permission records.

File browser, preview and write access depend on configured roots and grants.
Defaults do not expose arbitrary host files. Configure only specific project
directories; do not use the filesystem root or another instance's native home.

## Git repository status card

Open **Layout presets → Git repository status** (or the **Git repository status**
shortcut in OS desktop mode) to monitor a GitHub repository in a compact standalone
glass card. Multiple cards can be opened simultaneously for different
repositories.

- Displays a compact repository overview, open pull requests (ready and draft),
  pure open issue counts (excluding pull requests), GitHub Actions pass rate and
  recent workflow runs, and stars/forks.
- Once a repository is configured, the repository picker collapses automatically;
  use the **Repository settings** gear button in the card toolbar to switch
  accounts or repositories without keeping the input bar permanently visible.
- Uses conservative automatic refresh intervals (5 minutes for authenticated
  accounts, 10 minutes for unauthenticated public repositories, with server-side
  3-minute caching and rate-limit backoff) to avoid GitHub API rate limits.
- Public repositories work out of the box by entering `owner/repo`. For private
  repositories or higher API rate limits, configure server-side accounts with
  `AOD_GIT_ACCOUNTS_JSON` or `AOD_GITHUB_TOKEN_FILE` / `AOD_GITHUB_DEFAULT_REPO`
  in your private environment; tokens stay on the server and are never sent to
  the browser.

## Before requesting support

Record AOD version/source revision, affected connection and status category,
approximate time and reproduction steps. Redact messages, tool arguments,
identifiers and credential-bearing URLs. Public reports should use synthetic
examples. Contact and private-reporting readiness are described in [security](../SECURITY.md).

# Isolated browser recovery check

`media-library.browser.mjs` mounts the real component with synthetic media APIs on
desktop/mobile. It covers disabled configuration/recheck in both languages,
playback failure/storage denial, account-switch clearing (including A → B → A),
late 401 isolation and network cancellation on unmount. It uses the existing
`AOD_TEST_PLAYWRIGHT`/`AOD_TEST_CHROMIUM` overrides, with no live account
or production media directory. Operator guidance is in
`docs/architecture/media-library-operator-guide.md`.

`pnpm check:i18n` checks static JSX text and literal title/placeholder/aria-label/alt
attributes throughout web source. File-specific exceptions carry reasons and
stale exceptions fail the check. `pnpm test:i18n` tests the checker itself. This
is a regression guard, not complete dynamic-copy or browser language acceptance;
user content, source code and server diagnostics need separate review.

`message-history.browser.mjs` checks the actual desktop/mobile shells with 1100
synthetic conversation messages plus tool records: a 200-chat initial window,
bounded anchor pagination past 500, no permanent hidden-count notice, failed-page
retry control, preserved scroll position and retained older pages after a live
update. It uses the same browser overrides and `AOD_TEST_WEB_ROOT` as below.

`live-polling.browser.mjs` uses the same Playwright/browser overrides and accepts
`AOD_TEST_WEB_ROOT` for a built release. Its synthetic API counts state,
agents, gateway status and message requests over a controlled 60-second window
on desktop/mobile. It checks event bursts, metadata invalidation, hidden tabs,
focus/visibility catchup, disconnected fallback, reconnect/reset and ordinary
caret events. `AOD_TEST_POLLING_BASELINE=1` only measures the idle window so
the same fixture can compare the previous release. No real sessions or credentials
are used. The healthy stream keeps its heartbeat; clock advancement does not
silently turn the idle measurement into a disconnected-stream test.

`artifact-download.browser.mjs` requires `AOD_TEST_RELEASE` (a verified
release directory), `AOD_TEST_PLAYWRIGHT`, and optionally
`PLAYWRIGHT_BROWSERS_PATH`. It uses the deployed artifact projector and session
media endpoint with synthetic local state, plus the deployed desktop/mobile UI.
It checks the disabled-receiver regression, allowed directory and symlink
boundaries, message/token binding and revocation, actual download-button clicks,
Chinese filename and exact downloaded bytes. Hub discovery is mocked; real Hub
authorization is covered by the server tests, not this browser fixture. It does
not read production credentials or send native turns. Temporary evidence is kept.

Run `npm test` and the web typecheck/build first. The component browser test
starts its own loopback-only Vite fixture, intercepts all API requests with
synthetic data, and blocks browser traffic to every other origin. It never uses
the normal Vite proxy or a running AgentOpsDeck instance.

```bash
AOD_TEST_PLAYWRIGHT=/path/to/already-installed/playwright/index.mjs \
AOD_TEST_CHROMIUM=/path/to/chrome \
node apps/web/tests/command-recovery.browser.mjs
```

The overrides are optional if Playwright and its browser are already resolvable.
No production dependency is added. The check exercises the actual recovery
component, journal and HTTP client at desktop/mobile widths: a lost POST reply,
reload GET-only recovery, accepted vs execution status, retained unknown outcome,
account-scoped records/cache, partial-response cancellation and width overflow.
It is not an end-to-end test of the whole application, real runtime, WAN or TLS.
No screenshots or real session data are produced.

`node apps/web/tests/session-create.browser.mjs` uses the same overrides and
isolation. It verifies the actual creation API/journal/notice with lost ACK,
concurrent-click barrier, GET-only refresh/open, account isolation, damaged
storage and retained accepted metadata without a fabricated session ID or saved
title/body. It also opens the confirmed identity from the actual desktop/mobile
shells while the synthetic session list remains empty. No native runtime is run.

`node apps/web/tests/queue-version.browser.mjs` uses the same optional browser
overrides and loopback isolation. It exercises the actual desktop/mobile queue
dock: observed If-Match, stale-edit draft retention, refresh without mutation,
explicit version review, cancellation, legacy version-less controls and keeping
a draft when its message leaves the queue. It also checks keyed edit/cancel ACK
loss, offline receipt queries, unknown-target controls, reload GET-only recovery
after row deletion, and no edited text in the shared bounded recovery journal.
It does not execute a real Connector/runtime.

`node apps/web/tests/session-delete.browser.mjs` uses the same browser overrides
and isolation. It exercises the actual deletion workflow and recovery notice:
stable account-bound command identity before DELETE, lost ACK, blocking a second
unknown deletion, reload GET-only recovery, explicit accepted deletion, account
isolation, corrupt storage preventing dispatch and desktop/mobile width overflow.
It reuses the message recovery fixture; it does not click through the full main
application or establish Connector queue/execution lifecycle exclusion.

`node apps/web/tests/chat-auto-scroll.browser.mjs` uses the same browser overrides
and isolation with the actual desktop/mobile application. It checks exact bottom
position after long replies, streaming growth, delayed Markdown images and
viewport resize; upward scrolling pauses following, the toolbar toggle blocks
late callbacks, and a one-off jump does not enable the toggle. It also checks
downward user re-entry into the bottom zone (without treating programmatic
positioning as user intent), invariant transcript height when the latest button
appears, no false unread indicator when disabling follow at the bottom, and
continued follow after an upward gesture in a non-overflowing conversation. Set
`AOD_TEST_WEB_ROOT` to an absolute built web directory to test a candidate
bundle instead of source. No real API, credentials or native runtime is used.
# Render recovery

`session-goal-continuous.browser.mjs` and `session-goal-waiting.browser.mjs`
require `AOD_TEST_WEB_DIST` to point to an explicitly built candidate web
directory. They accept the same Playwright/Chromium overrides described above.
Both fixtures exercise the production bundle at 1440, 390 and 320 pixel widths
with synthetic HTTP/SSE history and an HTTP/WebSocket network fence. They do not
connect to a running Hub/Connector or send native turns. The continuous fixture
checks that an old final-history error does not hide a currently running or
waiting successor, that stale Goal metadata is not promoted, and that reload
retains an unsent draft. The waiting fixture permits only its synthetic
completion-observation requests; neither fixture allows message/control writes.

Run `node apps/web/tests/render-recovery.browser.mjs` from the repository root.
Like the other browser tests, `AOD_TEST_PLAYWRIGHT` may point to an installed
Playwright module and `AOD_TEST_CHROMIUM` to its Chromium executable.
The test starts an isolated Vite fixture with the actual recovery boundary; it
does not add production fault hooks or send messages to a live Connector.

Desktop and mobile coverage: transient render failure, one automatic retry per
incident, persistent-failure stop, healthy-window rearming, timer cleanup,
manual retry, attachment retention and account/session isolation. A malformed
message in the real app verifies local plaintext fallback, unchanged composer
DOM/draft, other messages remaining readable, and retry with updated SSE data.
All non-GET requests are rejected and asserted absent. This reproduces recovery
behavior, not a diagnosis of an unspecified production `reading '0'` stack.

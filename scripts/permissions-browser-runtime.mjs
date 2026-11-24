import { join } from 'node:path';

export const permissionsBrowsers = Object.freeze(['dashboard-users', 'execution-setup', 'shared-session-live',
  'shared-scope', 'shared-session-address', 'shared-request-recovery', 'shared-grants', 'shared-content',
  'passkey-scope', 'board-delegation', 'command-recovery', 'session-create', 'session-delete',
  'desktop-message-isolation', 'desktop-pane-isolation', 'desktop-cache-lifecycle', 'workspace-research', 'hub-codex']);

export function selectPermissionsBrowsers(requested = []) {
  if (!Array.isArray(requested) || requested.some(name => !permissionsBrowsers.includes(name))) {
    throw new Error('Unknown permissions browser fixture');
  }
  return [...new Set(requested.length ? requested : permissionsBrowsers)];
}

/** These fixtures serve or boot the sealed release, not a local dist folder. */
export function permissionsBrowserWorkingDirectory({ fixture, repository, candidate }) {
  if (fixture === 'workspace-research') {
    if (!candidate) throw new Error('workspace-research requires a sealed candidate for static assets');
    return candidate;
  }
  return repository;
}

export function permissionsBrowserRuntime({ repository, temp, playwright, chromium, environment = process.env }) {
  return {
    // Several fixtures use the real isolated backend source. Native strip-only
    // TypeScript cannot parse parameter properties; use the installed loader.
    prefix: ['--import', join(repository, 'apps/server/node_modules/tsx/dist/loader.mjs')],
    env: { PATH: environment.PATH, HOME: join(temp, 'home'), TMPDIR: temp, TMP: temp, TEMP: temp,
      XDG_CONFIG_HOME: join(temp, 'home/.config'), XDG_CACHE_HOME: join(temp, 'home/.cache'),
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: 'true',
      AOD_TEST_PLAYWRIGHT: playwright, AOD_TEST_CHROMIUM: chromium },
  };
}

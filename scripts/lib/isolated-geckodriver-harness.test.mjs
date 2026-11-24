import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import test from 'node:test';
import {
  buildExactOriginFirefoxPrefs,
  buildIsolatedDriverEnv,
  createIsolatedGeckodriverHarness,
  formatBoundedBrowserDiagnostic,
} from './isolated-geckodriver-harness.mjs';

test('buildIsolatedDriverEnv scrubs ambient secrets, proxy vars, and operator profile paths', () => {
  const env = buildIsolatedDriverEnv('/tmp/isolated-root', {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/operator/real-home',
    AOD_BROWSER_PROFILE_ROOT: '/operator/profile-root',
    HTTP_PROXY: 'http://proxy.example:8080',
    HTTPS_PROXY: 'http://proxy.example:8080',
    OPENAI_API_KEY: 'sk-synthetic-secret-token',
    AGENTOPSDECK_ACCESS_KEY: 'synthetic-access-key',
  });

  assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
  assert.equal(env.HOME, '/tmp/isolated-root/home');
  assert.equal(env.TMPDIR, '/tmp/isolated-root/tmp');
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/isolated-root/config');
  assert.equal(env.MOZ_HEADLESS, '1');
  assert.equal('AOD_BROWSER_PROFILE_ROOT' in env, false);
  assert.equal('HTTP_PROXY' in env, false);
  assert.equal('HTTPS_PROXY' in env, false);
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal('AGENTOPSDECK_ACCESS_KEY' in env, false);
});

test('buildExactOriginFirefoxPrefs enforces exact loopback PAC fence and disables telemetry/prefetch', () => {
  const prefs = buildExactOriginFirefoxPrefs(41234, { 'ui.primaryPointerCapabilities': 6 });
  assert.equal(prefs['network.proxy.type'], 2);
  assert.equal(prefs['network.proxy.allow_hijacking_localhost'], true);
  assert.equal(prefs['network.proxy.no_proxies_on'], '');
  assert.equal(prefs['network.dns.disablePrefetch'], true);
  assert.equal(prefs['network.captive-portal-service.enabled'], false);
  assert.equal(prefs['toolkit.telemetry.enabled'], false);
  assert.equal(prefs['ui.primaryPointerCapabilities'], 6);

  const pacUrl = String(prefs['network.proxy.autoconfig_url']);
  assert.ok(pacUrl.startsWith('data:application/x-ns-proxy-autoconfig;base64,'));
  const pacScript = Buffer.from(pacUrl.slice(pacUrl.indexOf(',') + 1), 'base64').toString('utf8');
  const findProxy = new Function(`${pacScript}; return FindProxyForURL;`)();
  assert.equal(findProxy('http://127.0.0.1:41234/', '127.0.0.1'), 'DIRECT');
  assert.equal(findProxy('http://127.0.0.1:41234/api/hub/v1/sessions', '127.0.0.1'), 'DIRECT');
  assert.equal(findProxy('http://127.0.0.1:41235/', '127.0.0.1'), 'PROXY 127.0.0.1:9');
  assert.equal(findProxy('https://example.com/', 'example.com'), 'PROXY 127.0.0.1:9');
});

test('formatBoundedBrowserDiagnostic redacts multi-segment paths and drops raw DOM dumps', () => {
  const rawErr = Object.assign(
    new Error('Timed out: waiting for selector /var/private/browser/profile/session.json\nSENSITIVE_DOM_DUMP_TOKEN'),
    { code: 'ERR_BROWSER_UNTIL_TIMEOUT' },
  );
  const formatted = formatBoundedBrowserDiagnostic(rawErr, 'live-ui');
  assert.ok(formatted.startsWith('live-ui: Timed out:'));
  assert.equal(formatted.includes('/var/private/browser'), false);
  assert.ok(formatted.includes('[redacted-path]'));

  const generic = Object.assign(
    new Error('Raw page innerText: SECRET_TRANSCRIPT_PAYLOAD /var/private/user/file'),
    { code: 'ECONNREFUSED' },
  );
  const formattedGeneric = formatBoundedBrowserDiagnostic(generic, 'live-ui');
  assert.equal(formattedGeneric, 'live-ui: Error (ECONNREFUSED)');
});

function makeFakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function statLine({ pid = 4242, state = 'S', pgrp = 4242, start = '987654' } = {}) {
  const fields = Array(25).fill('0');
  fields[0] = state;
  fields[2] = String(pgrp);
  fields[19] = String(start);
  return `${pid} (geckodriver) ${fields.join(' ')}\n`;
}

test('createIsolatedGeckodriverHarness verifies owned startup, session DELETE, group teardown, and cleanup', async () => {
  const child = makeFakeChild(4242);
  let alive = true;
  const fetchCalls = [];
  const signals = [];
  let spawnedOpts;
  let spawnedArgs;

  const harness = await createIsolatedGeckodriverHarness({
    fixturePort: 39111,
    reservePort: async () => 45451,
    sourceEnv: { PATH: '/usr/bin', SECRET_KEY: 'never-inherit' },
    spawnProcess: (_bin, args, opts) => {
      spawnedArgs = args;
      spawnedOpts = opts;
      return child;
    },
    readDirectory: async () => (alive ? ['4242', '4243'] : []),
    readText: async (target) => {
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (target === '/proc/4242/stat') return statLine({ pid: 4242, pgrp: 4242, start: '111222' });
      if (target === '/proc/4243/stat') return statLine({ pid: 4243, pgrp: 4242, start: '111225' });
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    killGroup: (pgrp, sig) => {
      signals.push([pgrp, sig]);
      alive = false;
      child.exitCode = 0;
      child.emit('close', 0, sig);
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/status')) {
        return { ok: true, status: 200, json: async () => ({ value: { ready: true } }) };
      }
      if (url.endsWith('/session') && init.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ value: { sessionId: 'sess-owned-1' } }) };
      }
      if (url.endsWith('/session/sess-owned-1') && init.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ value: null }) };
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  assert.equal(spawnedOpts.detached, true);
  assert.equal('SECRET_KEY' in spawnedOpts.env, false);
  assert.ok(spawnedArgs.includes('--port'));
  assert.ok(spawnedArgs.includes('45451'));

  const sessionId = await harness.createSession({ 'layout.css.prefers-reduced-motion.enabled': true });
  assert.equal(sessionId, 'sess-owned-1');
  const postSession = fetchCalls.find((c) => c.method === 'POST' && c.url.endsWith('/session'));
  assert.equal(
    postSession.body.capabilities.alwaysMatch['moz:firefoxOptions'].prefs['network.proxy.type'],
    2,
  );

  const rootDir = harness.rootDir;
  await harness.close();

  assert.ok(fetchCalls.some((c) => c.method === 'DELETE' && c.url.endsWith('/session/sess-owned-1')));
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  await assert.rejects(() => access(rootDir), { code: 'ENOENT' });
});

test('createIsolatedGeckodriverHarness fails closed if foreign listener answers after spawned process identity changes', async () => {
  const child = makeFakeChild(5151);
  let reads = 0;
  const signals = [];

  await assert.rejects(
    () =>
      createIsolatedGeckodriverHarness({
        fixturePort: 39112,
        reservePort: async () => 45452,
        startupAttempts: 2,
        startupIntervalMs: 5,
        spawnProcess: () => child,
        readText: async () => {
          reads += 1;
          // Initial read + pre-status read match, post-status read shows PID reuse / different start time.
          const start = reads <= 2 ? '500100' : '999999';
          return statLine({ pid: 5151, pgrp: 5151, start });
        },
        killGroup: (pgrp, sig) => {
          signals.push([pgrp, sig]);
        },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ value: { ready: true } }),
        }),
      }),
    (err) => err?.code === 'ERR_DRIVER_OWNER',
  );

  assert.deepEqual(signals, [[5151, 'SIGKILL']]);
});

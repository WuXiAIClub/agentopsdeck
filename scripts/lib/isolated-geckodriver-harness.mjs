import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.:/-]{1,64}$/;

function parseProcStatIdentity(text, pid) {
  const closing = typeof text === 'string' ? text.lastIndexOf(')') : -1;
  const prefix = typeof text === 'string' ? text.slice(0, text.indexOf('(')) : '';
  const fields = closing >= 0 ? text.slice(closing + 1).trim().split(/\s+/) : [];
  if (
    !Number.isSafeInteger(pid)
    || pid < 1
    || prefix !== `${pid} `
    || fields.length < 20
    || !/^[RSDZTtWXxKPI]$/.test(fields[0])
    || !/^-?(0|[1-9]\d*)$/.test(fields[2])
    || !/^(0|[1-9]\d*)$/.test(fields[19])
  ) {
    throw Object.assign(new Error('Invalid proc stat identity'), { code: 'ERR_INVALID_PROC_STAT' });
  }
  return {
    pid,
    pgrp: Number(fields[2]),
    start: fields[19],
    state: fields[0],
  };
}

export async function readProcStatIdentity(pid, readText = readFile) {
  try {
    const raw = await readText(`/proc/${pid}/stat`, 'utf8');
    return parseProcStatIdentity(raw, pid);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function buildIsolatedDriverEnv(rootDir, sourceEnv = process.env) {
  const safePath = typeof sourceEnv?.PATH === 'string' && sourceEnv.PATH.trim()
    ? sourceEnv.PATH
    : '/usr/bin:/bin';
  return Object.freeze({
    PATH: safePath,
    HOME: join(rootDir, 'home'),
    TMPDIR: join(rootDir, 'tmp'),
    XDG_CACHE_HOME: join(rootDir, 'cache'),
    XDG_CONFIG_HOME: join(rootDir, 'config'),
    XDG_RUNTIME_DIR: join(rootDir, 'runtime'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    MOZ_HEADLESS: '1',
    MOZ_CRASHREPORTER_DISABLE: '1',
    NO_PROXY: '127.0.0.1,localhost',
  });
}

export function buildExactOriginFirefoxPrefs(fixturePort, extraPrefs = {}) {
  if (!Number.isSafeInteger(fixturePort) || fixturePort < 1 || fixturePort > 65535) {
    throw new Error('Valid loopback fixturePort is required for Firefox network fence');
  }
  const pacScript = `function FindProxyForURL(url, host) {
  if (url.indexOf("http://127.0.0.1:${fixturePort}/") === 0 || url === "http://127.0.0.1:${fixturePort}") {
    return "DIRECT";
  }
  return "PROXY 127.0.0.1:9";
}`;
  const pacDataUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacScript, 'utf8').toString('base64')}`;
  return {
    'network.proxy.type': 2,
    'network.proxy.autoconfig_url': pacDataUrl,
    'network.proxy.allow_hijacking_localhost': true,
    'network.proxy.no_proxies_on': '',
    'network.dns.disablePrefetch': true,
    'network.dns.disablePrefetchFromHTTPS': true,
    'network.predictor.enabled': false,
    'network.http.speculative-parallel-limit': 0,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.enabled': false,
    'toolkit.telemetry.unified': false,
    'app.shield.optoutstudies.enabled': false,
    'browser.newtabpage.activity-stream.feeds.telemetry': false,
    'browser.ping-centre.telemetry': false,
    ...extraPrefs,
  };
}

export function formatBoundedBrowserDiagnostic(error, contextLabel = 'webdriver') {
  const safeContext = typeof contextLabel === 'string' && SAFE_CODE_PATTERN.test(contextLabel)
    ? contextLabel
    : 'webdriver';
  if (error instanceof assert.AssertionError || error?.name === 'AssertionError') {
    const compact = String(error.message ?? 'Assertion failed')
      .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '[redacted-path]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    return `${safeContext}: AssertionError: ${compact}`;
  }
  const name = typeof error?.name === 'string' && SAFE_CODE_PATTERN.test(error.name) ? error.name : 'Error';
  const code = typeof error?.code === 'string' && SAFE_CODE_PATTERN.test(error.code) ? error.code : undefined;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^(?:WebDriver|Condition timed out|Timed out|Teardown)\b/.test(message)) {
    const compact = message
      .replace(/(?:\/[A-Za-z0-9._-]+){2,}/g, '[redacted-path]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    return `${safeContext}: ${compact}`;
  }
  return code ? `${safeContext}: ${name} (${code})` : `${safeContext}: ${name}`;
}

async function reserveLoopbackPort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function listProcessGroupMembers(pgrp, { readDirectory = readdir, readText = readFile } = {}) {
  const entries = await readDirectory('/proc');
  const alive = [];
  for (const entry of entries) {
    if (!/^(?:[1-9]\d*)$/.test(entry)) continue;
    const pid = Number(entry);
    const identity = await readProcStatIdentity(pid, readText);
    if (!identity) continue;
    if (identity.pgrp === pgrp && identity.state !== 'Z') {
      alive.push(identity.pid);
    }
  }
  return alive;
}

export async function createIsolatedGeckodriverHarness({
  fixturePort,
  prefix = 'agentopsdeck-gecko-',
  extraPrefs = {},
  spawnProcess = spawn,
  fetchImpl = fetch,
  reservePort = reserveLoopbackPort,
  readDirectory = readdir,
  readText = readFile,
  killGroup = (pgrp, signal) => process.kill(-pgrp, signal),
  sourceEnv = process.env,
  startupAttempts = 60,
  startupIntervalMs = 100,
  teardownTimeoutMs = 5000,
} = {}) {
  assert.ok(Number.isSafeInteger(fixturePort) && fixturePort > 0 && fixturePort <= 65535, 'Valid fixturePort required');
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(rootDir, 0o700);
  for (const sub of ['home', 'tmp', 'cache', 'config', 'runtime', 'profile-root']) {
    const dir = join(rootDir, sub);
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
  }
  const env = buildIsolatedDriverEnv(rootDir, sourceEnv);
  const driverPort = await reservePort();
  const profileRoot = join(rootDir, 'profile-root');
  const child = spawnProcess(
    'geckodriver',
    ['--host', '127.0.0.1', '--port', String(driverPort), '--profile-root', profileRoot],
    { detached: true, stdio: 'ignore', env },
  );

  let spawnError;
  let closed = false;
  const closePromise = new Promise((resolve) => {
    child.once('error', (err) => {
      spawnError = err;
      closed = true;
      resolve();
    });
    child.once('close', () => {
      closed = true;
      resolve();
    });
  });

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let initialIdentity;
  try {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1, 'Spawned geckodriver PID required');
    initialIdentity = await readProcStatIdentity(child.pid, readText);
    if (!initialIdentity || initialIdentity.state === 'Z') {
      throw Object.assign(new Error('WebDriver spawned process exited before handshake'), { code: 'ERR_DRIVER_EXITED' });
    }

    let ready = false;
    for (let attempt = 0; attempt <= startupAttempts; attempt++) {
      if (spawnError) throw spawnError;
      if (closed || child.exitCode !== null || child.signalCode !== null) {
        throw Object.assign(new Error('WebDriver spawned process exited before status ready'), { code: 'ERR_DRIVER_EXITED' });
      }
      const beforeCheck = await readProcStatIdentity(child.pid, readText);
      if (!beforeCheck || beforeCheck.start !== initialIdentity.start || beforeCheck.state === 'Z') {
        throw Object.assign(new Error('WebDriver spawned process identity lost before handshake'), { code: 'ERR_DRIVER_OWNER' });
      }
      try {
        const res = await fetchImpl(`http://127.0.0.1:${driverPort}/status`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json' },
        });
        if (res.ok) {
          const payload = await res.json();
          const afterCheck = await readProcStatIdentity(child.pid, readText);
          if (
            !afterCheck
            || afterCheck.start !== initialIdentity.start
            || afterCheck.state === 'Z'
            || closed
            || spawnError
          ) {
            throw Object.assign(new Error('WebDriver endpoint responded without owned process'), { code: 'ERR_DRIVER_OWNER' });
          }
          if (payload?.value?.ready !== false) {
            ready = true;
            break;
          }
        }
      } catch (err) {
        if (err?.code === 'ERR_DRIVER_OWNER' || err?.code === 'ERR_DRIVER_EXITED') throw err;
        if (attempt === startupAttempts) {
          throw Object.assign(new Error('WebDriver status handshake timed out'), { code: 'ERR_DRIVER_HANDSHAKE' });
        }
      }
      await delay(startupIntervalMs);
    }
    if (!ready) {
      throw Object.assign(new Error('WebDriver status handshake not ready'), { code: 'ERR_DRIVER_HANDSHAKE' });
    }
  } catch (error) {
    try {
      if (initialIdentity?.pgrp > 1) killGroup(initialIdentity.pgrp, 'SIGKILL');
    } catch {}
    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let activeSessionId;

  async function request(path, method = 'GET', body) {
    if (spawnError) throw spawnError;
    if (closed || child.exitCode !== null || child.signalCode !== null) {
      throw Object.assign(new Error('WebDriver process unexpectedly closed'), { code: 'ERR_DRIVER_CLOSED' });
    }
    const response = await fetchImpl(`http://127.0.0.1:${driverPort}${path}`, {
      method,
      signal: AbortSignal.timeout(method === 'DELETE' ? 120_000 : 30_000),
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const rawErr = typeof json?.value?.error === 'string' && SAFE_CODE_PATTERN.test(json.value.error)
        ? json.value.error
        : 'webdriver-error';
      throw Object.assign(
        new Error(`WebDriver ${method} HTTP ${response.status} (${rawErr})`),
        { code: 'ERR_WEBDRIVER_HTTP' },
      );
    }
    return json.value;
  }

  async function createSession(sessionExtraPrefs = {}) {
    const prefs = buildExactOriginFirefoxPrefs(fixturePort, { ...extraPrefs, ...sessionExtraPrefs });
    const created = await request('/session', 'POST', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': {
            args: ['-headless'],
            prefs,
          },
        },
      },
    });
    activeSessionId = created.sessionId;
    assert.ok(typeof activeSessionId === 'string' && activeSessionId.length > 0, 'WebDriver sessionId required');
    return activeSessionId;
  }

  async function untilScript(scriptRunner, source, { attempts = 100, intervalMs = 100 } = {}) {
    for (let index = 0; index < attempts; index++) {
      if (await scriptRunner(source)) return;
      await delay(intervalMs);
    }
    const label = String(source).replace(/\s+/g, ' ').trim().slice(0, 140);
    throw Object.assign(new Error(`Timed out: ${label}`), { code: 'ERR_BROWSER_UNTIL_TIMEOUT' });
  }

  async function close() {
    const teardownErrors = [];
    if (activeSessionId) {
      const sessionToDelete = activeSessionId;
      activeSessionId = undefined;
      try {
        await request(`/session/${sessionToDelete}`, 'DELETE');
      } catch (err) {
        teardownErrors.push(formatBoundedBrowserDiagnostic(err, 'session-delete'));
      }
    }

    const pgrp = initialIdentity.pgrp > 1 ? initialIdentity.pgrp : child.pid;
    try {
      killGroup(pgrp, 'SIGTERM');
    } catch (err) {
      if (err?.code !== 'ESRCH') {
        teardownErrors.push(formatBoundedBrowserDiagnostic(err, 'sigterm-group'));
      }
    }

    const halfTimeout = Math.max(250, Math.floor(teardownTimeoutMs / 2));
    await Promise.race([closePromise, delay(halfTimeout)]);

    let remaining = await listProcessGroupMembers(pgrp, { readDirectory, readText }).catch((err) => {
      teardownErrors.push(formatBoundedBrowserDiagnostic(err, 'proc-scan'));
      return [child.pid];
    });

    if (!closed || remaining.length > 0) {
      try {
        killGroup(pgrp, 'SIGKILL');
      } catch (err) {
        if (err?.code !== 'ESRCH') {
          teardownErrors.push(formatBoundedBrowserDiagnostic(err, 'sigkill-group'));
        }
      }
      await Promise.race([closePromise, delay(halfTimeout)]);
      const deadline = Date.now() + halfTimeout;
      while (Date.now() < deadline) {
        remaining = await listProcessGroupMembers(pgrp, { readDirectory, readText }).catch((err) => {
          teardownErrors.push(formatBoundedBrowserDiagnostic(err, 'proc-rescan'));
          return [child.pid];
        });
        if (closed && remaining.length === 0) break;
        await delay(50);
      }
    }

    await rm(rootDir, { recursive: true, force: true }).catch((err) => {
      teardownErrors.push(formatBoundedBrowserDiagnostic(err, 'rm-root'));
    });

    if (!closed || remaining.length > 0 || teardownErrors.length > 0) {
      throw Object.assign(
        new Error(`Teardown verification failed (${teardownErrors[0] ?? `remaining=${remaining.length}`})`),
        { code: 'ERR_TEARDOWN_UNVERIFIED', teardownErrors, remaining },
      );
    }
  }

  return {
    rootDir,
    driverPort,
    env,
    request,
    createSession,
    untilScript,
    close,
  };
}

// Opt-in real Firefox against the disposable live Hub. No API fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createServer } from 'node:http';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerIsolatedProbeGroup } from './isolated-sdk-probe.mjs';

export async function liveInteractionBrowser({ origin, accessKey, root }) {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  // Snap cannot access hidden probe directories. Use a fresh profile under its
  // own allowed data directory, never an existing user/browser profile.
  const profileRoot = await mkdtemp(join(userInfo().homedir, 'snap/firefox/common/agentopsdeck-live-'));
  await writeFile(join(root, 'browser-profile.json'), JSON.stringify({ profileRoot }), { mode: 0o600 });
  const log = openSync(join(root, 'browser-driver.log'), 'wx', 0o600);
  const driver = spawn('/snap/bin/geckodriver', ['--port', String(port), '--profile-root', profileRoot], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, TMPDIR: profileRoot },
  });
  closeSync(log);
  let session, driverError, phase = 'driver-start';
  driver.on('error', error => { driverError = error; });
  const exit = new Promise(resolve => { driver.once('exit', resolve); driver.once('error', resolve); });
  async function request(path, method = 'GET', body, timeoutMs = 30_000) {
    if (driverError) throw new Error('Firefox driver unavailable');
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error('Firefox WebDriver command failed');
      error.browserPhase = phase;
      error.webdriverCode = /^[a-z ]{1,60}$/.test(result.value?.error) ? result.value.error : 'unknown';
      throw error;
    }
    return result.value;
  }
  const script = (source, args = []) => request(`/session/${session}/execute/sync`, 'POST', { script: source, args });
  async function until(source) {
    for (let i = 0; i < 150; i++) { if (await script(source)) return; await delay(100); }
    throw new Error('Timeout: live browser condition');
  }
  async function click(selector) {
    const found = await request(`/session/${session}/element`, 'POST', { using: 'css selector', value: selector });
    await request(`/session/${session}/element/${Object.values(found)[0]}/click`, 'POST', {});
  }
  async function close() {
    phase = 'browser-close';
    // Firefox's own shutdown observers can take longer than an ordinary DOM
    // command (e.g. RemoteSettingsExperimentLoader). Keep shutdown bounded but
    // allow its normal quit sequence; a timeout still fails acceptance.
    try { if (session) await request(`/session/${session}`, 'DELETE', undefined, 60_000); }
    finally {
      if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGTERM');
      let timer;
      try { await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Firefox shutdown not confirmed')), 10_000); })]); }
      finally { clearTimeout(timer); }
    }
  }
  try {
    await registerIsolatedProbeGroup(driver.pid);
    for (let i = 0; i < 100; i++) {
      try { await request('/status'); break; }
      catch { if (i === 99 || driverError) throw new Error('Firefox driver unavailable'); await delay(100); }
    }
    phase = 'session-create';
    session = (await request('/session', 'POST', { capabilities: { alwaysMatch: {
      browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'], prefs: {
        'app.normandy.enabled': false, 'app.shield.optoutstudies.enabled': false,
        'browser.newtabpage.activity-stream.feeds.telemetry': false,
        'datareporting.healthreport.uploadEnabled': false,
      } },
    } } })).sessionId;
    phase = 'navigate';
    await request(`/session/${session}/url`, 'POST', { url: origin });
    phase = 'login';
    const login = await request(`/session/${session}/execute/async`, 'POST', {
      script: `const done = arguments[arguments.length - 1]; fetch('/api/auth/login', {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({accessKey:arguments[0]})
      }).then(r=>done(r.status),()=>done(0));`, args: [accessKey],
    });
    assert.equal(login, 200, 'Actual browser login');
    return {
      async open(key, width) {
        phase = 'open-session';
        await script("localStorage.clear();sessionStorage.clear();localStorage.setItem('agentopsdeck.locale','en');return true;");
        await request(`/session/${session}/window/rect`, 'POST', { width, height: 1000 });
        await request(`/session/${session}/url`, 'POST', { url: `${origin}/?case=${encodeURIComponent(key)}#/session/${encodeURIComponent(key)}` });
        await script("window.__interactionErrors=[];addEventListener('error',e=>window.__interactionErrors.push(e.message));addEventListener('unhandledrejection',()=>window.__interactionErrors.push('unhandled rejection'));return true;");
        await until(`return document.querySelector('[data-session-card="${key}"]')`);
        await click(`[data-session-card="${key}"]`);
        // Layouts are also stored by the real Hub, unlike the synthetic API.
        // Never operate the first (potentially previous session's) trigger.
        const trigger = `.session-interactions-trigger[data-interaction-session="${key}"]`;
        await until(`return document.querySelector('${trigger}')`);
        if (await script(`return document.querySelector('${trigger}').closest('[data-collapsed=true]') !== null`)) {
          await script(`document.querySelector('${trigger}').closest('.caption-overflow').querySelector(':scope > button').click();return true;`);
        }
        await click(trigger);
        await until("return document.querySelector('.session-interactions-dialog[open] select:not(:disabled)')");
        assert.equal(await script("return document.querySelector('.session-interactions-dialog[open]').dataset.interactionSession"), key, 'Correct session modal');
        await script("const s=document.querySelector('.session-interactions-dialog select');s.value='interactive';s.dispatchEvent(new Event('change',{bubbles:true}));return true;");
        const actual = await script('return {width:innerWidth,height:innerHeight}');
        assert.ok(width >= 600 || actual.width < 600, 'Actual viewport uses narrow layout');
        return { requestedWidth: width, ...actual };
      },
      async answerIndigo(label) {
        phase = 'answer';
        await until("return [...document.querySelectorAll('.interaction-option')].some(e=>/Indigo/.test(e.textContent))");
        await script("[...document.querySelectorAll('.interaction-option')].find(e=>/Indigo/.test(e.textContent)).click();return true;");
        await click('.interaction-question fieldset:not(:disabled) .interaction-allow');
        await until("return document.querySelector('.session-interactions-dialog').textContent.includes('Answer accepted by the Agent')");
        assert.equal(await script('return window.__interactionErrors.length'), 0, 'Live browser errors');
        assert.equal(await script("const d=document.querySelector('.session-interactions-dialog');const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.contains(document.activeElement);"), true, 'Native dialog fits and owns focus');
        await writeFile(join(root, `${label}.png`), Buffer.from(await request(`/session/${session}/screenshot`), 'base64'), { mode: 0o600 });
      }, close,
    };
  } catch (error) { error.browserPhase ??= phase; try { await close(); } catch { /* Preserve primary failure; supervisor checks all owned processes. */ } throw error; }
}

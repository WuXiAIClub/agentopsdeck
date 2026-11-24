// Built application + synthetic loopback API. No production credentials/Agent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const dist = resolve('apps/web/dist'), evidence = await mkdtemp(resolve(tmpdir(), 'agentopsdeck-234-interactions-ui-'));
const scope = 'b'.repeat(64), streams = new Set();
let agent = 'codex', mode = 'automatic', views = [], reads = 0, posts = 0, modeWrites = 0, loseReply = false;
const nativeKey = () => `${agent}:interactive-fixture`;
const key = () => `fixture:${Buffer.from(nativeKey()).toString('base64url')}`;
function question(kind) {
  return { revision: 1, status: 'pending', delivery: 'none', request: { version: 1, ownerId: 'owner', nodeId: 'node',
    sessionKey: nativeKey(), runId: 'run', requestId: randomUUID(), kind, prompt: `${kind}: Choose next step`,
    createdAt: Date.now(), expiresAt: Date.now() + 600000,
    ...(kind.includes('select') ? { options: [{ id: '0', label: 'First' }, { id: '1', label: 'Second' }], allowFreeform: true } : {}) } };
}
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (path.endsWith('/events/stream') || path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: heartbeat\ndata: \n\n');
      streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    if (path.startsWith('/api/')) {
      if (process.env.INTERACTION_UI_TRACE) console.log(req.method, path);
      if (/\/interactions(?:\/|$)|\/interaction-mode$/.test(path)) {
        assert.ok(path.startsWith(`/api/hub/v1/sessions/${encodeURIComponent(key())}/`), 'Interaction must use the current Hub session, not a legacy route or saved fixture');
      }
      if (path.endsWith('/interactions')) {
        reads++; json({ version: 1, mode, capabilities: { version: 1,
          kinds: ['approval', 'text', 'single-select', ...(agent === 'claude-code' ? ['multi-select'] : [])],
          modes: ['automatic', 'interactive'] }, requests: views }); return;
      }
      if (path.endsWith('/interaction-mode')) {
        assert.equal(req.method, 'PATCH'); modeWrites++;
        let raw = ''; for await (const chunk of req) raw += chunk;
        mode = JSON.parse(raw).mode; json({ mode }); return;
      }
      if (path.endsWith('/answer')) {
        assert.equal(req.method, 'POST'); assert.equal(req.headers['x-agentopsdeck-recovery-scope'], scope); posts++;
        let raw = ''; for await (const chunk of req) raw += chunk;
        const answer = JSON.parse(raw), view = views.find(v => path.includes(v.request.requestId));
        assert.equal(answer.runId, view.request.runId); assert.equal(answer.expectedRevision, view.revision);
        if (loseReply) { json({ error: 'Fixture lost acknowledgement' }, 503); return; }
        view.status = 'answered'; view.delivery = 'confirmed'; view.revision++;
        json(view); return;
      }
      const session = { sessionKey: key(), agentId: agent, source: agent, title: 'Interactive fixture', status: 'idle', lastActiveAt: 20,
        ...(agent === 'codex' ? { runStartedAt: 10, runCompletedAt: 20, runtime: {
          turnId: 't', phase: 'completed', sync: 'current', threadActivity: 'idle', connection: 'connected', lastEventAt: 20,
          executionProtection: { state: 'blocked', nativeTurnId: 'native-successor', reason: 'goal-blocked' },
        } } : {}) };
      json(path === '/api/auth/status' ? { authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } }
        : path.endsWith('/sessions/state') ? { groups: [{ agentId: agent, sessions: [session] }], updatedAt: 1, connections: [] }
        : path.endsWith('/messages') ? { messages: [], totalCount: 0, updatedAt: 1 }
        : path.endsWith('/workspace/preferences') ? { revision: 1, groups: [], sessions: {} }
        : path.endsWith('/notebooks') ? { items: [], nextCursor: null }
        : path === '/api/agents' ? { agents: [] }
        : path === '/api/gateway/status' ? { enabled: false, status: 'offline', updatedAt: 1 } : {}); return;
    }
    const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${dist}/`)) throw Error('Invalid path');
    let body = await readFile(file);
    if (extname(file) === '.html') body = body.toString().replace('<head>', `<head><script>window.__documentId=crypto.randomUUID();localStorage.setItem('agentopsdeck.locale','en');window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));</script>`);
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream' }); res.end(body);
  } catch (error) { console.error(error.message); res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const driver = spawn('geckodriver', ['--port', String(port), ...(process.env.AOD_BROWSER_PROFILE_ROOT ? ['--profile-root', process.env.AOD_BROWSER_PROFILE_ROOT] : [])], { stdio: 'ignore' });
let id, driverError;
driver.on('error', error => { driverError = error; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, method = 'GET', body) {
  if (driverError) throw driverError;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw Error(JSON.stringify(data)); return data.value;
}
const script = source => request(`/session/${id}/execute/sync`, 'POST', { script: source, args: [] });
async function until(source) {
  for (let i = 0; i < 100; i++) { if (await script(source)) return; await delay(100); }
  throw Error(`Timed out: ${source}\n${await script('return document.body.innerText')}`);
}
const panel = `document.querySelector('.session-interactions-dialog[open]')`;
async function click(selector) {
  const element = await request(`/session/${id}/element`, 'POST', { using: 'css selector', value: selector });
  await request(`/session/${id}/element/${Object.values(element)[0]}/click`, 'POST', {});
}
async function open(width) {
  const previous = await script('return window.__documentId ?? null');
  await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/?agent=${agent}&case=${randomUUID()}#/session/${encodeURIComponent(key())}` });
  await until(`return window.__documentId && window.__documentId !== ${JSON.stringify(previous)}`);
  if (width < 600) {
    await until(`return document.querySelector('[data-session-card="${key()}"]')`);
    await script(`document.querySelector('[data-session-card="${key()}"]').click();return true;`);
  }
  await until(`return document.querySelector('.session-interactions-trigger')`);
  if (await script(`return document.querySelector('.session-interactions-trigger').closest('[data-collapsed=true]') !== null`)) {
    await click('.caption-overflow[data-collapsed=true] > button');
  }
  await click('.session-interactions-trigger');
  await until(`return ${panel} && ${panel}.querySelector('.interaction-question')`);
}
try {
  for (let i = 0; i < 100; i++) { try { await request('/status'); break; } catch { if (i === 99) throw Error('Driver unavailable'); await delay(100); } }
  id = (await request('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'firefox', unhandledPromptBehavior: 'accept', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  for (const width of [1440, 430]) for (agent of ['codex', 'claude-code', 'ghcp']) {
    // A last-used workspace intentionally wins over a deep link. Keep reload
    // coverage within each case, but never inherit another Agent's layout.
    if (await script('return location.protocol === "http:"')) await script('localStorage.clear();sessionStorage.clear();return true;');
    mode = 'automatic'; loseReply = false;
    views = ['approval', 'text', 'single-select', ...(agent === 'claude-code' ? ['multi-select'] : [])].map(question);
    await request(`/session/${id}/window/rect`, 'POST', { width, height: 1000 });
    await open(width);
    const actualWidth = await script('return innerWidth');
    assert.ok(width >= 600 || actualWidth < 600, 'Actual narrow viewport');
    assert.equal(await script(`return ${panel}.contains(document.activeElement)`), true, 'Native modal owns focus');
    assert.equal(await script(`const r=${panel}.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth`), true, 'Dialog fits narrow viewport');
    assert.equal(await script(`return ${panel}.getBoundingClientRect().width <= 622`), true, 'Compact dialog width wins generic file-dialog styles');
    assert.equal(await script(`const b=${panel}.querySelector('.session-interactions-body');return b.scrollWidth<=b.clientWidth+1`), true, 'No horizontal content overflow');
    assert.equal(await script(`return !!${panel}.querySelector('.interaction-mode-description')`), true, 'Mode has a visible explanation');
    const writes = modeWrites;
    await script(`const s=${panel}.querySelector('select');s.value='interactive';s.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    await until(`return ${panel}.querySelector('select').value==='interactive' && !${panel}.querySelector('select').disabled`);
    assert.equal(modeWrites, writes + 1);
    const count = posts;
    await script(`const b=${panel}.querySelector('.interaction-allow');b.click();b.click();return true;`);
    await until(`return ${panel}.textContent.includes('Answer accepted by the Agent')`);
    assert.equal(await script(`return ${panel}.contains(document.activeElement) && document.activeElement.matches('[role=status]')`), true, 'Accepted answer keeps focus on its stable result');
    assert.equal(posts, count + 1, 'Rapid duplicate click delivers once');
    assert.equal(await script(`return ${panel}.querySelectorAll('input[type=radio]').length`), 2);
    assert.equal(await script(`return ${panel}.querySelectorAll('input[type=checkbox]').length`), agent === 'claude-code' ? 2 : 0);
    const text = await request(`/session/${id}/element`, 'POST', { using: 'css selector', value: '.interaction-text textarea' });
    await request(`/session/${id}/element/${Object.values(text)[0]}/value`, 'POST', { text: 'Fixture reply' });
    loseReply = true;
    await script(`[...${panel}.querySelectorAll('button')].find(b=>b.textContent==='Send answer').click();return true;`);
    await until(`return ${panel}.textContent.includes('Answer outcome unknown')`);
    assert.equal(await script(`return ${panel}.contains(document.activeElement) && document.activeElement.matches('[role=status]')`), true, 'Unknown answer keeps focus inside modal');
    assert.equal(posts, count + 2);
    await writeFile(resolve(evidence, `${width}-${agent}.png`), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
    await open(width);
    if (!await script(`return !!${panel}`)) throw Error(`Modal disappeared after reload: ${await script('return JSON.stringify({body:document.body.innerText, errors:window.__errors, href:location.href})')}`);
    assert.equal(await script(`return ${panel}.querySelector('textarea').disabled || ${panel}.querySelector('textarea').closest('fieldset').disabled`), true, 'Uncertain reply cannot be resent after reload');
    const quietReads = reads; await delay(1200);
    assert.equal(reads, quietReads, 'No passive interaction polling');
    assert.equal(posts, count + 2, 'Reload never resends an answer');
    assert.ok(streams.size, 'Hub event stream is connected');
    const beforeBurst = reads;
    const followup = question('text'); followup.request.prompt = 'SSE follow-up question'; views.push(followup);
    for (let i = 0; i < 25; i++) for (const stream of streams) {
      stream.write(`event: interaction.updated\ndata: ${JSON.stringify({ id: `interaction-${i}`, type: 'interaction.updated', sessionKey: key(), ts: Date.now(), payload: {} })}\n\n`);
    }
    await until(`return ${panel}.textContent.includes('SSE follow-up question')`);
    assert.ok(reads - beforeBurst >= 1 && reads - beforeBurst <= 2, 'A question event burst coalesces into at most two reads');
    assert.equal(posts, count + 2, 'Events do not replay answers');
    assert.deepEqual(await script('return window.__errors'), []);
    await script(`${panel}.querySelector('header button').click();return true;`);
    await until(`return !${panel}`);
    if (agent === 'codex') {
      await until(`return !!document.querySelector('.goal-pause-notice')`);
      await click('.goal-pause-notice summary');
      assert.equal(await script(`return document.querySelector('.goal-pause-notice').open`), true, 'Goal explanation expands');
      assert.equal(await script(`const p=document.querySelector('.goal-pause-notice p'),r=p.getBoundingClientRect();return getComputedStyle(p).position==='static' && r.left>=0 && r.right<=innerWidth`), true, 'Goal explanation stays in flow and fits viewport');
      await writeFile(resolve(evidence, `${width}-goal.png`), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
      const active = await request(`/session/${id}/element/active`);
      await request(`/session/${id}/element/${Object.values(active)[0]}/value`, 'POST', { text: '\uE007' });
      assert.equal(await script(`return document.querySelector('.goal-pause-notice').open`), false, 'Goal disclosure supports keyboard toggle');
    }
    console.log(`PASS ${actualWidth}px (requested ${width}px) ${agent}: modal/mode/choices/duplicate/unknown/reload/idle/SSE-burst`);
  }
  console.log(`Evidence: ${evidence}`);
} finally {
  if (id) await request(`/session/${id}`, 'DELETE').catch(() => {});
  driver.kill(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

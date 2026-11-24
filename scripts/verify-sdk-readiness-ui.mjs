// Built UI + loopback synthetic inventory. No live Hub, credentials or native Agent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';

const evidence = await mkdtemp(resolve(tmpdir(), 'agentopsdeck-225-readiness-'));
const dist = resolve('apps/web/dist'), scope = 'b'.repeat(64), streams = new Set();
let readiness = 'starting', inventoryReads = 0, mutations = 0, locale = 'en';
let metricSession;
let compactReceipt, compactPosts = 0, compactReads = 0, stopPosts = 0;
const runId = '00000000-0000-4000-8000-000000000001';
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method !== 'GET') mutations++;
  if (path.endsWith('/events/stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: heartbeat\ndata: \n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (path.startsWith('/api/')) {
    if (req.method === 'POST' && path.endsWith('/messages')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { message, expectedRunId, idempotencyKey } = JSON.parse(raw);
      assert.equal(req.headers['x-agentopsdeck-recovery-scope'], scope);
      assert.equal(message, '/stop'); assert.equal(expectedRunId, runId);
      assert.equal(metricSession.runtime.operation, 'compact');
      stopPosts++; metricSession.runtime.stopRequested = true;
      const body = { status: 'sent', command: { id: idempotencyKey, key: idempotencyKey,
        state: 'accepted', createdAt: Date.now(), updatedAt: Date.now() } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
    }
    if (req.method === 'POST' && path.endsWith('/compact')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const { idempotencyKey } = JSON.parse(raw);
      assert.equal(req.headers['x-agentopsdeck-recovery-scope'], scope);
      compactPosts++;
      compactReceipt = { id: runId, key: idempotencyKey, state: 'accepted', createdAt: Date.now(), updatedAt: Date.now(),
        result: { status: 200, body: { ok: true, status: 'compacting', runId } } };
      metricSession.runtime = { turnId: runId, operation: 'compact', phase: 'starting', connection: 'connected', sync: 'current', threadActivity: 'running' };
      metricSession.status = 'running'; metricSession.hasActiveRun = true;
      // Native admission happened, but the first HTTP reply was lost.
      res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"fixture lost reply"}'); return;
    }
    if (path.includes('/compact-commands/')) {
      assert.equal(decodeURIComponent(path.split('/').at(-1)), compactReceipt?.key);
      compactReads++;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ command: compactReceipt })); return;
    }
    if (path.endsWith('/connections/fixture/agents')) inventoryReads++;
    const body = path === '/api/auth/status' ? { authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } }
      : path.endsWith('/sessions/state') ? { groups: metricSession ? [{ agentId: metricSession.agentId, sessions: [metricSession] }] : [], updatedAt: Date.now(), connections: [{ id: 'fixture', kind: 'remote', label: 'Fixture', status: 'enabled', capabilities: ['sessions'] }] }
      : path.endsWith('/messages') ? { messages: [], totalCount: 0, updatedAt: Date.now() }
      : path.endsWith('/connections/fixture/agents') ? { agents: ['claude-code', 'ghcp'].map(id => ({ id, label: id, ...(readiness ? { readiness } : {}) })) }
      : path.endsWith('/creation-environments') ? { environments: [], nextCursor: null }
      : path.endsWith('/workspace/preferences') ? { revision: 1, groups: [], sessions: {} }
      : path.endsWith('/notebooks') ? { items: [], nextCursor: null }
      : path === '/api/agents' ? { agents: [] }
      : path === '/api/gateway/status' ? { ok: false, enabled: false, status: 'offline', updatedAt: Date.now() } : {};
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  try {
    const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${dist}/`)) throw Error('invalid path');
    let data = await readFile(file);
    if (extname(file) === '.html') data = data.toString().replace('<head>', `<head><script>localStorage.setItem('agentopsdeck.locale',${JSON.stringify(locale)});window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));</script>`);
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const driver = spawn('geckodriver', ['--port', String(port), ...(process.env.AOD_BROWSER_PROFILE_ROOT ? ['--profile-root', process.env.AOD_BROWSER_PROFILE_ROOT] : [])], { stdio: 'ignore' });
let driverError, id;
driver.on('error', error => { driverError = error; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, method = 'GET', body) {
  if (driverError) throw driverError;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw Error(JSON.stringify(data)); return data.value;
}
const script = source => request(`/session/${id}/execute/sync`, 'POST', { script: source, args: [] });
async function until(source) {
  for (let i = 0; i < 120; i++) { if (await script(source)) return; await delay(100); }
  throw Error(`Timed out: ${source}\n${await script('return document.body.innerText')}`);
}
const dialog = `document.querySelector('[role="dialog"]')`;
const button = label => `[...${dialog}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
async function refresh() { await script(`${button(locale === 'en' ? 'Refresh environments' : '刷新环境')}.click(); return true;`); }
try {
  for (let i = 0; i < 100; i++) { try { await request('/status'); break; } catch { if (i === 99) throw Error('Driver unavailable'); await delay(100); } }
  id = (await request('/session', 'POST', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } } })).sessionId;
  for (const width of [1440, 430]) {
    const mutationsBeforeReadiness = mutations;
    locale = width === 1440 ? 'en' : 'zh-CN'; readiness = 'starting'; metricSession = undefined;
    await request(`/session/${id}/window/rect`, 'POST', { width, height: 1000 });
    await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/` });
    const openLabel = locale === 'en' ? 'New session' : '新建聊天';
    await until(`return [...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')===${JSON.stringify(openLabel)} || b.textContent.trim()===${JSON.stringify(openLabel)})`);
    await script(`[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(openLabel)} || b.textContent.trim()===${JSON.stringify(openLabel)}).click(); return true;`);
    await until(`return document.querySelector('#new-session-agent option[value="ghcp"]')`);
    await script(`const el=document.querySelector('#new-session-agent');el.value='ghcp';el.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
    const title = await request(`/session/${id}/element`, 'POST', { using: 'css selector', value: '#new-session-title' });
    await request(`/session/${id}/element/${Object.values(title)[0]}/value`, 'POST', { text: 'Retained draft' });
    const create = button(locale === 'en' ? 'Create' : '创建');
    assert.equal(await script(`return ${create}.disabled`), true);
    await request(`/session/${id}/element/${Object.values(title)[0]}/value`, 'POST', { text: '\uE007' });
    assert.equal(mutations, mutationsBeforeReadiness, 'Enter must not submit while the Agent is starting');
    await writeFile(resolve(evidence, `${width}-starting.png`), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
    readiness = 'ready';
    await until(`return !${create}.disabled`);
    assert.equal(await script(`return document.querySelector('#new-session-title').value`), 'Retained draft');
    assert.equal(await script(`return document.querySelector('#new-session-agent').value`), 'ghcp');
    readiness = 'maintenance'; await refresh(); await until(`return ${create}.disabled && ${dialog}.innerText.includes(${JSON.stringify(locale === 'en' ? 'paused for maintenance' : '因维护而暂停')})`);
    readiness = 'failed';
    await until(`return ${dialog}.innerText.includes(${JSON.stringify(locale === 'en' ? 'ownership check failed' : '独占运行检查失败')})`);
    const afterFailure = inventoryReads; await delay(3400); assert.equal(inventoryReads, afterFailure, 'Failure must not cause an endless retry loop');
    readiness = ''; await refresh(); await until(`return !${create}.disabled`);
    assert.deepEqual(await script('return window.__errors'), []);
    await writeFile(resolve(evidence, `${width}.png`), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
    readiness = 'starting'; await refresh(); await until(`return ${create}.disabled`);
    await script(`${button(locale === 'en' ? 'Cancel' : '取消')}.click();return true;`);
    const afterClose = inventoryReads; await delay(3400); assert.equal(inventoryReads, afterClose, 'Closed dialog must stop readiness polling');
    console.log(`Passed ${width}px ${locale} readiness and draft checks`);
    for (const runtime of ['claude-code', 'ghcp']) {
      metricSession = { sessionKey: `${runtime}:metric-fixture`, agentId: runtime, source: runtime,
        title: 'Native metric fixture', status: 'idle', lastActiveAt: Date.now(), compactionCount: 2,
        controlCapabilities: { compact: true },
        ...(runtime === 'claude-code' ? { contextUsedTokens: 35, contextSampleBasis: 'last-request-input',
          nativeUsage: { scope: 'last-turn', inputTokens: 20, outputTokens: 5 } }
          : { contextUsedTokens: 123, contextTokens: 1000, contextSampleBasis: 'native-context',
            nativeUsage: { scope: 'last-call', inputTokens: 99, outputTokens: 5 } }) };
      // A changed query forces a document load when swapping synthetic data;
      // a hash-only navigation would keep the previous cached inventory.
      await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/?metric=${runtime}#/session/${encodeURIComponent(metricSession.sessionKey)}` });
      // Mobile intentionally starts in the list, even with a session hash.
      if (width === 430) {
        const card = `document.querySelector('[data-session-card="${metricSession.sessionKey}"]')`;
        await until(`return ${card}`);
        await script(`${card}.click();return true;`);
      }
      const label = runtime === 'claude-code' ? (locale === 'en' ? 'Last input' : '最近输入') : (locale === 'en' ? 'ctx' : '上下文');
      await until(`return [...document.querySelectorAll('[data-session-metrics]')].some(s=>s.textContent.includes(${JSON.stringify(label)}) && s.textContent.includes(${JSON.stringify(runtime === 'claude-code' ? '35' : '123/1,000')}))`);
      const scopeLabel = locale === 'en' ? (runtime === 'claude-code' ? 'last agent turn' : 'last root-agent API call')
        : (runtime === 'claude-code' ? '最近一轮主智能体执行' : '主智能体最近一次 API 调用');
      await until(`return [...document.querySelectorAll('[data-native-usage]')].some(s=>s.title.includes(${JSON.stringify(scopeLabel)}))`);
      assert.equal(await script(`return document.querySelector('[data-native-usage]').getBoundingClientRect().height > 0`), true);
      if (runtime === 'claude-code') assert.equal(await script(`return !!document.querySelector('[aria-label^="Context usage "]')`), false, 'Last input without a native window is not a context percentage');
      assert.deepEqual(await script('return window.__errors'), []);
      await writeFile(resolve(evidence, `${width}-${runtime}-metrics.png`), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
      const postsBefore = compactPosts, readsBefore = compactReads;
      const compactButton = `[...document.querySelectorAll('button')].find(b=>b.title===${JSON.stringify(locale === 'en' ? 'Compact session' : '压缩会话')})`;
      await until(`return ${compactButton} && !${compactButton}.disabled`);
      await script(`${compactButton}.click();return true`);
      await until(`return ${compactButton}?.disabled && ${compactButton}.textContent.includes(${JSON.stringify(locale === 'en' ? 'Compacting' : '正在压缩')})`);
      await until(`return [...document.querySelectorAll('[role="status"]')].some(el=>el.textContent.includes(${JSON.stringify(locale === 'en' ? 'Compacting' : '正在压缩')}))`);
      assert.equal(compactPosts - postsBefore, 1, 'Lost POST response never resubmits');
      assert.ok(compactReads > readsBefore, 'Original compact receipt is read');
      await request(`/session/${id}/refresh`, 'POST', {});
      if (width === 430) {
        const card = `document.querySelector('[data-session-card="${metricSession.sessionKey}"]')`;
        await until(`return ${card}`); await script(`${card}.click();return true`);
      }
      await until(`return ${compactButton}?.disabled && ${compactButton}.textContent.includes(${JSON.stringify(locale === 'en' ? 'Compacting' : '正在压缩')})`);
      assert.equal(compactPosts - postsBefore, 1, 'Reload never replays compact');
      assert.deepEqual(await script('return window.__errors'), []);
      await writeFile(resolve(evidence, `${width}-${runtime}-compact.png`), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
      const stopsBefore = stopPosts;
      const stopButton = `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(locale === 'en' ? 'Stop run' : '停止')})`;
      await until(`return ${stopButton} && !${stopButton}.disabled`);
      await script(`${stopButton}.click();return true`);
      await until(`return [...document.querySelectorAll('button')].some(b=>b.disabled && b.textContent.trim()===${JSON.stringify(locale === 'en' ? 'Stop requested…' : '已请求停止…')})`);
      assert.equal(stopPosts - stopsBefore, 1, 'Exactly one identity-bound stop');
      // Native completion can win the stop race; without proof the outcome is
      // unknown. Neither a stop ACK nor a reload may manufacture completion.
      const completed = width === 1440;
      metricSession.runtime.phase = completed ? 'completed' : 'unknown';
      metricSession.runtime.threadActivity = completed ? 'idle' : 'unknown';
      metricSession.hasActiveRun = false; metricSession.status = completed ? 'idle' : 'unknown';
      await request(`/session/${id}/refresh`, 'POST', {});
      if (width === 430) {
        const card = `document.querySelector('[data-session-card="${metricSession.sessionKey}"]')`;
        await until(`return ${card}`); await script(`${card}.click();return true`);
      }
      const outcome = completed ? 'Context compacted' : '压缩结果未确认 · 未自动重试';
      await until(`return document.body.innerText.includes(${JSON.stringify(outcome)})`);
      assert.equal(await script(`return ${compactButton}.disabled`), !completed);
      assert.equal(compactPosts - postsBefore, 1, 'Terminal/unknown reload never replays compact');
      assert.equal(stopPosts - stopsBefore, 1, 'Terminal/unknown reload never replays stop');
      assert.deepEqual(await script('return window.__errors'), []);
      await writeFile(resolve(evidence, `${width}-${runtime}-${completed ? 'completed' : 'unknown'}.png`), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
    }
    console.log(`Passed ${width}px ${locale} native metrics labels and scopes`);
  }
  assert.equal(compactPosts, 4);
  assert.equal(stopPosts, 4);
  assert.equal(mutations, compactPosts + stopPosts, 'Only explicit synthetic compact/stop clicks; no create/chat/preferences writes');
  console.log(JSON.stringify({ passed: true, desktopEnglish: true, mobileChinese: true, draftRetained: true, transitions: true, oldConnectorCompatible: true, closedPollingStopped: true, compactPosts, compactReads, stopPosts, mutations, evidence }));
} finally {
  if (id) await request(`/session/${id}`, 'DELETE').catch(() => {});
  if (driver.exitCode === null && driver.signalCode === null) {
    const closed = new Promise(resolve => driver.once('close', resolve));
    driver.kill();
    const timeout = setTimeout(() => driver.kill('SIGKILL'), 5_000);
    await closed;
    clearTimeout(timeout);
  }
  for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

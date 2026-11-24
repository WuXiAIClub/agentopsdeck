// Isolated differential + real React clock test; no production API traffic.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [{ name: 'tool-preparation-probe', enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/src/components/messages.tsx')) return;
    for (const name of ['buildToolTimelineEntries', 'readableText', 'agentCallHint', 'lineCount']) {
      const marker = new RegExp(`(function ${name}\\([^)]*\\)(?:: [^{]+)? \\{)`);
      assert.ok(marker.test(code), name);
      code = code.replace(marker, `$1 (window as any).__toolCounts.${name} = ((window as any).__toolCounts.${name} ?? 0) + 1;`);
    }
    return code + '\nexport const toolPreparationTest = { buildToolTimelineEntries, withToolTimelineClock, useToolTimelineEntries, displayMessageText, readableText, isToolOutputPlaceholder, toolResultTextForTokenEstimate, toolEntryLabel, agentCallHint, toolOutputVariant, lineCount, formatTokenDelta, estimateTextTokens, formatElapsedMs, isToolExecuting, groupedToolElapsedMs };';
  }, configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__tool-preparation') return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/tests/tool-preparation.fixture.tsx"></script></body></html>'));
    });
  } }, react()],
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [], denied = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/') || route.request().method() !== 'GET') {
      denied.push(url.pathname); return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.__toolCounts = {};
    window.__toolIntervals = new Set();
    const start = window.setInterval, stop = window.clearInterval;
    // Ignore the development server's independent keepalive interval.
    window.setInterval = (...args) => { const id = start(...args); if (args[1] === 1000) window.__toolIntervals.add(id); return id; };
    window.clearInterval = id => { window.__toolIntervals.delete(id); stop(id); };
  });
  await page.goto(`${origin}/__tool-preparation`);
  await page.waitForFunction(() => !!window.probe);
  const differential = await page.evaluate(() => {
    const s = window.subject;
    const visible = entries => entries.map(({ lineCount, text, executingSince, ...entry }) => entry);
    let checks = 0;
    const compare = rows => {
      const prepared = s.buildToolTimelineEntries(rows);
      prepared.forEach(Object.freeze); Object.freeze(prepared);
      for (const now of [undefined, 0, 50_000, 250_000]) {
        const actual = visible(s.withToolTimelineClock(prepared, now));
        const expected = visible(window.oracle(rows, now, s));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`oracle mismatch ${checks}`);
        checks++;
      }
    };
    const texts = ['', '(empty)', '[tool output]', '```text\n[tool output]\n```', '普通输出\nhello',
      '[tool exec_command]\nTool input:\n{}\n[tool output]\nstatus: success\noutput:\nanswer',
      'agentId: "team-backend-dev"\nsubagent', 'sessions_send agentturn', 'HTTP/1.1 200 OK', 'remote: commit'];
    const corpus = [];
    for (const text of texts) for (const status of ['sending', 'sent', 'failed', undefined])
      for (const toolPhase of ['call', 'result', undefined]) for (const toolName of ['exec_command', 'custom', undefined]) {
        const message = { id: `m${corpus.length}`, sessionKey: `session-${corpus.length % 3}`, role: 'tool', text,
          toolCallId: `c${corpus.length % 7}`, status, toolPhase, toolName, createdAt: 1000 + corpus.length,
          toolDetailAvailable: corpus.length % 2 === 0 };
        corpus.push(message); compare([message]); compare([{ ...message, toolCallId: undefined }]);
      }
    compare(corpus); compare([...corpus].reverse());
    let seed = 12345, history = [];
    const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
    for (let i = 0; i < 300; i++) {
      const row = { ...corpus[random(corpus.length)], toolPreview: i % 3 ? undefined : 'preview override\nagentId: "team-pm"' };
      if (i % 5 === 0) history = [row, ...history];
      else if (i % 5 === 1) history = [...history, row];
      else if (i % 5 === 2) history = history.map((old, index) => index === random(history.length) ? row : old);
      else if (i % 5 === 3) history = [...history].reverse();
      else history = history.slice(1);
      compare(history);
    }
    // Operation counts, not a wall-time claim: 2,400 groups with four results.
    const groups = Array.from({ length: 2400 }, (_, i) => Array.from({ length: 4 }, (_, j) => ({
      id: `${i}-${j}`, sessionKey: 'synthetic', role: 'tool', toolCallId: `${i}-${j}`, toolPhase: 'result',
      status: 'sent', toolName: 'exec_command', createdAt: j * 1000, text: 'output line\n'.repeat(32),
    })));
    window.__toolCounts = {}; groups.forEach(rows => window.oracle(rows, undefined, s));
    const before = { ...window.__toolCounts };
    window.__toolCounts = {}; groups.forEach(rows => s.buildToolTimelineEntries(rows));
    const after = { ...window.__toolCounts };
    const longRun = [...groups.flat().slice(0, 1000), { id: 'active', sessionKey: 'synthetic', role: 'tool',
      toolCallId: 'active', toolPhase: 'call', status: 'sending', toolName: 'exec_command', createdAt: 0, text: 'running' }];
    window.__toolCounts = {};
    for (const now of [1000, 2000, 3000]) window.oracle(longRun, now, s);
    const oldTicks = { ...window.__toolCounts };
    const prepared = s.buildToolTimelineEntries(longRun);
    window.__toolCounts = {};
    for (const now of [1000, 2000, 3000]) {
      const ticked = s.withToolTimelineClock(prepared, now);
      if (!ticked.slice(0, 1000).every((entry, i) => entry === prepared[i])) throw Error('completed entries unnecessarily copied');
    }
    const newTicks = { ...window.__toolCounts };
    return { checks, before, after, oldTicks, newTicks };
  });
  assert.equal(differential.before.lineCount, 9600);
  assert.equal(differential.after.lineCount ?? 0, 0);
  assert.equal(differential.before.agentCallHint, 9600);
  assert.equal(differential.after.agentCallHint ?? 0, 0);
  assert.equal(differential.oldTicks.readableText, 3003);
  assert.deepEqual(differential.newTicks, {});
  console.log(JSON.stringify({ kind: 'tool-preparation-oracle', ...differential }));

  const call = { id: 'call', sessionKey: 's', role: 'tool', toolCallId: 'c', toolPhase: 'call',
    status: 'sending', toolName: 'exec_command', text: 'run command', createdAt: Date.now() - 5000 };
  for (const status of ['sent', 'failed', undefined]) {
    await page.evaluate(row => window.setProbeMessages([row]), { ...call, status });
    await page.waitForFunction(status => window.probeMessages[0]?.status === status && window.probe.entries.length === 1 && window.probe.liveNow === undefined, status);
    assert.equal(await page.evaluate(() => window.__toolIntervals.size), 0, 'settled unmatched calls must not tick');
  }
  await page.evaluate(row => { window.__toolCounts = {}; window.setProbeMessages([row]); }, call);
  await page.waitForFunction(() => window.__toolIntervals.size === 3 && window.probe.entries[0]?.hint?.startsWith('executing ·'));
  const beforeTick = await page.evaluate(() => ({ counts: { ...window.__toolCounts }, hint: window.probe.entries[0].hint }));
  await page.waitForFunction(hint => window.probe.entries[0].hint !== hint, beforeTick.hint);
  assert.deepEqual(await page.evaluate(() => window.__toolCounts), beforeTick.counts, 'clock must not reparse text');
  await page.evaluate(() => window.rerenderProbe());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.__toolCounts), beforeTick.counts, 'detail-like rerender must not reparse');
  await page.locator('.mobile-tool-pill').click();
  assert.equal(await page.locator('.mobile-tool-strip-detail').textContent(), call.text);
  await page.locator('.desktop-tool-chip').click();
  assert.equal(await page.locator('.desktop-tool-detail pre').textContent(), call.text);
  assert.deepEqual(await page.evaluate(() => window.__toolCounts), beforeTick.counts, 'actual detail expansion must not reparse');
  await page.evaluate(row => window.setProbeMessages([row]), { ...call, toolPreview: 'streamed preview' });
  await page.waitForFunction(() => document.querySelector('.desktop-tool-detail pre')?.textContent === 'streamed preview');
  assert.equal(await page.locator('.mobile-tool-strip-detail').textContent(), 'streamed preview');
  assert.equal(await page.evaluate(() => window.__toolCounts.buildToolTimelineEntries), beforeTick.counts.buildToolTimelineEntries + 3,
    'immutable preview replacement invalidates all three component-owned memos');
  await page.evaluate(row => window.setProbeMessages([row]), { ...call, status: 'sent' });
  await page.waitForFunction(() => window.__toolIntervals.size === 0 && window.probe.entries[0]?.hint === undefined);
  await page.evaluate(row => window.setProbeMessages([row]), call);
  await page.waitForFunction(() => window.__toolIntervals.size === 3);
  const result = { ...call, id: 'result', toolPhase: 'result', status: 'sent', text: 'completed output', createdAt: call.createdAt + 500 };
  await page.evaluate(rows => window.setProbeMessages(rows), [result, call]);
  await page.waitForFunction(() => window.__toolIntervals.size === 0 && window.probe.entries[0]?.phaseLabel === 'call + result');
  assert.equal(await page.evaluate(() => window.probe.entries[0].hint), undefined);
  assert.equal(await page.locator('.desktop-tool-detail pre').textContent(), 'run command\n\ncompleted output');
  assert.equal(await page.locator('.mobile-tool-strip-detail').textContent(), 'run command\n\ncompleted output');
  // Same call ID in a different session must not stop this session's clock.
  await page.evaluate(rows => window.setProbeMessages(rows), [call, { ...result, sessionKey: 'other' }]);
  await page.waitForFunction(() => window.__toolIntervals.size === 3 && window.probe.entries.length === 2);
  await page.evaluate(() => window.unmountProbe());
  assert.equal(await page.evaluate(() => window.__toolIntervals.size), 0, 'unmount clears clock');
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log('tool preparation clock PASS: live hint, zero reparse ticks/rerenders, result-before-call, session isolation, settled clock cleanup, unmount');
} finally { await browser?.close(); await server.close(); }

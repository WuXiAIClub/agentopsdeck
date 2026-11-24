import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { HistoryDiagnostics, observeHistoryStage, timeHistoryAsync, timeHistorySync, withoutHistoryDiagnostics } from './history-diagnostics.js';
import { ReadTimings } from './read-timings.js';
import { createConditionalHistory } from '../messages/conditional-history.js';

test('broken history observation clocks do not replace successful or denied HTTP responses', async () => {
  for (const failureAt of [1, 2]) {
    for (const invalid of ['throw', NaN, Infinity, -Infinity]) {
      let calls = 0;
      const stats = new HistoryDiagnostics(() => {
        if (++calls !== failureAt) return 100;
        if (invalid === 'throw') throw Error('private-observation-clock');
        return invalid as number;
      });
      const app = new Hono(); app.use('/*', stats.middleware());
      app.get('/messages', c => { observeHistoryStage('sql', 3); return c.json({ retained: true }); });
      app.get('/denied', c => c.json({ error: 'denied' }, 403));
      const response = await app.request('/messages');
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { retained: true });
      assert.match(response.headers.get('server-timing')!, /app;dur=0.0/);
      assert.match(response.headers.get('server-timing')!, /sql;dur=3.0/);
      const denied = await app.request('/denied');
      assert.equal(denied.status, 403); assert.equal(denied.headers.get('server-timing'), null);
      assert.equal(stats.snapshot().total.calls, 2);
      assert.ok(!JSON.stringify(stats.snapshot()).includes('private-observation'));
    }
  }
});

test('a failed ending observation cannot mask the original history failure', async () => {
  const original = Error('original-read-failure'); let calls = 0;
  const stats = new HistoryDiagnostics(() => { if (++calls === 2) throw Error('clock'); return 100; });
  const context = { req: { method: 'GET', raw: new Request('http://synthetic/messages') },
    res: { status: 500 }, header: () => {} };
  await assert.rejects(stats.middleware()(context as any, async () => { throw original; }), error => error === original);
  assert.equal(stats.snapshot().total.failures, 1);
  assert.equal(stats.snapshot().statuses['500'], 1);
});

test('SQL/JSON/encode are measured per HTTP read, including conditional 304', async () => {
  const app = new Hono(), stats = new HistoryDiagnostics(), timings = new ReadTimings(), conditional = createConditionalHistory();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE fixture(data TEXT); INSERT INTO fixture VALUES ('{"id":"one"}')`);
    app.use('/messages', stats.middleware());
    app.get('/messages', c => {
      const messages = timeHistorySync('page', () => [...timings.rows(db.prepare('SELECT data FROM fixture').iterate())].map(row => timings.parse(String(row.data))));
      c.header('Server-Timing', 'existing;dur=1');
      return conditional(c, { messages, updatedAt: 1 });
    });
    const first = await app.request('/messages'); assert.equal(first.status, 200);
    for (const name of ['existing', 'app', 'sql', 'json', 'page', 'encode']) assert.match(first.headers.get('server-timing')!, new RegExp(`${name};dur=`));
    const second = await app.request('/messages', { headers: { 'if-none-match': first.headers.get('etag')! } });
    assert.equal(second.status, 304); assert.equal(await second.text(), '');
    const snapshot = stats.snapshot();
    assert.equal(snapshot.total.calls, 2); assert.equal(snapshot.statuses['200'], 1); assert.equal(snapshot.statuses['304'], 1);
    assert.equal(snapshot.stages.sql.calls, 4); assert.equal(snapshot.stages.json.calls, 2); assert.equal(snapshot.stages.encode.calls, 2);
    snapshot.stages.json.calls = 999; snapshot.statuses['200'] = 999;
    assert.equal(stats.snapshot().stages.json.calls, 2); assert.equal(stats.snapshot().statuses['200'], 1);
  } finally { db.close(); }
});

test('concurrent requests do not subtract global counters or borrow another request stages', async () => {
  const app = new Hono(), stats = new HistoryDiagnostics();
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  app.use('/*', stats.middleware());
  app.get('/slow', async c => {
    await timeHistoryAsync('connectorWait', async () => { started(); await gate; observeHistoryStage('json', 13); });
    return c.json({ ok: true });
  });
  app.get('/fast', c => { observeHistoryStage('sql', 7); return c.json({ ok: true }); });
  const slow = app.request('/slow'); await ready;
  const fast = await app.request('/fast'); resume(); const later = await slow;
  assert.match(fast.headers.get('server-timing')!, /sql;dur=7.0/); assert.doesNotMatch(fast.headers.get('server-timing')!, /json|connectorWait/);
  assert.match(later.headers.get('server-timing')!, /json;dur=13.0/); assert.doesNotMatch(later.headers.get('server-timing')!, /sql/);
  assert.equal(stats.snapshot().stages.json.ms, 13); assert.equal(stats.snapshot().stages.sql.ms, 7);
});

test('shared or late detached work cannot be assigned to an HTTP waiter', async () => {
  const app = new Hono(), stats = new HistoryDiagnostics();
  let release!: () => void, late: Promise<void>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  app.use('/*', stats.middleware());
  app.get('/messages', async c => {
    await withoutHistoryDiagnostics(async () => { await Promise.resolve(); observeHistoryStage('sql', 100); });
    late = gate.then(() => { observeHistoryStage('json', 200); });
    return c.json({ status: 'pending' }, 202);
  });
  const response = await app.request('/messages'); release(); await late!;
  assert.equal(response.status, 202); assert.equal(stats.snapshot().stages.sql.calls, 0); assert.equal(stats.snapshot().stages.json.calls, 0);
  observeHistoryStage('page', 999); assert.equal(stats.snapshot().stages.page.calls, 0);
});

test('503 has phase failure counts, not error text; unauthorized responses have no timing header', async () => {
  const app = new Hono(), stats = new HistoryDiagnostics(), timings = new ReadTimings();
  app.use('/*', stats.middleware());
  app.get('/private-session/messages', c => {
    try { timeHistorySync('page', () => timings.parse('private-invalid-payload')); }
    catch { return c.json({ error: 'History unavailable' }, 503); }
    return c.json({});
  });
  app.get('/denied', c => c.json({ error: 'denied' }, 403));
  app.get('/sql-error', c => {
    try { [...timings.rows({ *[Symbol.iterator]() { throw Error('private SQL'); } })]; }
    catch { return c.json({ error: 'History unavailable' }, 503); }
    return c.json({});
  });
  assert.equal((await app.request('/private-session/messages')).status, 503);
  assert.equal((await app.request('/sql-error')).status, 503);
  assert.equal((await app.request('/denied')).headers.get('server-timing'), null);
  const snapshot = stats.snapshot();
  assert.equal(snapshot.statuses['503'], 2); assert.equal(snapshot.stages.page.failures, 1); assert.equal(snapshot.stages.json.failures, 1); assert.equal(snapshot.stages.sql.failures, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|payload|session|SELECT/);
});

test('aborts and unknown status codes use bounded counters; non-GET does not record', async () => {
  const app = new Hono(), stats = new HistoryDiagnostics(), abort = new AbortController();
  app.use('/*', stats.middleware());
  app.get('/abort', c => { abort.abort(); return c.json({}, 503); });
  app.get('/odd', c => c.json({}, 418)); app.post('/mutate', c => c.json({}));
  await app.request('/abort', { signal: abort.signal }); await app.request('/odd'); await app.request('/mutate', { method: 'POST' });
  assert.equal(stats.snapshot().statuses['499'], 1); assert.equal(stats.snapshot().statuses.other, 1); assert.equal(stats.snapshot().total.calls, 2);
});

test('503 phase failures and latency are correlated separately from successful requests', async () => {
  let clock = 0;
  const app = new Hono(), stats = new HistoryDiagnostics(() => clock);
  app.use('/*', stats.middleware());
  app.get('/fast', c => { clock += 5; observeHistoryStage('sql', 2); return c.json({}); });
  app.get('/failure', c => { clock += 1000; observeHistoryStage('json', 8, true); return c.json({}, 503); });
  app.get('/overflow', c => { clock += 60_001; return c.json({}, 503); });
  await app.request('/fast'); await app.request('/failure'); await app.request('/overflow');
  const snapshot = stats.snapshot(), ok = snapshot.byStatus['200']!, failure = snapshot.byStatus['503']!;
  assert.equal(ok.total.calls, 1); assert.equal(ok.total.ms, 5);
  assert.equal(ok.stages.sql!.calls, 1); assert.equal(ok.stages.json!.failures, 0);
  assert.equal(failure.total.calls, 2); assert.equal(failure.total.ms, 61_001);
  assert.equal(failure.total.failures, 2); assert.equal(failure.stages.json!.failures, 1); assert.equal(failure.stages.sql!.calls, 0);
  assert.equal(ok.latency[snapshot.latencyUpperBoundsMs.indexOf(5)], 1);
  assert.equal(failure.latency[snapshot.latencyUpperBoundsMs.indexOf(1000)], 1);
  assert.equal(failure.latency.at(-1), 1); assert.equal(snapshot.latencyUpperBoundsMs.at(-1), null);
  ok.latency.fill(999); ok.stages.sql!.calls = 999; ok.total.calls = 999;
  snapshot.latencyUpperBoundsMs.fill(null);
  assert.equal(stats.snapshot().byStatus['200']!.total.calls, 1);
  assert.equal(stats.snapshot().byStatus['200']!.stages.sql!.calls, 1);
  assert.equal(stats.snapshot().byStatus['200']!.latency.reduce((a, b) => a + b, 0), 1);
  assert.equal(stats.snapshot().latencyUpperBoundsMs[0], 1);
});

test('grouped diagnostics preserve request isolation and fixed storage across unknown statuses', async () => {
  const app = new Hono(), stats = new HistoryDiagnostics();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  app.use('/*', stats.middleware());
  app.get('/slow', async c => { started(); await gate; observeHistoryStage('connectorWait', 123, true); return c.json({}, 503); });
  app.get('/fast', c => { observeHistoryStage('sql', 7); return c.json({}); });
  app.get('/odd', c => c.json({}, 418));
  const slow = app.request('/slow'); await ready; await app.request('/fast'); release(); await slow;
  for (let i = 0; i < 100; i++) await app.request('/odd');
  const snapshot = stats.snapshot();
  assert.equal(Object.keys(snapshot.byStatus).length, 15);
  assert.equal(snapshot.byStatus.other!.total.calls, 100);
  assert.equal(snapshot.byStatus['200']!.stages.sql!.ms, 7);
  assert.equal(snapshot.byStatus['503']!.stages.connectorWait!.ms, 123);
  assert.equal(snapshot.byStatus['503']!.stages.sql!.calls, 0);
  assert.equal(snapshot.byStatus['200']!.stages.connectorWait!.calls, 0);
  assert.ok(JSON.stringify(snapshot).length < 14000);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryRefresh, gatewayHistoryRows } from './history.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const fresh of [false, true]) test(`warm history cannot bypass or survive a failed ${fresh ? 'authoritative' : 'forced'} refresh`, async () => {
  const started = gate(), finish = gate();
  let reads = 0;
  const refresh = createHistoryRefresh(async () => {
    if (++reads === 2) { started.resolve(); await finish.promise; throw new Error('synthetic history outage'); }
  });
  await refresh('synthetic');
  const forced = assert.rejects(refresh('synthetic', { fresh }), /synthetic history outage/);
  await started.promise;
  const cached = assert.rejects(refresh('synthetic', { maxAgeMs: 60_000 }), /synthetic history outage/);
  finish.resolve();
  await Promise.all([forced, cached]);
  assert.equal(reads, 2, 'warm readers share the current read, not a second attempt');
  await refresh('synthetic', { maxAgeMs: 60_000 });
  assert.equal(reads, 3, 'failed refresh invalidates the prior success');
});

test('fresh history drains an older projection then makes an authoritative read despite maxAge', async () => {
  const started = gate(), finish = gate();
  const calls: Array<[string, boolean]> = [];
  const refresh = createHistoryRefresh(async (key, authoritative) => {
    calls.push([key, authoritative]);
    if (calls.length === 1) { started.resolve(); await finish.promise; }
  });
  const old = refresh('a'); await started.promise;
  const fresh = refresh('a', { fresh: true, maxAgeMs: 60_000 });
  await refresh('b');
  assert.deepEqual(calls, [['a', false], ['b', false]], 'other sessions remain independent');
  finish.resolve(); await Promise.all([old, fresh]);
  assert.deepEqual(calls, [['a', false], ['b', false], ['a', true]]);
  await refresh('a', { maxAgeMs: 60_000 });
  assert.equal(calls.length, 3);
});

test('fresh history survives failure of the pre-terminal read; failed reads are never cached as success', async () => {
  const started = gate(), finish = gate(); let calls = 0;
  const refresh = createHistoryRefresh(async () => {
    if (++calls === 1) { started.resolve(); await finish.promise; }
    if (calls < 3) throw new Error('Synthetic read failure');
  });
  const old = assert.rejects(refresh('a')); await started.promise;
  const fresh = assert.rejects(refresh('a', { fresh: true }));
  finish.resolve(); await Promise.all([old, fresh]);
  await refresh('a', { maxAgeMs: 60_000 });
  assert.equal(calls, 3);
});

test('multiple terminal reads serialize while ordinary readers share the active projection', async () => {
  const started = gate(), finish = gate(); let calls = 0, active = 0, max = 0;
  const refresh = createHistoryRefresh(async () => {
    max = Math.max(max, ++active);
    if (++calls === 1) { started.resolve(); await finish.promise; }
    active--;
  });
  const first = refresh('a', { fresh: true }); await started.promise;
  const ordinary = refresh('a');
  const second = refresh('a', { fresh: true }), third = refresh('a', { fresh: true });
  finish.resolve(); await Promise.all([first, ordinary, second, third]);
  assert.equal(calls, 3); assert.equal(max, 1);
});

test('history validates payload and session identity without requiring a final assistant text', () => {
  for (const result of [[], { messages: [] }, { sessionKey: 'a', messages: [] }, { messages: [{ role: 'tool' }] }]) {
    assert.ok(Array.isArray(gatewayHistoryRows(result, 'a')));
  }
  for (const result of [null, undefined, false, '', {}, { messages: {} }, { messages: [null] },
    [false], [[]], { sessionKey: 'b', messages: [] }]) assert.throws(() => gatewayHistoryRows(result, 'a'));
});

for (const failed of [false, true]) test(`history close drains the original projection ${failed ? 'failure' : 'success'} and rejects pending terminal followers`, async () => {
  const started = gate(), finish = gate();
  let reads = 0, finalized = false, closed = false;
  const refresh = createHistoryRefresh(async () => {
    reads++; started.resolve();
    try { await finish.promise; if (failed) throw new Error('synthetic projection failure'); }
    finally { finalized = true; }
  });
  const first = refresh('synthetic').then(() => undefined, error => error);
  await started.promise;
  const follower = refresh('synthetic', { fresh: true }).then(() => undefined, error => error);
  const closing = refresh.close();
  assert.equal(refresh.close(), closing);
  void closing.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(finalized, false);
  await assert.rejects(refresh('synthetic'), /closed/);
  await assert.rejects(refresh('other', { fresh: true }), /closed/);
  finish.resolve();
  await closing;
  assert.equal(finalized, true);
  assert.equal(reads, 1, 'terminal follower cannot start another read after the owner closes');
  assert.match(String(await follower), /closed/);
  if (failed) assert.match(String(await first), /synthetic projection failure/);
  else assert.equal(await first, undefined);
  assert.equal(refresh.ready('synthetic'), false);
});

test('history close revokes warm readiness and prevents a cache hit from bypassing closure', async () => {
  let reads = 0;
  const refresh = createHistoryRefresh(async () => { reads++; });
  await refresh('synthetic');
  assert.equal(refresh.ready('synthetic'), true);
  await refresh.close();
  assert.equal(refresh.ready('synthetic'), false);
  await assert.rejects(refresh('synthetic', { maxAgeMs: 60_000 }), /closed/);
  assert.equal(reads, 1);
});

test('history close retains every independent original session until its own cleanup completes', async () => {
  const first = gate(), second = gate(), started = gate();
  let reads = 0, closed = false;
  const refresh = createHistoryRefresh(async sessionKey => {
    if (++reads === 2) started.resolve();
    await (sessionKey === 'first' ? first.promise : second.promise);
  });
  const firstRead = refresh('first'), secondRead = refresh('second');
  await started.promise;
  const closing = refresh.close().then(() => { closed = true; });
  first.resolve(); await firstRead;
  assert.equal(closed, false);
  second.resolve(); await Promise.all([secondRead, closing]);
  assert.equal(closed, true);
});

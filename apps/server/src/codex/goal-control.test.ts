import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readGoalControl, readGoalControlSnapshot, readSessionSettingsResult, type GoalControl } from '@agentopsdeck/shared';
import { goalSnapshot, goalMutation, goalAcknowledged } from './goal-control.js';
import { CodexAppServer } from './app-server.js';
import { GoalDiagnostics } from './goal-diagnostics.js';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';

const goal = { threadId: 'thread', objective: 'Scoped task', status: 'active', tokenBudget: 1000,
  tokensUsed: 45, timeUsedSeconds: 30, createdAt: 1, updatedAt: 2 };
const revision = 'a'.repeat(64);

test('goal controls reject malformed, mixed and implicit spending instructions', () => {
  for (const value of [null, [], {}, { action: 'pause', expectedRevision: 'old' },
    { action: 'resume', expectedRevision: revision, tokenBudget: 10 },
    { action: 'clear', expectedRevision: revision, objective: 'x' },
    { action: 'edit', expectedRevision: revision },
    { action: 'edit', expectedRevision: revision, objective: ' ' },
    { action: 'edit', expectedRevision: revision, objective: 'x'.repeat(2001) },
    { action: 'edit', expectedRevision: revision, tokenBudget: null },
    { action: 'edit', expectedRevision: revision, tokenBudget: 0 },
    { action: 'create', expectedRevision: revision, objective: 'x', tokenBudget: 0 },
    { action: 'edit', expectedRevision: revision, tokenBudget: -1 },
    { action: 'edit', expectedRevision: revision, tokenBudget: 1.5 },
    { action: 'edit', expectedRevision: revision, tokenBudget: Number.MAX_SAFE_INTEGER + 1 },
    { action: 'create', expectedRevision: revision, objective: 'x' },
    { action: 'pause', expectedRevision: revision, status: 'active' }]) assert.equal(readGoalControl(value), undefined);
  for (const action of ['pause', 'resume', 'clear'] as const) assert.deepEqual(readGoalControl({ action, expectedRevision: revision }), { action, expectedRevision: revision });
  const create = { action: 'create', expectedRevision: revision, objective: 'x', tokenBudget: 1 };
  assert.deepEqual(readGoalControl(create), create);
  assert.equal(readSessionSettingsResult({ sessionKey: 's', settings: { goalControl: 'pause', objective: 'private' } }, 's'), undefined);
  assert.deepEqual(readSessionSettingsResult({ sessionKey: 's', settings: { goalControl: 'pause' } }, 's'), { sessionKey: 's', settings: { goalControl: 'pause' } });
});

test('goal snapshot hashes full objective and authority, not usage; preview never leaks extras', () => {
  const raw = { ...goal, objective: 'x'.repeat(2200), private: 'secret' };
  const before = goalSnapshot({ goal: raw }, 'thread', 'connection');
  assert.equal(before.goal?.objective.length, 2000);
  assert.equal(before.goal?.objectiveTruncated, true);
  assert.deepEqual(readGoalControlSnapshot(before), before);
  assert.ok(!JSON.stringify(before).includes('secret'));
  assert.equal(goalSnapshot({ goal: { ...raw, tokensUsed: 50, updatedAt: 3 } }, 'thread', 'connection').revision, before.revision);
  for (const patch of [{ objective: raw.objective + 'y' }, { status: 'paused' }, { tokenBudget: 0 }, { createdAt: 2 }]) {
    assert.notEqual(goalSnapshot({ goal: { ...raw, ...patch } }, 'thread', 'connection').revision, before.revision);
  }
  assert.notEqual(goalSnapshot({ goal: raw }, 'thread', 'replacement').revision, before.revision);
  assert.throws(() => goalSnapshot({ goal: raw }, 'wrong', 'connection'));
  assert.throws(() => goalSnapshot({}, 'thread', 'connection'));
  assert.equal(goalSnapshot({ goal: null }, 'thread', 'connection').goal, null);
});

test('edit preserves native state, clear has no fabricated status, create/resume explicitly activate', () => {
  const before = goalSnapshot({ goal }, 'thread', 'connection');
  assert.deepEqual(goalMutation({ action: 'edit', expectedRevision: before.revision, tokenBudget: 1 }, before, 'thread'),
    { method: 'thread/goal/set', params: { threadId: 'thread', tokenBudget: 1 } });
  for (const action of ['pause', 'resume', 'clear'] as const) {
    const control = { action, expectedRevision: before.revision };
    const mutation = goalMutation(control, before, 'thread');
    assert.deepEqual(mutation.params, action === 'clear' ? { threadId: 'thread' } : { threadId: 'thread', status: action === 'pause' ? 'paused' : 'active' });
    assert.equal(goalAcknowledged(action === 'clear' ? { cleared: true } : { goal: { ...goal, status: action === 'pause' ? 'paused' : 'active' } }, control, 'thread'), true);
    assert.equal(goalAcknowledged({}, control, 'thread'), false);
  }
  assert.throws(() => goalMutation({ action: 'pause', expectedRevision: revision }, before, 'thread'));
  assert.throws(() => goalMutation({ action: 'create', expectedRevision: before.revision, objective: 'x', tokenBudget: 1 }, before, 'thread'));
  const empty = goalSnapshot({ goal: null }, 'thread', 'connection');
  assert.throws(() => goalMutation({ action: 'resume', expectedRevision: empty.revision }, empty, 'thread'));
  assert.deepEqual(goalMutation({ action: 'create', expectedRevision: empty.revision, objective: 'x', tokenBudget: 1 }, empty, 'thread').params,
    { threadId: 'thread', objective: 'x', tokenBudget: 1, status: 'active' });
  assert.equal(goalAcknowledged({ goal }, { action: 'edit', expectedRevision: revision, tokenBudget: 0 }, 'thread'), false);
});

function fixture(t: TestContext, requestTimeoutMs = 10) {
  const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', requestTimeoutMs, store, turnQueue: users.turns, executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any, key = 'codex:thread';
  t.after(async () => { runtime.child = undefined; await codex.close(); users.close(); });
  runtime.setConnection('connection');
  runtime.ensureStarted = () => assert.fail('Goal control cannot launch native');
  store.upsertSession({ sessionKey: key, title: 'Test', agentId: 'codex', status: 'idle' });
  const control: GoalControl = { action: 'pause', expectedRevision: goalSnapshot({ goal }, 'thread', 'connection').revision };
  return { users, store, codex, runtime, key, control };
}

test('Goal diagnostics share the read trace and distinguish a stale preflight without dispatch', async t => {
  const f = fixture(t), logs: any[] = [];
  f.runtime.goalDiagnostics = new GoalDiagnostics(line => logs.push(JSON.parse(line)));
  let release!: (raw: unknown) => void;
  f.runtime.request = async (method: string) => {
    assert.equal(method, 'thread/goal/get');
    return new Promise(resolve => { release = resolve; });
  };
  const first = f.codex.readGoalControl(f.key, () => {});
  const second = f.codex.readGoalControl(f.key, () => {});
  release({ goal }); await Promise.all([first, second]);
  assert.deepEqual(logs.map(log => log.event), ['read_started', 'read_joined', 'read_completed']);
  assert.equal(new Set(logs.map(log => log.operation)).size, 1);
  const failed = assert.rejects(f.codex.changeGoal(f.key, { ...f.control, expectedRevision: 'a'.repeat(64) },
    () => {}, () => assert.fail('No dispatch'), () => assert.fail('No ACK')));
  release({ goal }); await failed;
  assert.ok(logs.some(log => log.event === 'control_conflict'));
  assert.ok(logs.some(log => log.event === 'preflight_failed'));
  assert.ok(!logs.some(log => log.event === 'dispatch_started' || log.event === 'outcome_unknown'));
});

test('throwing diagnostic sink cannot prevent a single Goal dispatch or durable ACK', async t => {
  const f = fixture(t); let began = 0, ack = 0;
  f.runtime.goalDiagnostics = new GoalDiagnostics(() => { throw new Error('sink unavailable'); });
  const writes = wire(f), write = f.runtime.child.stdin.write;
  f.runtime.child.stdin.write = (line: string) => {
    write(line);
    const rpc = JSON.parse(line);
    if (rpc.method === 'thread/goal/set') queueMicrotask(() => {
      f.runtime.receive(JSON.stringify({ id: rpc.id, result: { goal: { ...goal, status: 'paused' } } }));
    });
  };
  await f.codex.changeGoal(f.key, f.control, () => {}, () => { began++; }, () => { ack++; });
  assert.equal(began, 1); assert.equal(ack, 1);
  assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get', 'thread/goal/set']);
  assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'paused');
});

for (const event of ['stale', 'notification', 'connection', 'authorization', 'unavailable', 'begin-denial']) {
  test(`goal preflight ${event} prevents every native write`, async t => {
    const f = fixture(t); let reads = 0, begun = 0, authorized = true;
    if (event === 'unavailable') f.runtime.executionUnavailable = true;
    f.runtime.request = async (method: string, _params: unknown, _timeout: unknown, receipt: any) => {
      if (method !== 'thread/goal/get') { receipt.beforeWrite(); assert.fail('No write allowed'); }
      assert.equal(method, 'thread/goal/get'); reads++;
      if (event === 'notification') f.runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal });
      if (event === 'connection') f.runtime.setConnection('replacement');
      if (event === 'authorization') authorized = false;
      return { goal: event === 'stale' ? { ...goal, objective: 'changed' } : goal };
    };
    await assert.rejects(f.codex.changeGoal(f.key, f.control, () => { if (!authorized) throw new Error('revoked'); },
      () => { if (event === 'begin-denial') throw new Error('admission denied'); begun++; }, () => assert.fail('No ACK')));
    assert.equal(begun, 0); assert.equal(reads, event === 'unavailable' ? 0 : 1);
    assert.equal(f.users.codexExecutions.get(f.key), undefined);
  });
}

for (const event of ['none', 'notification', 'connection', 'revocation', 'malformed', 'ack-disk']) {
  test(`goal one-write acknowledgement handles ${event} without replay or stale projection`, async t => {
    const f = fixture(t), calls: string[] = []; let authorized = true, begun = false, ack = false;
    f.runtime.request = async (method: string, params: unknown, _timeout: unknown, receipt: any) => {
      calls.push(method);
      if (method === 'thread/goal/get') return { goal };
      receipt.beforeWrite();
      assert.equal(method, 'thread/goal/set'); assert.equal(begun, true);
      assert.deepEqual(params, { threadId: 'thread', status: 'paused' });
      if (event === 'notification') f.runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status: 'complete' } });
      if (event === 'connection') f.runtime.setConnection('replacement');
      if (event === 'revocation') authorized = false;
      return event === 'malformed' ? {} : { goal: { ...goal, status: 'paused' } };
    };
    const change = f.codex.changeGoal(f.key, f.control, () => { if (!authorized) throw new Error('revoked'); }, () => { begun = true; }, () => {
      if (event === 'ack-disk') throw new Error('disk');
      assert.notEqual(f.store.getSession(f.key)?.codexGoal?.status, 'paused', 'ACK persists before projection'); ack = true;
    });
    if (event === 'malformed' || event === 'ack-disk') await assert.rejects(change); else await change;
    assert.deepEqual(calls, ['thread/goal/get', 'thread/goal/set']);
    assert.equal(ack, event !== 'malformed' && event !== 'ack-disk');
    assert.equal(f.store.getSession(f.key)?.codexGoal?.status, event === 'notification' ? 'complete' : event === 'connection' ? undefined : ack ? 'paused' : 'active');
    assert.equal(f.users.codexExecutions.get(f.key), undefined);
  });
}

function wire(f: ReturnType<typeof fixture>, preflight: () => void = () => {}) {
  const writes: Array<{ id: number; method: string }> = [];
  f.runtime.child = { stdin: { writable: true, write(line: string) {
    const rpc = JSON.parse(line); writes.push(rpc);
    if (rpc.method === 'thread/goal/get') queueMicrotask(() => {
      f.runtime.receive(JSON.stringify({ id: rpc.id, result: { goal } })); preflight();
    });
  } } };
  return writes;
}

function ownedGate() { let release!: () => void; const promise = new Promise<void>(ok => { release = ok; }); return { promise, release }; }
const ownedTick = () => new Promise<void>(ok => setImmediate(ok));

test('owned Goal awaits durable begin and refuses a changed native observation without waiting for Goal idle', async t => {
  const f = fixture(t), writes = wire(f), entered = ownedGate(), begin = ownedGate();
  const changing = f.codex.changeGoalOwned(f.key, f.control, () => {}, async () => { entered.release(); await begin.promise; },
    async () => assert.fail('changed observation must not ACK'));
  const rejected = assert.rejects(changing, /Goal changed|Codex execution is not available for dispatch/);
  try {
    await entered.promise;
    assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get']);
    f.runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status: 'complete' } });
    begin.release(); await rejected;
    assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get']);
  } finally { begin.release(); await rejected; }
});

test('owned timely Goal ACK waits durable settlement before projection and close drains the ACK', async t => {
  const f = fixture(t, 2000), writes = wire(f), entered = ownedGate(), ack = ownedGate(); let accepted = 0;
  const changing = f.codex.changeGoalOwned(f.key, f.control, () => {}, async () => {}, async () => {
    accepted++; entered.release(); await ack.promise;
  });
  try {
    for (let i = 0; writes.length < 2 && i < 30; i++) await ownedTick();
    assert.equal(writes.length, 2);
    f.runtime.receive(JSON.stringify({ id: writes[1]!.id, result: { goal: { ...goal, status: 'paused' } } }));
    await entered.promise;
    assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'active');
    let closed = false; const closing = f.codex.close().then(() => { closed = true; });
    await ownedTick(); assert.equal(closed, false);
    ack.release(); await Promise.all([changing, closing]); assert.equal(accepted, 1);
  } finally { ack.release(); await changing; }
});

test('owned timeout preserves the original late ACK, ignores revoked reader and does not project over newer Goal', async t => {
  const f = fixture(t), writes = wire(f), entered = ownedGate(), ack = ownedGate(); let revoked = false, accepted = 0;
  const changing = f.codex.changeGoalOwned(f.key, f.control, () => { if (revoked) throw Error('revoked'); }, async () => {}, async () => {
    accepted++; entered.release(); await ack.promise;
  });
  await assert.rejects(changing, /timed out/i);
  assert.equal(writes.length, 2); revoked = true;
  f.runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status: 'complete' } });
  const reply = JSON.stringify({ id: writes[1]!.id, result: { goal: { ...goal, status: 'paused' } } });
  f.runtime.receive(reply); f.runtime.receive(reply); await entered.promise;
  try {
    assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'complete');
    const project = f.store.upsertSession.bind(f.store);
    f.store.upsertSession = session => {
      assert.notEqual(session.codexGoal?.status, 'paused', 'late ACK must not project over a newer observation');
      return project(session);
    };
    let closed = false; const closing = f.codex.close().then(() => { closed = true; }); await ownedTick(); assert.equal(closed, false);
    ack.release(); await closing; assert.equal(accepted, 1);
  } finally { ack.release(); }
});

for (const hydrationFirst of [true, false]) {
  test(`Goal panel and history share one observation (history first: ${hydrationFirst})`, async t => {
    const f = fixture(t);
    let reads = 0, release!: (value: unknown) => void;
    f.runtime.request = async (method: string) => {
      assert.equal(method, 'thread/goal/get'); reads++;
      return new Promise(resolve => { release = resolve; });
    };
    const pending: Promise<unknown>[] = [];
    if (hydrationFirst) pending.push(f.runtime.hydrateGoal(f.key));
    const panel = f.codex.readGoalControl(f.key, () => {});
    pending.push(panel, f.codex.readGoalControl(f.key, () => {}));
    if (!hydrationFirst) pending.push(f.runtime.hydrateGoal(f.key));
    assert.equal(reads, 1, 'readers must not invalidate each other or duplicate native reads');
    release({ goal });
    await Promise.all(pending);
    assert.equal((await panel).revision, f.control.expectedRevision);
    assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'active');
    assert.equal(f.users.codexExecutions.get(f.key), undefined);
  });
}

test('overlapping local Goal writes reject instead of sharing a preflight and both dispatching', async t => {
  const f = fixture(t); let writes = 0, begins = 0, acks = 0;
  const logs: any[] = [];
  f.runtime.goalDiagnostics = new GoalDiagnostics(line => logs.push(JSON.parse(line)));
  let release!: (value: unknown) => void;
  f.runtime.request = async (method: string, _params: unknown, _timeout: unknown, receipt: any) => {
    if (method === 'thread/goal/get') return { goal };
    receipt.beforeWrite(); writes++;
    return new Promise(resolve => { release = resolve; });
  };
  const first = f.codex.changeGoal(f.key, f.control, () => {}, () => { begins++; }, () => { acks++; });
  await new Promise<void>(resolve => setImmediate(resolve));
  // A second caller can arrive before either a notification or the first ACK.
  const second = f.codex.changeGoal(f.key, f.control, () => {}, () => { begins++; }, () => { acks++; });
  const rejected = assert.rejects(second, /Goal changed/);
  // Release both potential writes in the unpatched implementation so failure
  // is reported deterministically instead of leaving a hung test promise.
  await new Promise<void>(resolve => setImmediate(resolve));
  release({ goal: { ...goal, status: 'paused' } });
  await rejected;
  await first;
  assert.equal(writes, 1); assert.equal(begins, 1); assert.equal(acks, 1);
  assert.ok(logs.some(log => log.event === 'local_write_conflict'));
  assert.equal(f.runtime.goalChangesInflight.size, 0);
});

test('local Goal write guard does not block reads or other sessions and rejected callers cannot release it', async t => {
  const f = fixture(t), otherKey = 'codex:other';
  f.store.upsertSession({ sessionKey: otherKey, title: 'Other', agentId: 'codex', status: 'idle' });
  let release!: (value: unknown) => void, otherWrites = 0;
  f.runtime.request = async (method: string, params: { threadId: string }, _timeout: unknown, receipt: any) => {
    const value = { ...goal, threadId: params.threadId };
    if (method === 'thread/goal/get') return { goal: value };
    receipt.beforeWrite();
    if (params.threadId === 'other') { otherWrites++; return { goal: { ...value, status: 'paused' } }; }
    return new Promise(resolve => { release = resolve; });
  };
  const first = f.codex.changeGoal(f.key, f.control, () => {}, () => {}, () => {});
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => assert.fail('No dispatch'), () => {}), /Goal changed/);
    assert.equal(f.runtime.goalChangesInflight.has(f.key), true);
  }
  assert.equal((await f.codex.readGoalControl(f.key, () => {})).goal?.status, 'active');
  const other = await f.codex.readGoalControl(otherKey, () => {});
  await f.codex.changeGoal(otherKey, { action: 'pause', expectedRevision: other.revision }, () => {}, () => {}, () => {});
  assert.equal(otherWrites, 1);
  release({ goal: { ...goal, status: 'paused' } }); await first;
  assert.equal(f.runtime.goalChangesInflight.size, 0);
});

for (const failure of ['read', 'fence', 'write', 'ack']) {
  test(`local Goal guard releases after ${failure} failure, without replaying the failed intent`, async t => {
    const f = fixture(t); let fail = true, writes = 0;
    f.runtime.request = async (method: string, _params: unknown, _timeout: unknown, receipt: any) => {
      if (method === 'thread/goal/get') { if (fail && failure === 'read') throw Error('synthetic'); return { goal }; }
      receipt.beforeWrite(); writes++;
      if (fail && failure === 'write') throw Error('synthetic');
      return { goal: { ...goal, status: 'paused' } };
    };
    await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => {
      if (failure === 'fence') throw Error('synthetic');
    }, () => { if (failure === 'ack') throw Error('synthetic'); }), /synthetic/);
    assert.equal(f.runtime.goalChangesInflight.size, 0);
    assert.equal(writes, ['write', 'ack'].includes(failure) ? 1 : 0);
    fail = false;
    // Independent explicit action; this runtime guard does not replace the
    // Connector's durable receipt admission for a previous unknown outcome.
    await f.codex.changeGoal(f.key, f.control, () => {}, () => {}, () => {});
    assert.equal(f.runtime.goalChangesInflight.size, 0);
  });
}

test('shared Goal read rechecks each caller authorization independently', async t => {
  const f = fixture(t);
  let release!: (value: unknown) => void, allowed = true, reads = 0;
  f.runtime.request = async () => { reads++; return new Promise(resolve => { release = resolve; }); };
  const revoked = f.codex.readGoalControl(f.key, () => { if (!allowed) throw new Error('revoked'); });
  const denied = assert.rejects(revoked, /revoked/);
  const authorized = f.codex.readGoalControl(f.key, () => {});
  assert.equal(reads, 1);
  allowed = false; release({ goal });
  await denied;
  assert.equal((await authorized).revision, f.control.expectedRevision);
});

test('Goal change rechecks observation at the actual write boundary', async t => {
  const f = fixture(t); let began = 0;
  const writes = wire(f);
  const request = f.runtime.request.bind(f.runtime);
  f.runtime.request = (method: string, ...args: unknown[]) => {
    if (method === 'thread/goal/set') {
      // A newer native observation after preflight is not permission to apply
      // the old action. Exercise the real transport's beforeWrite callback.
      f.runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status: 'complete' } });
    }
    return request(method, ...args);
  };
  await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => { began++; }, () => assert.fail('No ACK')), /Goal changed/);
  assert.equal(began, 0);
  assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get']);
  assert.equal(f.runtime.goalWriteReceipts.size, 0);
  assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'complete');
});

test('Goal notification in the preflight await gap cannot be adopted as the old action version', async t => {
  const f = fixture(t), writes = wire(f); let checks = 0, began = 0;
  await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {
    if (++checks === 3) queueMicrotask(() => {
      f.runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status: 'complete' } });
    });
  }, () => { began++; }, () => assert.fail('No ACK')), /Goal changed/);
  assert.equal(began, 0);
  assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get']);
  assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'complete');
});

for (const event of ['notification', 'clear', 'connection', 'close', 'deleted', 'unavailable']) {
  test(`shared Goal observation discards stale results after ${event}`, async t => {
    const f = fixture(t);
    let release!: (value: unknown) => void;
    f.runtime.request = async () => new Promise(resolve => { release = resolve; });
    const hydration = f.runtime.hydrateGoal(f.key);
    const panel = assert.rejects(f.codex.readGoalControl(f.key, () => {}), /Goal changed/);
    if (event === 'notification') f.runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status: 'paused' } });
    if (event === 'clear') f.runtime.handleNotification('thread/goal/cleared', { threadId: 'thread' });
    if (event === 'connection') f.runtime.setConnection('new-connection');
    if (event === 'close') await f.codex.close();
    if (event === 'deleted') f.users.codexExecutions.isDeletedTerminal = () => true;
    if (event === 'unavailable') f.runtime.executionUnavailable = true;
    release({ goal });
    await Promise.all([hydration, panel]);
    assert.equal(f.store.getSession(f.key)?.codexGoal?.status, event === 'notification' ? 'paused' : undefined);
    if (event === 'clear') assert.equal(f.store.getSession(f.key)?.codexGoal, null);
    assert.equal(f.runtime.goalObservationInflight.size, 0);
  });
}

test('failed shared read clears its slot without retries; explicit next read can recover', async t => {
  const f = fixture(t); let reads = 0, reject!: (error: Error) => void;
  f.runtime.request = async () => { reads++; return new Promise((_resolve, fail) => { reject = fail; }); };
  const hydration = f.runtime.hydrateGoal(f.key);
  const panel = assert.rejects(f.codex.readGoalControl(f.key, () => {}), /offline/);
  reject(new Error('offline'));
  await Promise.all([hydration, panel]);
  assert.equal(reads, 1); assert.equal(f.runtime.goalObservationInflight.size, 0);
  await f.runtime.hydrateGoal(f.key);
  assert.equal(reads, 1, 'optional observation does not retry itself');
  f.runtime.request = async () => { reads++; return { goal }; };
  assert.equal((await f.codex.readGoalControl(f.key, () => {})).revision, f.control.expectedRevision);
  assert.equal(reads, 2);
});

test('old connection read cannot erase the replacement connection shared read', async t => {
  const f = fixture(t); const releases: Array<(value: unknown) => void> = [];
  f.runtime.request = async () => new Promise(resolve => { releases.push(resolve); });
  const old = assert.rejects(f.codex.readGoalControl(f.key, () => {}), /Goal changed/);
  f.runtime.setConnection('replacement');
  const current = f.codex.readGoalControl(f.key, () => {});
  releases[0]!({ goal }); await old;
  assert.equal(f.runtime.goalObservationInflight.size, 1);
  const duplicate = f.codex.readGoalControl(f.key, () => {});
  assert.equal(releases.length, 2);
  releases[1]!({ goal: { ...goal, status: 'paused' } });
  assert.equal((await current).goal?.status, 'paused');
  assert.deepEqual(await current, await duplicate);
  assert.equal(f.runtime.goalObservationInflight.size, 0);
});

for (const event of ['valid', 'wrong-id', 'wrong-thread', 'wrong-status', 'error', 'connection', 'shutdown', 'disk', 'notification']) {
  test(`real transport: timed-out Goal ${event} reply never replays or overwrites newer state`, async t => {
    const f = fixture(t), writes = wire(f); let began = 0, ack = 0;
    const logs: any[] = [];
    f.runtime.goalDiagnostics = new GoalDiagnostics(line => logs.push(JSON.parse(line)));
    await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => { began++; }, () => {
      if (event === 'disk') throw new Error('disk unavailable');
      ack++;
    }), /timed out/);
    assert.equal(began, 1); assert.equal(ack, 0); assert.equal(f.runtime.pending.size, 0);
    assert.equal(f.runtime.goalWriteReceipts.size, 1);
    if (event === 'connection') f.runtime.setConnection('replacement');
    if (event === 'shutdown') f.runtime.rejectAll(new Error('closed'));
    if (event === 'notification') f.runtime.handleNotification('thread/goal/updated', { threadId: 'thread', goal: { ...goal, status: 'complete' } });
    const reply = JSON.stringify({ id: writes[1]!.id + (event === 'wrong-id' ? 100 : 0),
      ...(event === 'error' ? { error: { message: 'failed' } } : { result: { goal: { ...goal,
        threadId: event === 'wrong-thread' ? 'other' : 'thread', status: event === 'wrong-status' ? 'active' : 'paused' } } }) });
    f.runtime.receive(reply); f.runtime.receive(reply);
    const controlLogs = logs.filter(log => log.action === 'pause');
    assert.ok(controlLogs.some(log => log.event === 'write_timeout' && log.rpcId === writes[1]!.id));
    assert.ok(controlLogs.some(log => log.event === 'outcome_unknown'));
    assert.equal(new Set(controlLogs.map(log => log.operation)).size, 1);
    assert.equal(controlLogs.filter(log => log.event === 'ack_persisted').length, ['valid', 'notification'].includes(event) ? 1 : 0);
    if (event === 'disk') assert.ok(controlLogs.some(log => log.event === 'ack_persist_failed'));
    if (['wrong-thread', 'wrong-status'].includes(event)) assert.ok(controlLogs.some(log => log.event === 'ack_invalid'));
    if (event === 'shutdown') assert.ok(controlLogs.some(log => log.event === 'ack_connection_lost'));
    if (event === 'error') assert.ok(controlLogs.some(log => log.event === 'rpc_error'));
    assert.ok(!JSON.stringify(logs).includes(goal.objective));
    assert.equal(ack, ['valid', 'notification'].includes(event) ? 1 : 0);
    assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get', 'thread/goal/set']);
    assert.equal(f.store.getSession(f.key)?.codexGoal?.status, event === 'connection' ? undefined : event === 'notification' ? 'complete' : 'active');
  });
}

test('real transport: unavailable stdin after GET is proven prewrite', async t => {
  const f = fixture(t), writes = wire(f, () => { f.runtime.child.stdin.writable = false; }); let began = 0;
  await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => { began++; }, () => assert.fail('No ACK')), /not running/);
  assert.equal(began, 0); assert.equal(f.runtime.goalWriteReceipts.size, 0);
  assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get']);
});

test('real transport: failed durable fence prevents dispatch', async t => {
  const f = fixture(t), writes = wire(f);
  await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => { throw new Error('disk'); }, () => assert.fail('No ACK')), /disk/);
  assert.equal(f.runtime.goalWriteReceipts.size, 0);
  assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get']);
});

test('real transport: timely Goal ACK persists exactly once before projection and releases its slot', async t => {
  const f = fixture(t), writes = wire(f); let began = 0, ack = 0;
  const write = f.runtime.child.stdin.write;
  f.runtime.child.stdin.write = (line: string) => {
    write(line);
    const rpc = JSON.parse(line);
    if (rpc.method === 'thread/goal/set') queueMicrotask(() => {
      assert.equal(began, 1);
      f.runtime.receive(JSON.stringify({ id: rpc.id, result: { goal: { ...goal, status: 'paused' } } }));
    });
  };
  await f.codex.changeGoal(f.key, f.control, () => {}, () => { began++; }, () => {
    assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'active', 'durable ACK precedes projection');
    ack++;
  });
  f.runtime.receive(JSON.stringify({ id: writes[1]!.id, result: { goal: { ...goal, status: 'paused' } } }));
  assert.equal(began, 1); assert.equal(ack, 1);
  assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'paused');
  assert.equal(f.runtime.pending.size, 0); assert.equal(f.runtime.goalWriteReceipts.size, 0);
  assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get', 'thread/goal/set']);
});

test('real transport: Goal ACK capacity refuses write 129 before its fence and accepts a freed slot', async t => {
  const f = fixture(t), writes = wire(f); let began = 0, ack = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Exercise the transport-wide limit without inventing 128 competing user
  // intents for one session or bypassing an existing settings receipt fence.
  const pending = Array.from({ length: 128 }, () => assert.rejects(f.runtime.request('thread/goal/set',
    { threadId: 'thread', status: 'paused' }, 10, { beforeWrite: () => { began++; }, acknowledge: () => { ack++; } }), /timed out/));
  assert.equal(began, 128); assert.equal(writes.length, 128);
  t.mock.timers.tick(10); await Promise.all(pending);
  assert.equal(f.runtime.pending.size, 0); assert.equal(f.runtime.goalWriteReceipts.size, 128);
  await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => { began++; }, () => { ack++; }), /capacity unavailable/);
  assert.equal(began, 128); assert.equal(writes.filter(rpc => rpc.method === 'thread/goal/set').length, 128);
  f.runtime.receive(JSON.stringify({ id: writes[0]!.id, result: { goal: { ...goal, status: 'paused' } } }));
  assert.equal(ack, 1); assert.equal(f.runtime.goalWriteReceipts.size, 127);
  const change = f.codex.changeGoal(f.key, f.control, () => {}, () => { began++; }, () => { ack++; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(began, 129); assert.equal(f.runtime.goalWriteReceipts.size, 128);
  f.runtime.receive(JSON.stringify({ id: writes.at(-1)!.id, result: { goal: { ...goal, status: 'paused' } } }));
  await change;
  assert.equal(ack, 2); assert.equal(f.runtime.goalWriteReceipts.size, 127);
  assert.equal(writes.filter(rpc => rpc.method === 'thread/goal/set').length, 129);
  f.runtime.rejectAll(new Error('synthetic shutdown'));
  assert.equal(f.runtime.goalWriteReceipts.size, 0);
});

test('real transport: Goal late-ACK TTL releases its slot and cannot confirm an expired reply', async t => {
  const f = fixture(t), writes = wire(f); let began = 0, ack = 0;
  const logs: any[] = [];
  f.runtime.goalDiagnostics = new GoalDiagnostics(line => logs.push(JSON.parse(line)));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timedOut = assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => { began++; }, () => { ack++; }), /timed out/);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(10); await timedOut;
  assert.equal(began, 1); assert.equal(f.runtime.goalWriteReceipts.size, 1);
  t.mock.timers.tick(10 * 60_000 - 1);
  assert.equal(f.runtime.goalWriteReceipts.size, 1, 'retain the original RPC through the bounded ACK window');
  t.mock.timers.tick(1);
  assert.equal(f.runtime.goalWriteReceipts.size, 0);
  assert.ok(logs.some(log => log.event === 'ack_expired' && log.rpcId === writes[1]!.id));
  f.runtime.receive(JSON.stringify({ id: writes[1]!.id, result: { goal: { ...goal, status: 'paused' } } }));
  assert.equal(ack, 0); assert.equal(f.runtime.pending.size, 0);
  assert.equal(f.store.getSession(f.key)?.codexGoal?.status, 'active');
  assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get', 'thread/goal/set']);
});

test('real transport: synchronous stdin write failure after the fence retains durable unknown without retry', async t => {
  const f = fixture(t), writes = wire(f), receipts = f.users.commands;
  const scope = JSON.stringify(['settings', JSON.stringify(['actor', f.key])]), key = 'throw-after-fence';
  const payload = { goal: f.control };
  assert.equal(receipts.claim(scope, key, payload, false, undefined, undefined, undefined, true).fresh, true);
  const write = f.runtime.child.stdin.write; let began = 0, ack = 0;
  f.runtime.child.stdin.write = (line: string) => {
    write(line);
    if (JSON.parse(line).method === 'thread/goal/set') {
      assert.equal(began, 1, 'dispatch fence must already be durable');
      throw new Error('synthetic write failed after dispatch boundary');
    }
  };
  await assert.rejects(f.codex.changeGoal(f.key, f.control, () => {}, () => {
    receipts.beginSettingsWrite(scope, key); began++;
  }, () => { ack++; }), /write failed after dispatch boundary/);
  assert.equal(began, 1); assert.equal(ack, 0);
  assert.equal(f.runtime.pending.size, 0); assert.equal(f.runtime.goalWriteReceipts.size, 0);
  receipts.recoverSettingsPrewrites();
  assert.equal(receipts.get(scope, key)?.state, 'outcome_unknown', 'startup recovery must not reject an ambiguous write');
  assert.equal(receipts.sessionSettingsPending(f.key), true);
  assert.equal(receipts.claim(scope, key, payload, false, undefined, undefined, undefined, true).fresh, false,
    'the original intent cannot be dispatched again');
  assert.deepEqual(writes.map(rpc => rpc.method), ['thread/goal/get', 'thread/goal/set']);
});

test('readGoalControl uses 10s control timeout budget and clearing a blocked Goal wakes reconciliation', async t => {
  const f = fixture(t);
  let observedTimeout = 0;
  f.runtime.options.requestTimeoutMs = 30_000;
  f.runtime.request = async (method: string, params: any, timeoutMs?: number) => {
    if (method === 'thread/goal/get') {
      observedTimeout = timeoutMs ?? 0;
      return { goal: { ...goal, status: 'blocked' } };
    }
    if (method === 'thread/goal/clear') {
      assert.deepEqual(params, { threadId: 'thread' });
      return { cleared: true };
    }
    throw new Error(`unexpected ${method}`);
  };
  f.runtime.threadRefreshResult.set(f.key, { at: Date.now(), available: true, recoveryAt: Date.now() });
  let woke = 0;
  const origWake = f.runtime.turnWorker.wake.bind(f.runtime.turnWorker);
  f.runtime.turnWorker.wake = () => { woke++; origWake(); };

  const snap = await f.codex.readGoalControl(f.key, () => {});
  assert.equal(observedTimeout, 10_000);
  assert.equal(snap.goal?.status, 'blocked');

  await f.codex.changeGoal(f.key, { action: 'clear', expectedRevision: snap.revision }, () => {}, () => {}, () => {});
  assert.equal(f.store.getSession(f.key)?.codexGoal, null);
  assert.equal(f.runtime.threadRefreshResult.get(f.key)?.recoveryAt, undefined);
  assert.ok(woke >= 1);
});

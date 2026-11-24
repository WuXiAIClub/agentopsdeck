import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CodexAppServer } from '../codex/app-server.js';
import { GoalControlConflict } from '../codex/goal-control.js';
import { HermesRuntime, type HermesTransport } from '../hermes/runtime.js';
import { HermesJournal } from '../hermes/journal.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';
import { SdkOwnedRuntime } from '../connector/sdk-owned-runtime.js';
import { SynchronousEffectAuthorityError } from './synchronous-effect-authority.js';

// Prototype fixtures have no constructor, database, child or native transport.
// Their effect sentinels stop at dispatch, not after a real provider operation.
function boundary(kind: 'codex-create' | 'codex-remove' | 'hermes-create' | 'hermes-remove' | 'sdk-remove') {
  const effects: string[] = [];
  const native = async (method: string) => { effects.push(method); throw new Error('synthetic dispatch'); };
  let run: (authorize: () => void) => Promise<unknown>;
  let startup: () => void = () => {};
  if (kind.startsWith('codex')) {
    const runtime = Object.create(CodexAppServer.prototype) as any;
    runtime.options = { enabled: true, executions: {} };
    runtime.ensureStarted = async () => { startup(); };
    runtime.request = native;
    run = authorize => kind === 'codex-create'
      ? runtime.createSession({}, () => effects.push('ACK'), authorize)
      : runtime.remove('codex:synthetic', authorize, () => effects.push('ACK'));
  } else if (kind.startsWith('hermes')) {
    const runtime = Object.create(HermesRuntime.prototype) as any;
    runtime.options = { config: { workspace: '/synthetic' }, journal: {}, turns: {}, store: {} };
    runtime.native = { ready: true, request: native };
    // Denial must precede even inspecting session state or claiming deletion.
    runtime.deletionBlocked = () => { effects.push('deletion-state'); return false; };
    run = authorize => kind === 'hermes-create'
      ? runtime.createSession('Synthetic', () => effects.push('ACK'), authorize)
      : runtime.remove('hermes:synthetic', authorize, () => effects.push('ACK'));
  } else {
    const runtime = Object.create(SdkOwnedRuntime.prototype) as any;
    Object.defineProperty(runtime, 'ready', { value: true });
    runtime.driver = { inspect: () => ({ admissionPaused: false }) };
    runtime.options = { store: { sdkCommandAdmissionOpen: true }, journal: {} };
    runtime.deletionJobs = new Set();
    run = authorize => runtime.remove('claude:synthetic', authorize, () => effects.push('ACK'));
  }
  return { effects, run, setStartup(fn: () => void) { startup = fn; } };
}

for (const kind of ['codex-create', 'codex-remove', 'hermes-create', 'hermes-remove', 'sdk-remove'] as const) {
  test(`${kind}: missing required authority is not a trusted caller`, async () => {
    for (const value of [undefined, null, false]) {
      const f = boundary(kind);
      await assert.rejects(f.run(value as unknown as () => void), SynchronousEffectAuthorityError);
      assert.deepEqual(f.effects, []);
    }
  });
  test(`${kind}: async authority cannot start its body or an effect`, async () => {
    const f = boundary(kind); let calls = 0;
    await assert.rejects(f.run(async () => { calls++; }), SynchronousEffectAuthorityError);
    assert.equal(calls, 0); assert.deepEqual(f.effects, []);
  });
  test(`${kind}: native Promise, nonvoid and hostile thenable are not grants`, async () => {
    let reads = 0;
    for (const result of [Promise.resolve(), Promise.resolve(false), false, true, null,
      { get then() { reads++; throw new Error('private thenable'); } }]) {
      const f = boundary(kind);
      await assert.rejects(f.run((() => result) as () => void), SynchronousEffectAuthorityError);
      assert.deepEqual(f.effects, []);
    }
    assert.equal(reads, 0);
  });
  test(`${kind}: original synchronous rejection retains identity`, async () => {
    const f = boundary(kind), denied = new Error('synthetic revoke');
    await assert.rejects(f.run(() => { throw denied; }), error => error === denied);
    assert.deepEqual(f.effects, []);
  });
  test(`${kind}: returned native late rejection is observed without dispatch`, async () => {
    const f = boundary(kind); let reject!: (error: Error) => void;
    const late = new Promise<void>((_, no) => { reject = no; });
    await assert.rejects(f.run(() => late), SynchronousEffectAuthorityError);
    reject(new Error('synthetic late rejection'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, []);
  });
}

for (const kind of ['codex-create', 'codex-remove'] as const) {
  test(`${kind}: original authority is rechecked after startup, not cached`, async () => {
    const f = boundary(kind); let phase = 'before', checks = 0;
    f.setStartup(() => { phase = 'after'; });
    await assert.rejects(f.run(() => { checks++; return phase === 'before' ? undefined : Promise.resolve(); }), SynchronousEffectAuthorityError);
    assert.equal(checks, 2); assert.deepEqual(f.effects, []);
  });
  test(`${kind}: synchronous authority still reaches the original dispatch once`, async () => {
    const f = boundary(kind); let checks = 0;
    await assert.rejects(f.run(() => { checks++; }), /synthetic dispatch/);
    assert.equal(checks, 2);
    assert.deepEqual(f.effects, [kind === 'codex-create' ? 'thread/start' : 'thread/archive']);
  });
}

function goalFixture() {
  const runtime = Object.create(CodexAppServer.prototype) as any;
  runtime.options = { enabled: true, store: { getSession: () => ({ sessionKey: 'codex:synthetic' }) } };
  runtime.connectionId = 'synthetic-connection';
  return runtime;
}
test('Goal initial and returned recheck reject deferred authority with the original conflict envelope', () => {
  const runtime = goalFixture(); let calls = 0;
  assert.throws(() => runtime.goalControlGuard('codex:synthetic', undefined), GoalControlConflict);
  assert.throws(() => runtime.goalControlGuard('codex:synthetic', async () => { calls++; }), GoalControlConflict);
  assert.equal(calls, 0);
  let deferred = false;
  const guard = runtime.goalControlGuard('codex:synthetic', () => { calls++; return deferred ? Promise.resolve() : undefined; });
  deferred = true;
  assert.throws(guard.check, GoalControlConflict); assert.equal(calls, 2);
});
test('Goal recheck retains original synchronous revocation and connection fence', () => {
  const runtime = goalFixture(), denied = new Error('synthetic revoke'); let revoked = false;
  const guard = runtime.goalControlGuard('codex:synthetic', () => { if (revoked) throw denied; });
  revoked = true; assert.throws(guard.check, error => error === denied);
  revoked = false; runtime.connectionId = 'replacement'; assert.throws(guard.check, GoalControlConflict);
});

function hermes(t: TestContext) {
  const db = new DatabaseSync(':memory:'), turns = new TurnQueue(db), journal = new HermesJournal(db), store = new DeckStore();
  const calls: string[] = [];
  const native: HermesTransport = { ready: true, epoch: 'synthetic-epoch',
    async start() {}, async close() { this.ready = false; },
    async request(method) {
      calls.push(method);
      if (method === 'session.create') return { session_id: 'synthetic-live', stored_session_id: 'synthetic-stored' };
      if (method === 'session.activate') return { session_id: 'synthetic-live', session_key: 'synthetic-stored', running: false, status: 'idle' };
      if (method === 'session.close') return { closed: true };
      if (method === 'session.delete') return { deleted: 'synthetic-stored' };
      throw new Error('unexpected synthetic method');
    } };
  const runtime = new HermesRuntime({ config: { enabled: true, executable: 'never-launch', sourceDirectory: '/synthetic',
    homeDirectory: '/synthetic', workspace: '/synthetic', startupTimeoutMs: 1000 }, journal, turns, store, authorize: () => true }, () => native);
  t.after(async () => { await runtime.close(); db.close(); });
  return { runtime, journal, turns, store, calls };
}
test('Hermes native creation identity survives final deferred authority; no ACK or automatic replay', async t => {
  const f = hermes(t); let checks = 0, acknowledgements = 0;
  await assert.rejects(f.runtime.createSession('Synthetic', () => { acknowledgements++; }, () => {
    checks++; return checks === 1 ? undefined : Promise.resolve();
  }), SynchronousEffectAuthorityError);
  assert.equal(checks, 2); assert.equal(acknowledgements, 0);
  const sessions = f.journal.sessions(); assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.stored, 'synthetic-stored');
  assert.ok(f.store.getSession(sessions[0]!.key));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ['session.create']);
});
for (const rejectedCheck of [2, 3, 4, 5]) test(`Hermes deletion recheck ${rejectedCheck} cannot turn a Promise into native permission`, async t => {
  const f = hermes(t), { key } = await f.runtime.createSession('Synthetic', () => {}, () => {});
  f.calls.length = 0; let checks = 0, acknowledgements = 0;
  await assert.rejects(f.runtime.remove(key, () => {
    checks++; return checks === rejectedCheck ? Promise.resolve() : undefined;
  }, () => { acknowledgements++; }), rejectedCheck >= 4 ? /not be fully confirmed/ : SynchronousEffectAuthorityError);
  assert.equal(checks, rejectedCheck); assert.equal(acknowledgements, 0);
  assert.deepEqual(f.calls, rejectedCheck === 2 ? [] : rejectedCheck <= 4 ? ['session.activate'] : ['session.activate', 'session.close']);
  assert.ok(f.journal.session(key)); assert.ok(f.store.getSession(key));
  assert.equal(f.journal.deletion(key), rejectedCheck >= 4 ? 'pending' : undefined);
  if (rejectedCheck >= 4) {
    const before = [...f.calls];
    await assert.rejects(f.runtime.remove(key, () => {}, () => assert.fail('unknown deletion cannot ACK')));
    assert.deepEqual(f.calls, before); // Durable pending fence; never replay delete.
  }
});
test('Hermes original synchronous deletion preserves native ACK and projection cleanup', async t => {
  const f = hermes(t), { key } = await f.runtime.createSession('Synthetic', () => {}, () => {});
  f.calls.length = 0; let checks = 0, acknowledgements = 0;
  await f.runtime.remove(key, () => { checks++; }, () => { acknowledgements++; });
  assert.equal(checks, 5); assert.equal(acknowledgements, 1);
  assert.deepEqual(f.calls, ['session.activate', 'session.close', 'session.delete']);
  assert.equal(f.journal.deletion(key), 'accepted'); assert.equal(f.journal.session(key), undefined);
  assert.equal(f.store.getSession(key), undefined);
});

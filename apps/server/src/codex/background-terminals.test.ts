import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backgroundTerminals, BackgroundTerminalDrainError, terminateBackgroundTerminals } from './background-terminals.js';
import { CodexAppServer } from './app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';

const terminal = { processId: 'process', itemId: 'tool' };

for (const boundary of [1, 2, 3, 4]) test(`async terminal guard denial ${boundary} is awaited before subsequent IO`, async () => {
  let checks = 0; const methods: string[] = [];
  await assert.rejects(terminateBackgroundTerminals(async method => {
    methods.push(method); return method.endsWith('/list') ? { data: [terminal] } : { terminated: true };
  }, 'thread', new Set(['tool']), async () => {
    await Promise.resolve(); if (++checks === boundary) throw Error('revoked');
  }), /revoked/);
  assert.equal(methods.length, boundary === 1 ? 0 : boundary <= 3 ? 1 : 2);
});

for (const boundary of ['list', 'terminate', 'final-list'] as const) {
  test(`late ${boundary} reply never certifies background terminal drain`, async t => {
    let now = 1_000, lists = 0;
    t.mock.method(Date, 'now', () => now);
    const methods: string[] = [];
    await assert.rejects(terminateBackgroundTerminals(async method => {
      methods.push(method);
      if (method.endsWith('/list')) {
        lists++;
        if (boundary === 'list' || (boundary === 'final-list' && lists === 2)) {
          now += 30_001;
          return { data: [] };
        }
        return { data: [terminal] };
      }
      if (boundary === 'terminate') now += 30_001;
      return { terminated: true };
    }, 'thread', new Set(['tool']), () => {}), /timed out/);
    assert.equal(methods.length, boundary === 'list' ? 1 : boundary === 'terminate' ? 2 : 3);
  });
}

test('background terminal enumeration preserves identities across bounded pages', async () => {
  const calls: unknown[] = [];
  const rows = await backgroundTerminals(async (method, params) => {
    calls.push({ method, params });
    return calls.length === 1 ? { data: [terminal], nextCursor: 'next' } : { data: [], nextCursor: null };
  }, 'thread', () => {});
  assert.deepEqual(rows, [terminal]);
  assert.deepEqual(calls, [
    { method: 'thread/backgroundTerminals/list', params: { threadId: 'thread', limit: 100 } },
    { method: 'thread/backgroundTerminals/list', params: { threadId: 'thread', limit: 100, cursor: 'next' } },
  ]);
});

for (const invalid of [null, {}, { data: null }, { data: [null] }, { data: [{ processId: 'process' }] },
  { data: [{ ...terminal, itemId: ' tool' }] }, { data: [{ ...terminal, processId: 'process\n' }] },
  { data: [terminal, terminal] }, { data: [], nextCursor: '' }, { data: [], nextCursor: 1 },
  { data: Array.from({ length: 101 }, (_, index) => ({ processId: String(index), itemId: 'tool' })) }]) {
  test(`background terminal enumeration rejects malformed page ${JSON.stringify(invalid).slice(0, 110)}`, async () => {
    await assert.rejects(backgroundTerminals(async () => invalid, 'thread', () => {}), /Invalid Codex/);
  });
}

for (const failure of ['cursor', 'duplicate', 'pages', 'deadline', 'changed'] as const) {
  test(`background terminal query stops on ${failure}`, async () => {
    let reads = 0, checks = 0;
    await assert.rejects(backgroundTerminals(async () => {
      reads++;
      return { data: failure === 'duplicate' ? [terminal] : [], nextCursor: failure === 'cursor' ? 'same' : String(reads) };
    }, 'thread', () => {
      if (++checks === 2 && failure === 'changed') throw new Error('changed connection');
    }, failure === 'deadline' ? 0 : Date.now() + 30_000));
    assert.equal(reads, { cursor: 2, duplicate: 2, pages: 32, deadline: 0, changed: 1 }[failure]);
  });
}

for (const terminated of [true, false]) {
  test(`termination ${terminated} ACK requires a fresh empty terminal list`, async () => {
    const calls: unknown[] = [];
    let lists = 0;
    await terminateBackgroundTerminals(async (method, params) => {
      calls.push({ method, params });
      return method.endsWith('/list') ? { data: ++lists === 1 ? [terminal] : [] } : { terminated };
    }, 'thread', new Set(['tool']), () => {});
    assert.deepEqual(calls, [
      { method: 'thread/backgroundTerminals/list', params: { threadId: 'thread', limit: 100 } },
      { method: 'thread/backgroundTerminals/terminate', params: { threadId: 'thread', processId: 'process' } },
      { method: 'thread/backgroundTerminals/list', params: { threadId: 'thread', limit: 100 } },
    ]);
  });
}

for (const failure of ['foreign', 'lost-ack', 'malformed-ack', 'still-running', 'revoked'] as const) {
  test(`termination does not claim success or kill foreign work on ${failure}`, async () => {
    let mutations = 0, checks = 0;
    await assert.rejects(terminateBackgroundTerminals(async method => {
      if (method.endsWith('/list')) return { data: [terminal] };
      mutations++;
      if (failure === 'lost-ack') throw new Error('lost ACK');
      return failure === 'malformed-ack' ? {} : { terminated: true };
    }, 'thread', new Set([failure === 'foreign' ? 'other-tool' : 'tool']), () => {
      if (++checks === 3 && failure === 'revoked') throw new Error('revoked');
    }));
    assert.equal(mutations, failure === 'foreign' || failure === 'revoked' ? 0 : 1);
  });
}

for (const source of ['set', 'resolver'] as const) {
  test(`termination rechecks ${source} ownership after each asynchronous mutation`, async () => {
    const allowed = new Set(['tool', 'second-tool']);
    const mutations: string[] = [];
    await assert.rejects(terminateBackgroundTerminals(async (method, params: any) => {
      if (method.endsWith('/list')) return { data: [terminal, { processId: 'second', itemId: 'second-tool' }] };
      mutations.push(params.processId);
      allowed.delete('second-tool');
      return { terminated: true };
    }, 'thread', source === 'set' ? allowed : () => new Set(allowed), () => {}), /belongs to another run/);
    assert.deepEqual(mutations, ['process'], 'withdrawn ownership must prevent the second termination');
  });
}

for (const evidence of ['history-item', 'unattributed'] as const)
for (const outcome of ['completed', 'failed', 'interrupted'] as const) {
  test(`natural terminal exit resumes original queued IDs exactly once after ${outcome}/${evidence}`, async context => {
    const setup = fixture(context);
    setup.turn.status = outcome;
    if (evidence === 'unattributed') setup.turn.items = [];
    let active = true;
    const starts: any[] = [];
    setup.runtime.loadedThreadIds.add('synthetic');
    setup.runtime.request = async (method: string, params: any) => {
      if (method === 'thread/read') return setup.history;
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/backgroundTerminals/list') return { data: active ? [terminal] : [] };
      assert.equal(method, 'turn/start', 'recovery must not terminate, resume or mutate goals');
      starts.push(params);
      return { turn: { id: 'successor' } };
    };
    const first = await setup.codex.send(setup.key, 'queued first');
    const second = await setup.codex.send(setup.key, 'queued second');
    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'queued');
    const ids = [first.idempotencyKey, second.idempotencyKey];
    setup.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: setup.turn });
    await setup.runtime.completingTurns.get(setup.key);
    await setup.runtime.drainQueuedTurn(setup.key);
    assert.equal(starts.length, 0);
    assert.deepEqual(setup.database.turns.list('codex', setup.key).map(row => row.id), ids);
    active = false;
    // Exercise the existing queue worker, not a manual resend or forced idle.
    await setup.runtime.turnWorker.options.reconcile(setup.key);
    await Promise.all(Array.from({ length: 4 }, () => setup.runtime.drainQueuedTurn(setup.key)));
    assert.equal(starts.length, 1);
    assert.equal(starts[0].clientUserMessageId, ids[0]);
    assert.match(starts[0].input[0].text, /queued first[\s\S]*queued second/);
    assert.equal(setup.database.turns.list('codex', setup.key).length, 0);
    const messages = setup.store.getMessages(setup.key).filter(message => ids.includes(message.id));
    assert.deepEqual(messages.map(message => [message.id, message.text, message.status, message.turnId]), [
      [ids[0], 'queued first', 'sent', 'successor'], [ids[1], 'queued second', 'sent', 'successor'],
    ]);
  });
}

function fixture(context: test.TestContext) {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), key = 'codex:synthetic';
  let authorized = true;
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent', defaultModel: 'test',
    approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn: () => authorized });
  const runtime = codex as any;
  runtime.setConnection('connection');
  runtime.ensureStarted = async () => {};
  database.codexExecutions.begin(key, 'original-command', 'connection');
  database.codexExecutions.acknowledge(key, 'original-command', 'connection', 'original-run', () => {});
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'running' });
  const turn = { id: 'original-run', status: 'interrupted', items: [
    { type: 'commandExecution', id: 'tool', status: 'completed', command: 'synthetic', exitCode: 0 },
  ] };
  const history = { thread: { id: 'synthetic', status: { type: 'idle' }, canAcceptDirectInput: true, turns: [turn] } };
  context.after(async () => { await codex.close(); database.close(); });
  return { codex, runtime, store, database, key, turn, history, revoke: () => { authorized = false; } };
}

for (const evidence of ['history', 'persisted', 'other-run', 'other-connection', 'none', 'mixed'] as const) {
  test(`drain diagnostics report only scoped ownership counts (${evidence})`, async context => {
    const setup = fixture(context);
    setup.turn.status = 'completed';
    if (evidence !== 'history' && evidence !== 'mixed') setup.turn.items = [];
    if (['persisted', 'other-run', 'other-connection'].includes(evidence)) {
      setup.database.codexExecutions.observeCommandTool(setup.key, 'connection', 'original-run', 'tool');
    }
    if (evidence === 'other-run') setup.turn.id = 'different-run';
    if (evidence === 'other-connection') setup.runtime.connectionId = 'different-connection';
    const methods: string[] = [];
    const rows = evidence === 'mixed' ? [terminal, { processId: 'other-process', itemId: 'other-tool' }] : [terminal];
    setup.runtime.request = async (method: string, params: unknown) => {
      methods.push(method);
      assert.equal(method, 'thread/backgroundTerminals/list');
      assert.deepEqual(params, { threadId: 'synthetic', limit: 100 });
      return { data: rows };
    };
    await assert.rejects(setup.runtime.requireBackgroundTerminalsDrained('synthetic', setup.turn, () => {}), (error: unknown) => {
      assert.ok(error instanceof BackgroundTerminalDrainError);
      const owned = ['history', 'persisted', 'mixed'].includes(evidence) ? 1 : 0;
      assert.deepEqual(error.ownership, { total: rows.length, owned, unattributed: rows.length - owned });
      assert.deepEqual(error.lifecycle, { declaredTemporary: 0, declaredService: 0,
        undeclaredOwned: owned, unattributed: rows.length - owned });
      assert.equal(error.message, 'Codex background terminals are still running', 'waiting UI reason remains compatible');
      assert.ok(Object.isFrozen(error.ownership));
      assert.ok(Object.isFrozen(error.lifecycle));
      assert.doesNotMatch(JSON.stringify(error), /synthetic|original-run|other-process|other-tool|"tool"|"process"/);
      return true;
    });
    assert.deepEqual(methods, ['thread/backgroundTerminals/list'], 'classification adds no RPC or cleanup');
  });
}

test('a no-command terminal snapshot still needs exactly one empty native list', async context => {
  const setup = fixture(context);
  setup.turn.status = 'completed'; setup.turn.items = [];
  let reads = 0;
  setup.runtime.request = async (method: string) => {
    assert.equal(method, 'thread/backgroundTerminals/list'); reads++;
    return { data: [] };
  };
  await setup.runtime.requireBackgroundTerminalsDrained('synthetic', setup.turn, () => {});
  assert.equal(reads, 1);
});

for (const failure of ['unavailable', 'malformed', 'changed'] as const) {
  test(`missing command evidence cannot bypass failed terminal proof (${failure})`, async context => {
    const setup = fixture(context);
    setup.turn.status = 'completed'; setup.turn.items = [];
    let changed = false, reads = 0;
    setup.runtime.request = async (method: string) => {
      assert.equal(method, 'thread/backgroundTerminals/list'); reads++;
      if (failure === 'unavailable') throw new Error('synthetic unavailable');
      if (failure === 'changed') changed = true;
      return failure === 'malformed' ? {} : { data: [] };
    };
    await assert.rejects(setup.runtime.requireBackgroundTerminalsDrained('synthetic', setup.turn, () => {
      if (changed) throw new Error('synthetic changed');
    }), /synthetic unavailable|Invalid Codex background terminal page|synthetic changed/);
    assert.equal(reads, 1);
    assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
  });
}

for (const evidence of ['history-item', 'unattributed'] as const)
for (const failure of ['still-running', 'list-failed', 'revoked', 'revoke-during-read', 'lost-start-ack'] as const) {
  test(`terminal recovery preserves queued identity and protection on ${failure}/${evidence}`, async context => {
    const setup = fixture(context);
    setup.turn.status = 'completed';
    if (evidence === 'unattributed') setup.turn.items = [];
    let recovering = false, starts = 0;
    setup.runtime.loadedThreadIds.add('synthetic');
    setup.runtime.request = async (method: string) => {
      if (method === 'thread/read') return setup.history;
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/backgroundTerminals/list') {
        if (recovering && failure === 'list-failed') throw new Error('synthetic list unavailable');
        if (recovering && failure === 'revoke-during-read') setup.revoke();
        return { data: !recovering || failure === 'still-running' ? [terminal] : [] };
      }
      assert.equal(method, 'turn/start', 'only an authorized successor start may mutate native state');
      starts++;
      if (failure === 'lost-start-ack') throw new Error('synthetic lost start ACK');
      return { turn: { id: 'successor' } };
    };
    const accepted = await setup.codex.send(setup.key, 'preserve original request');
    setup.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: setup.turn });
    await setup.runtime.completingTurns.get(setup.key);
    recovering = true;
    if (failure === 'revoked') setup.revoke();
    // Repeated worker passes may fail to prove readiness; that is not authority
    // to replay a message whose native start ACK was lost.
    for (let pass = 0; pass < 3; pass++) {
      try { await setup.runtime.turnWorker.options.reconcile(setup.key); }
      catch (error) { assert.match(String(error), /background terminals|synthetic list unavailable/); }
      await setup.runtime.drainQueuedTurn(setup.key);
    }
    assert.equal(starts, failure === 'lost-start-ack' ? 1 : 0);
    const rows = setup.database.turns.list<{ text: string }>('codex', setup.key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, accepted.idempotencyKey);
    assert.equal(rows[0]!.payload.text, 'preserve original request');
    assert.equal(rows[0]!.state, failure === 'lost-start-ack' ? 'outcome_unknown'
      : failure === 'revoked' || failure === 'revoke-during-read' ? 'blocked' : 'queued');
    assert.equal(setup.store.getMessages(setup.key).filter(message => message.id === accepted.idempotencyKey).length, 1);
    if (failure !== 'revoked' && failure !== 'revoke-during-read') assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
  });
}

for (const lostAck of [false, true]) {
  test(`terminal recovery survives SQLite reopen without ${lostAck ? 'replaying an uncertain start' : 'changing queued message IDs'}`, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-terminal-queue-'));
    const file = join(directory, 'connector.sqlite'), key = 'codex:restart-terminal';
    let database: ConnectorUserStore | undefined, codex: CodexAppServer | undefined;
    context.after(async () => { await codex?.close(); database?.close(); rmSync(directory, { recursive: true, force: true }); });
    let active = true, starts = 0;
    const turn = { id: 'original-run', status: 'completed', items: [
      { type: 'commandExecution', id: 'tool', status: 'completed', command: 'synthetic', exitCode: 0 },
    ] };
    const history = { thread: { id: 'restart-terminal', status: { type: 'idle' }, canAcceptDirectInput: true, turns: [turn] } };
    const open = (connectionId: string) => {
      database = new ConnectorUserStore(file);
      const store = new DeckStore();
      codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent', defaultModel: 'test',
        approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn: () => true });
      const runtime = codex as any;
      runtime.setConnection(connectionId);
      runtime.ensureStarted = async () => {};
      runtime.loadedThreadIds.add('restart-terminal');
      runtime.request = async (method: string) => {
        if (method === 'thread/read') return history;
        if (method === 'thread/goal/get') return { goal: null };
        if (method === 'thread/backgroundTerminals/list') return { data: active ? [terminal] : [] };
        assert.equal(method, 'turn/start');
        starts++;
        if (lostAck) throw new Error('synthetic lost start ACK');
        return { turn: { id: 'successor' } };
      };
      return { instance: codex, runtime, store, database };
    };
    const first = open('original-connection');
    first.database.codexExecutions.begin(key, 'original-command', 'original-connection');
    first.database.codexExecutions.acknowledge(key, 'original-command', 'original-connection', 'original-run', () => {});
    first.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic restart', status: 'running' });
    const ids = [(await first.instance.send(key, 'first persisted')).idempotencyKey,
      (await first.instance.send(key, 'second persisted')).idempotencyKey];
    first.runtime.handleNotification('turn/completed', { threadId: 'restart-terminal', turn });
    await first.runtime.completingTurns.get(key);
    if (lostAck) {
      active = false;
      await first.runtime.turnWorker.options.reconcile(key);
      assert.equal(starts, 1);
    }
    await first.instance.close(); codex = undefined;
    first.database.close(); database = undefined;
    const restored = open('restored-connection');
    assert.deepEqual(restored.database.turns.list('codex', key).map(row => row.id), ids);
    if (!lostAck) {
      await restored.runtime.turnWorker.options.reconcile(key);
      assert.equal(starts, 0, 'restart cannot clear an active background terminal');
    }
    active = false;
    for (let pass = 0; pass < 3; pass++) await restored.runtime.turnWorker.options.reconcile(key);
    assert.equal(starts, 1);
    if (lostAck) {
      assert.deepEqual(restored.database.turns.list('codex', key).map(row => [row.id, row.state]), ids.map(id => [id, 'outcome_unknown']));
      assert.equal(restored.database.codexExecutions.canStart(key), false);
    } else {
      assert.equal(restored.database.turns.list('codex', key).length, 0);
      assert.deepEqual(restored.store.getMessages(key).filter(message => ids.includes(message.id)).map(message =>
        [message.id, message.status, message.turnId]), ids.map(id => [id, 'sent', 'successor']));
    }
  });
}

test('run-bound interrupt terminates only its native tool, not an OS PID or entire thread', async context => {
  const setup = fixture(context), calls: string[] = [];
  let active = true;
  setup.runtime.request = async (method: string, params: any) => {
    calls.push(method);
    if (method === 'turn/interrupt') {
      setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
      return {};
    }
    if (method === 'thread/read') return setup.history;
    if (method === 'thread/backgroundTerminals/list') return { data: active ? [terminal] : [] };
    assert.equal(method, 'thread/backgroundTerminals/terminate');
    assert.deepEqual(params, { threadId: 'synthetic', processId: 'process' });
    active = false;
    return { terminated: true };
  };
  await setup.codex.interrupt(setup.key, 'original-run', 'actor');
  assert.deepEqual(calls, ['turn/interrupt', 'thread/read', 'thread/backgroundTerminals/list', 'thread/backgroundTerminals/terminate', 'thread/backgroundTerminals/list']);
  assert.equal(setup.database.codexExecutions.canStart(setup.key), false, 'tool termination alone cannot release history synchronization');
});

for (const boundary of ['list', 'terminate'] as const) for (const change of ['revoked', 'connection', 'new-run', 'goal-updated'] as const) {
  test(`interrupt stops remaining cleanup when ${change} occurs during ${boundary}`, async context => {
    const setup = fixture(context), terminated: string[] = [];
    setup.turn.items.push({ ...setup.turn.items[0]!, id: 'second-tool' });
    const changeEvidence = () => {
      if (change === 'revoked') setup.revoke();
      if (change === 'connection') setup.runtime.setConnection('replacement');
      if (change === 'new-run') setup.runtime.handleNotification('turn/started', {
        threadId: 'synthetic', turn: { id: 'foreign-run', status: 'inProgress' },
      });
      if (change === 'goal-updated') setup.runtime.handleNotification('thread/goal/updated', { threadId: 'synthetic' });
    };
    setup.runtime.request = async (method: string, params: any) => {
      if (method === 'turn/interrupt') {
        setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
        return {};
      }
      if (method === 'thread/read') return setup.history;
      if (method === 'thread/backgroundTerminals/list') {
        if (boundary === 'list') changeEvidence();
        return { data: [terminal, { processId: 'second', itemId: 'second-tool' }] };
      }
      assert.equal(method, 'thread/backgroundTerminals/terminate');
      terminated.push(params.processId);
      if (boundary === 'terminate') changeEvidence();
      return { terminated: true };
    };
    await assert.rejects(setup.codex.interrupt(setup.key, 'original-run', 'actor'));
    assert.deepEqual(terminated, boundary === 'terminate' ? ['process'] : []);
    assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
  });
}

for (const change of ['revoked', 'connection', 'foreign-run', 'foreign-tool'] as const) {
  test(`interrupt cleanup refuses ${change} after native ACK`, async context => {
    const setup = fixture(context), calls: string[] = [];
    setup.runtime.request = async (method: string) => {
      calls.push(method);
      if (method === 'turn/interrupt') return {};
      if (method === 'thread/read') {
        if (change === 'revoked') setup.revoke();
        if (change === 'connection') setup.runtime.setConnection('replacement');
        if (change === 'foreign-run') setup.turn.id = 'foreign';
        return setup.history;
      }
      assert.equal(method, 'thread/backgroundTerminals/list');
      return { data: [{ ...terminal, itemId: 'foreign-tool' }] };
    };
    await assert.rejects(setup.codex.interrupt(setup.key, 'original-run', 'actor'));
    assert.equal(calls.some(method => method.endsWith('/terminate')), false);
    assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
  });
}

test('interrupted native history can omit a live command without losing its durable run binding', async context => {
  const setup = fixture(context);
  setup.turn.items = [];
  setup.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'original-run',
    item: { type: 'commandExecution', id: 'tool', command: 'synthetic', status: 'inProgress' } });
  assert.deepEqual(setup.database.codexExecutions.get(setup.key)?.pendingCommandTools, ['tool']);
  let active = true, terminated = 0;
  setup.runtime.request = async (method: string) => {
    if (method === 'turn/interrupt') {
      setup.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: setup.turn });
      return {};
    }
    if (method === 'thread/read') return setup.history;
    if (method === 'thread/backgroundTerminals/list') return { data: active ? [terminal] : [] };
    assert.equal(method, 'thread/backgroundTerminals/terminate');
    active = false; terminated++;
    return { terminated: true };
  };
  await setup.codex.interrupt(setup.key, 'original-run', 'actor');
  await setup.runtime.completingTurns.get(setup.key);
  assert.equal(terminated, 1);
  assert.equal(setup.database.codexExecutions.get(setup.key)?.sync, 'current');
  const tool = setup.store.getMessages(setup.key).find(message => message.toolCallId === 'tool');
  assert.equal(tool?.status, 'failed');
  assert.match(tool?.failureReason ?? '', /completion output is unavailable/);
  assert.equal(setup.store.getActivity(setup.key).some(activity => activity.status === 'running'), false);
});

test('interrupted missing command projection is stable without volatile tool input after restart', async context => {
  const setup = fixture(context);
  setup.turn.items = [];
  setup.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'original-run',
    item: { type: 'commandExecution', id: 'tool', command: 'synthetic input', status: 'inProgress' } });
  const warm: any[] = [];
  setup.runtime.projectInterruptedTools(setup.key, setup.turn, warm);
  setup.store.removeMessage(setup.key, setup.store.getMessages(setup.key).find(message => message.toolCallId === 'tool')!.id);
  const cold: any[] = [];
  setup.runtime.projectInterruptedTools(setup.key, setup.turn, cold);
  assert.deepEqual(cold, warm);
  assert.equal(cold.length, 1);
  assert.equal(cold[0].status, 'failed');
  assert.equal(cold[0].toolPhase, 'call');
  assert.equal(cold[0].createdAt, setup.database.codexExecutions.get(setup.key)?.startedAt);
  const result = { ...cold[0], id: 'native-result', toolPhase: 'result', status: 'sent', text: 'Actual native result' };
  const complete = [result];
  setup.runtime.projectInterruptedTools(setup.key, setup.turn, complete);
  assert.deepEqual(complete, [result]);
});

test('missing native command history still blocks refresh while its durable tool remains alive', async context => {
  const setup = fixture(context);
  setup.turn.items = [];
  setup.database.codexExecutions.observeCommandTool(setup.key, 'connection', 'original-run', 'tool');
  setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
  setup.runtime.request = async (method: string) => method === 'thread/read' ? setup.history : { data: [terminal] };
  await assert.rejects(setup.codex.refreshSession(setup.key), /background terminals/);
  assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
});

test('sync-error terminal exposes read-only history while its native terminal remains fenced', async context => {
  const setup = fixture(context);
  setup.history.thread.status = { type: 'notLoaded' };
  (setup.history.thread as any).path = '/missing/sync-error-rollout.jsonl';
  (setup.turn.items as any[]).unshift({ id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'Persisted request' }] });
  (setup.turn.items as any[]).push({ id: 'reply', type: 'agentMessage', text: 'Persisted reply' });
  setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
  setup.database.codexExecutions.settleHistory(setup.database.codexExecutions.get(setup.key)!, 'error');
  setup.runtime.request = async (method: string) => {
    assert.notEqual(method, 'thread/resume', 'read-only degraded history must not resume the fenced native thread');
    assert.notEqual(method, 'thread/backgroundTerminals/list', 'an unloaded fenced thread must not be queried as loaded');
    return setup.history;
  };
  await setup.codex.refreshSession(setup.key);
  assert.equal(setup.codex.isSessionHistoryReady(setup.key), true);
  const projected = JSON.stringify(setup.store.getMessages(setup.key));
  assert.match(projected, /Persisted request/);
  assert.match(projected, /Persisted reply/);
  assert.equal(setup.database.codexExecutions.get(setup.key)?.sync, 'error');
  assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
});

for (const path of ['refresh', 'final'] as const) {
  test(`interrupted ${path} cannot certify idle when omitted tools have no durable identity`, async context => {
    const setup = fixture(context);
    setup.turn.items = [];
    const methods: string[] = [];
    setup.runtime.request = async (method: string) => {
      methods.push(method);
      if (method === 'thread/read') return setup.history;
      assert.equal(method, 'thread/backgroundTerminals/list');
      return { data: [terminal] };
    };
    assert.equal(setup.database.codexExecutions.get(setup.key)?.pendingCommandTools, undefined);
    if (path === 'refresh') {
      setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
      await assert.rejects(setup.codex.refreshSession(setup.key), /background terminals/);
    } else {
      setup.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: setup.turn });
      await setup.runtime.completingTurns.get(setup.key);
    }
    assert.ok(methods.includes('thread/backgroundTerminals/list'));
    assert.equal(setup.codex.isSessionHistoryReady(setup.key), path === 'final');
    assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
    assert.equal(setup.database.codexExecutions.get(setup.key)?.sync, path === 'final' ? 'current' : 'syncing');
    if (path === 'final') assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.reason, 'background-work');
  });
}

test('foreign and unidentified tool notifications never authorize native process termination', async context => {
  const setup = fixture(context);
  for (const turnId of [undefined, 'foreign-run']) setup.runtime.handleNotification('item/started', {
    threadId: 'synthetic', turnId, item: { type: 'commandExecution', id: 'foreign-tool', status: 'inProgress' },
  });
  assert.equal(setup.database.codexExecutions.get(setup.key)?.pendingCommandTools, undefined);
});

test('late native command notification during terminal enumeration retains exact-run stop authority', async context => {
  const setup = fixture(context);
  setup.turn.items = [];
  let active = true, terminated = 0;
  setup.runtime.request = async (method: string) => {
    if (method === 'turn/interrupt') {
      setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
      return {};
    }
    if (method === 'thread/read') return setup.history;
    if (method === 'thread/backgroundTerminals/list') {
      if (active) setup.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'original-run',
        item: { type: 'commandExecution', id: 'tool', command: 'synthetic', status: 'inProgress' } });
      return { data: active ? [terminal] : [] };
    }
    assert.equal(method, 'thread/backgroundTerminals/terminate');
    active = false; terminated++;
    return { terminated: true };
  };
  await setup.codex.interrupt(setup.key, 'original-run', 'actor');
  assert.equal(terminated, 1);
  assert.deepEqual(setup.database.codexExecutions.get(setup.key)?.pendingCommandTools, ['tool']);
  assert.equal(setup.database.codexExecutions.get(setup.key)?.phase, 'interrupted');
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
test(`late same-run command invalidates a ${phase} projection and stays blocked while alive`, async context => {
  const setup = fixture(context);
  setup.turn.status = phase;
  setup.turn.items = [];
  setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', phase);
  setup.database.codexExecutions.settleHistory({ sessionKey: setup.key, commandId: 'original-command', runId: 'original-run' }, 'current');
  setup.runtime.request = async (method: string) => method === 'thread/read' ? setup.history : { data: [terminal] };
  setup.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'original-run',
    item: { type: 'commandExecution', id: 'tool', command: 'synthetic', status: 'inProgress' } });
  assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
  assert.equal(setup.store.getSession(setup.key)?.runtime?.sync, 'syncing');
  await setup.runtime.completingTurns.get(setup.key);
  assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
  assert.equal(setup.database.codexExecutions.get(setup.key)?.sync, phase === 'interrupted' ? 'current' : 'error');
  if (phase === 'interrupted') assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.state, 'blocked');
});
}

for (const boundary of ['interrupt', 'refresh', 'final'] as const) {
  test(`${boundary}: aborted executor is not drain proof even when native thread is idle and terminals are empty`, async context => {
    const setup = fixture(context);
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-unconfirmed-dispatch-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'rollout.jsonl');
    writeFileSync(path, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'original-run' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'wrapper', input: 'synthetic' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'wrapper', output: 'aborted by user after 0.1s' } },
    ].map(value => JSON.stringify(value)).join('\n'));
    Object.assign(setup.history.thread, { path });
    setup.turn.items = [];
    setup.runtime.request = async (method: string) => {
      if (method === 'turn/interrupt') {
        setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
        return {};
      }
      if (method === 'thread/read') return setup.history;
      assert.equal(method, 'thread/backgroundTerminals/list');
      return { data: [] };
    };
    if (boundary === 'interrupt') await assert.rejects(setup.codex.interrupt(setup.key, 'original-run', 'actor'), /cleanup is unconfirmed/);
    else {
      setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
      if (boundary === 'refresh') {
        await setup.codex.refreshSession(setup.key);
        assert.equal(setup.codex.isSessionHistoryReady(setup.key), true, 'read-only history remains available');
        assert.ok(setup.store.getMessages(setup.key).length > 0, 'native transcript was projected');
        assert.equal(setup.database.codexExecutions.get(setup.key)?.sync, 'syncing', 'history read does not clear execution fence');
      }
      else {
        setup.runtime.reconcileCompletedTurn(setup.key, 'synthetic', Date.now(), 'original-run', 'interrupted');
        await setup.runtime.completingTurns.get(setup.key);
        assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.reason, 'cleanup-unconfirmed');
        assert.equal(setup.codex.isSessionHistoryReady(setup.key), true);
        // A second pass must re-prove dispatch cleanup, not fast-certify from
        // the readable checkpoint and an empty native terminal list alone.
        setup.runtime.reconcileCompletedTurn(setup.key, 'synthetic', Date.now(), 'original-run', 'interrupted');
        await setup.runtime.completingTurns.get(setup.key);
        assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.reason, 'cleanup-unconfirmed');
      }
    }
    assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
    assert.equal(setup.database.codexExecutions.maintenancePending(), 1);
  });
}

for (const evidence of ['history-item', 'unattributed'] as const)
for (const boundary of ['final', 'refresh'] as const) for (const outcome of ['completed', 'failed', 'interrupted'] as const) {
  test(`${boundary}/${outcome}/${evidence} keeps history readable without certifying execution while a terminal tool still runs`, async context => {
    const setup = fixture(context);
    setup.turn.status = outcome;
    if (evidence === 'unattributed') setup.turn.items = [];
    let active = true;
    const methods: string[] = [];
    setup.runtime.request = async (method: string) => {
      methods.push(method);
      if (method === 'thread/read') return setup.history;
      if (method === 'thread/goal/get') return { goal: null };
      assert.equal(method, 'thread/backgroundTerminals/list');
      return { data: active ? [terminal] : [] };
    };
    if (boundary === 'final') {
      setup.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: setup.turn });
      await setup.runtime.completingTurns.get(setup.key);
      assert.equal(setup.database.codexExecutions.get(setup.key)?.sync, 'current');
      assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.reason, 'background-work');
      assert.equal(setup.store.getSession(setup.key)?.runtime?.phase, outcome);
    } else await assert.rejects(setup.codex.refreshSession(setup.key), /background terminals/);
    assert.equal(setup.database.codexExecutions.canStart(setup.key), false);
    assert.equal(setup.codex.isSessionHistoryReady(setup.key), boundary === 'final');
    active = false;
    await setup.codex.refreshSession(setup.key);
    setup.runtime.reconcileCompletedTurn(setup.key, 'synthetic', Date.now(), 'original-run', outcome);
    await setup.runtime.completingTurns.get(setup.key);
    assert.equal(setup.database.codexExecutions.get(setup.key)?.sync, 'current');
    assert.ok(methods.every(method => ['thread/read', 'thread/goal/get', 'thread/backgroundTerminals/list'].includes(method)), 'natural exit never terminates work or replays a message');
    assert.equal(setup.database.codexExecutions.canStart(setup.key), true);
  });
}

for (const modelProvider of [undefined, 'replacement-provider']) for (const failure of [undefined, 'foreign', 'active', 'connection', 'revision', 'lost-ack', 'changed-read'] as const) {
  test(`persisted terminal reload for process inspection (${modelProvider ?? 'native default'}) ${failure ?? 'preserves original run without starting a turn'}`, async context => {
    const setup = fixture(context);
    setup.runtime.options.modelProvider = modelProvider;
    setup.database.codexExecutions.observe(setup.key, 'connection', 'original-run', 'interrupted');
    setup.runtime.setConnection('replacement');
    let reads = 0;
    const methods: string[] = [];
    setup.runtime.request = async (method: string, params: unknown) => {
      methods.push(method);
      if (method === 'thread/read') return { thread: { ...setup.history.thread,
        status: { type: ++reads === 1 ? 'notLoaded' : failure === 'changed-read' ? 'active' : 'idle' } } };
      if (method === 'thread/resume') {
        assert.deepEqual(params, { threadId: 'synthetic', excludeTurns: true, ...(modelProvider ? { modelProvider } : {}) });
        if (failure === 'lost-ack') throw Error('lost ACK');
        if (failure === 'connection') setup.runtime.setConnection('foreign');
        if (failure === 'revision') setup.database.codexExecutions.settleHistory(setup.database.codexExecutions.get(setup.key)!, 'error');
        return { thread: { ...setup.history.thread, status: { type: failure === 'active' ? 'active' : 'idle' },
          turns: failure ? [{ ...setup.turn, id: failure === 'foreign' ? 'foreign' : setup.turn.id }] : [] } };
      }
      assert.equal(method, 'thread/backgroundTerminals/list');
      return { data: [] };
    };
    if (failure) {
      await assert.rejects(setup.codex.refreshSession(setup.key));
      assert.equal(setup.codex.isSessionHistoryReady(setup.key), false);
      assert.equal(methods.includes('thread/backgroundTerminals/list'), false);
    } else {
      await setup.codex.refreshSession(setup.key);
      assert.deepEqual(methods, ['thread/read', 'thread/resume', 'thread/read', 'thread/backgroundTerminals/list']);
      assert.equal(setup.database.codexExecutions.get(setup.key)?.runId, 'original-run');
    }
  });
}

test('read-only display refresh on an unloaded unmanaged thread with commandExecution does not call loaded-only terminal listing', async context => {
  const setup = fixture(context);
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-unloaded-display-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const rolloutPath = join(directory, 'rollout.jsonl');
  writeFileSync(rolloutPath, JSON.stringify({ timestamp: '2026-10-23T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'original-run' } }) + '\n');
  const unmanagedKey = 'codex:unmanaged-cold';
  setup.store.upsertSession({ sessionKey: unmanagedKey, agentId: 'codex', title: 'Unmanaged Cold', status: 'idle' });
  const methods: string[] = [];
  setup.runtime.request = async (method: string) => {
    methods.push(method);
    if (method === 'thread/read') return {
      thread: { ...setup.history.thread, id: 'unmanaged-cold', path: rolloutPath, status: { type: 'notLoaded' } }
    };
    if (method === 'thread/goal/get') return { goal: null };
    throw new Error(`unexpected RPC method during readOnly refresh: ${method}`);
  };
  await setup.runtime.refreshSession(unmanagedKey, { readOnly: true });
  assert.equal(methods.includes('thread/backgroundTerminals/list'), false);
  assert.equal(methods.includes('thread/resume'), false);
  assert.equal(setup.codex.isSessionHistoryReady(unmanagedKey), true);
  assert.ok(setup.runtime.displayHistory.get(unmanagedKey));
});

test('requestSessionRecovery clears recoveryAt cooldown and loaded background-work polls every 5s without re-reading unchanged rollout', async context => {
  const setup = fixture(context);
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-bg-fast-poll-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const rolloutPath = join(directory, 'rollout.jsonl');
  writeFileSync(rolloutPath, JSON.stringify({ timestamp: '2026-10-23T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'original-run' } }) + '\n');
  setup.turn.status = 'completed';
  (setup.history.thread as any).path = rolloutPath;
  setup.runtime.loadedThreadIds.add('synthetic');
  let wakes = 0;
  setup.runtime.turnWorker.wake = () => { wakes++; return true; };
  let now = 10_000;
  context.mock.method(Date, 'now', () => now);
  let active = true;
  let listCalls = 0;
  setup.runtime.request = async (method: string) => {
    if (method === 'thread/read') return setup.history;
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/backgroundTerminals/list') {
      listCalls++;
      return { data: active ? [terminal] : [] };
    }
    throw new Error(`unexpected RPC method: ${method}`);
  };
  let rolloutReads = 0;
  const originalRead = setup.runtime.rolloutReader.read.bind(setup.runtime.rolloutReader);
  setup.runtime.rolloutReader.read = async (...args: any[]) => {
    rolloutReads++;
    return originalRead(...args);
  };

  setup.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: setup.turn });
  await setup.runtime.completingTurns.get(setup.key);
  assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.reason, 'background-work');
  const initialRolloutReads = rolloutReads;
  const initialListCalls = listCalls;

  // Within 5s cooldown, worker skips recheck unless explicitly requested.
  now += 2_000;
  await setup.runtime.turnWorker.options.reconcile(setup.key);
  assert.equal(listCalls, initialListCalls);

  // Explicit recovery clears recoveryAt so the immediate worker pass rechecks.
  assert.equal(await setup.codex.requestSessionRecovery(setup.key, 'original-run'), true);
  assert.equal(wakes, 1);
  await setup.runtime.turnWorker.options.reconcile(setup.key);
  assert.ok(listCalls > initialListCalls, 'recovery button triggers immediate recheck');
  assert.equal(rolloutReads, initialRolloutReads, 'unchanged rollout is not re-read while still blocked on background-work');

  // After 5s (not 30s), loaded background-work rechecks automatically and clears once terminals exit.
  active = false;
  now += 5_500;
  await setup.runtime.turnWorker.options.reconcile(setup.key);
  assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.state, 'verified');
});

test('stopOwnedBackgroundTerminals terminates owned post-turn terminals and refuses running, successor or unattributed work', async context => {
  const setup = fixture(context);
  setup.turn.status = 'completed';
  setup.runtime.loadedThreadIds.add('synthetic');
  let activeTerminals = [terminal];
  const terminated: string[] = [];
  setup.runtime.request = async (method: string, params: any) => {
    if (method === 'thread/read') return setup.history;
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/backgroundTerminals/list') return { data: activeTerminals };
    if (method === 'thread/backgroundTerminals/terminate') {
      terminated.push(params.processId);
      activeTerminals = [];
      return { terminated: true };
    }
    throw new Error(`unexpected RPC method: ${method}`);
  };

  // Refuses while turn is still running (before terminal completion).
  assert.equal(await setup.codex.stopOwnedBackgroundTerminals(setup.key, 'original-run'), false);
  assert.equal(terminated.length, 0);

  setup.runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: setup.turn });
  await setup.runtime.completingTurns.get(setup.key);
  assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.reason, 'background-work');

  // Refuses mismatched runId.
  assert.equal(await setup.codex.stopOwnedBackgroundTerminals(setup.key, 'wrong-run'), false);
  assert.equal(terminated.length, 0);

  // Refuses unattributed/foreign background terminals.
  activeTerminals = [{ processId: 'foreign-proc', itemId: 'foreign-tool' }];
  assert.equal(await setup.codex.stopOwnedBackgroundTerminals(setup.key, 'original-run'), false);
  assert.equal(terminated.length, 0);

  // Refuses if a successor turn is already present on native thread.
  activeTerminals = [terminal];
  setup.history.thread.turns.push({ id: 'successor-run', status: 'inProgress', items: [] } as any);
  assert.equal(await setup.codex.stopOwnedBackgroundTerminals(setup.key, 'original-run'), false);
  setup.history.thread.turns.pop();

  // Terminates owned background terminal and wakes worker to clear protection.
  assert.equal(await setup.codex.stopOwnedBackgroundTerminals(setup.key, 'original-run'), true);
  assert.deepEqual(terminated, ['process']);
  await setup.runtime.turnWorker.options.reconcile(setup.key);
  assert.equal(setup.database.codexExecutions.get(setup.key)?.nativeHistory?.state, 'verified');
});

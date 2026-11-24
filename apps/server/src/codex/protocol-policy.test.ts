import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { CODEX_AUTONOMY_INSTRUCTIONS } from './autonomy-policy.js';

function fixture(approvalPolicy: 'never' | 'on-request' | 'untrusted' = 'never') {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy, store, turnQueue: database.turns, executions: database.codexExecutions,
    authorizeTurn: () => true });
  const runtime = codex as any, writes: any[] = [];
  runtime.connectionId = 'synthetic-connection';
  runtime.ensureStarted = async () => {};
  runtime.write = (message: unknown) => { writes.push(message); };
  return { database, codex, runtime, writes, close: async () => { await codex.close(); database.close(); } };
}

for (const policy of ['never', 'on-request', 'untrusted'] as const) {
  test(`native session creation and turn dispatch explicitly retain configured ${policy} policy`, async () => {
    const context = fixture(policy), calls: { method: string; params: any }[] = [];
    context.runtime.request = async (method: string, params: unknown) => {
      if (method === 'thread/name/set') return {};
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'synthetic' } };
      assert.equal(method, 'turn/start');
      return { turn: { id: 'native-run' } };
    };
    try {
      await context.codex.createSession({ title: 'Synthetic' }, () => {}, () => {});
      await context.runtime.startTurn('codex:synthetic', 'synthetic', [{ type: 'text', text: 'synthetic' }], 'original-command');
      assert.deepEqual(calls.map(call => [call.method, call.params.approvalPolicy]), [['thread/start', policy], ['turn/start', policy]]);
      assert.equal(calls[0]!.params.sandbox, 'danger-full-access');
      assert.ok(calls[0]!.params.developerInstructions.includes(CODEX_AUTONOMY_INSTRUCTIONS));
      assert.equal(calls[1]!.params.developerInstructions, undefined, 'do not repeat session policy in every turn');
      assert.deepEqual(calls[1]!.params.sandboxPolicy, { type: 'dangerFullAccess' });
      assert.equal(context.database.codexExecutions.get('codex:synthetic')?.runId, 'native-run');
    } finally { await context.close(); }
  });
}

test('loading an existing native session uses the same bounded autonomy guidance only once', async () => {
  const context = fixture(), calls: { method: string; params: any }[] = [];
  context.runtime.request = async (method: string, params: any) => { calls.push({ method, params }); return {}; };
  try {
    await context.runtime.ensureThreadLoaded('synthetic');
    await context.runtime.ensureThreadLoaded('synthetic');
    assert.equal(calls.length, 1); assert.equal(calls[0]!.method, 'thread/resume');
    assert.ok(calls[0]!.params.developerInstructions.includes(CODEX_AUTONOMY_INSTRUCTIONS));
    assert.equal(calls[0]!.params.approvalPolicy, 'never');
  } finally { await context.close(); }
});

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'item/tool/requestUserInput', 'unknown/request']) {
  for (const numeric of [true, false]) {
    test(`native ${method} with ${numeric ? 'colliding numeric' : 'string'} ID cannot impersonate a client response`, async () => {
      const context = fixture();
      try {
        const pending = context.runtime.request('thread/read', { threadId: 'synthetic' });
        const id = context.writes[0].id;
        const serverId = numeric ? id : 'native-request';
        context.runtime.receive(JSON.stringify({ id: serverId, method, params: { threadId: 'synthetic', command: 'must-not-run' } }));
        assert.equal(context.runtime.pending.has(id), true);
        if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
          assert.deepEqual(context.writes[1], { id: serverId, result: { decision: 'cancel' } });
        } else {
          assert.equal(context.writes[1].id, serverId);
          assert.equal(context.writes[1].error.code, -32601);
          assert.equal(context.writes[1].result, undefined);
        }
        context.runtime.receive(JSON.stringify({ id, result: { thread: { id: 'synthetic', turns: [] } } }));
        assert.deepEqual(await pending, { thread: { id: 'synthetic', turns: [] } });
        assert.equal(context.runtime.pending.size, 0);
      } finally { await context.close(); }
    });
  }
}

test('malformed protocol records and closed-server requests have no side effects', async () => {
  const context = fixture();
  try {
    for (const line of ['null', '[]', '1', '"text"', '{']) assert.doesNotThrow(() => context.runtime.receive(line));
    assert.deepEqual(context.writes, []);
    await context.codex.close();
    context.runtime.receive(JSON.stringify({ id: 1, method: 'item/commandExecution/requestApproval' }));
    assert.deepEqual(context.writes, []);
  } finally { await context.close(); }
});

test('failed approval response transport rejects pending reads without granting permission', async () => {
  const context = fixture();
  try {
    const pending = context.runtime.request('thread/read', { threadId: 'synthetic' });
    context.runtime.write = () => { throw new Error('synthetic broken pipe'); };
    assert.doesNotThrow(() => context.runtime.receive(JSON.stringify({ id: 10, method: 'item/commandExecution/requestApproval' })));
    await assert.rejects(pending, /server request response could not be written/);
    assert.equal(context.runtime.pending.size, 0);
    assert.equal(context.runtime.connectionId, undefined);
    assert.equal(context.writes.length, 1);
  } finally { await context.close(); }
});

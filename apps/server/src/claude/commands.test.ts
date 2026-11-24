import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { TurnAuthorizationError } from '../commands/turn-queue.js';
import { RunControlConflict } from '../commands/run-control.js';
import { SdkUnsupportedTextCommand } from '../connector/sdk-text-command.js';
import { registerCreationReceipts, registerMessageReceipts } from '../commands/http.js';
import { ClaudeOwnedRuntime } from './owned-runtime.js';
import { CLAUDE_CLI_VERSION } from './dispatch-adapter.js';
import { projectClaudeMessage } from './message-projection.js';

async function fixture(initialize = true, mode: 'ack' | 'lost-ack' | 'lost-stop' = 'ack') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-claude-commands-')));
  const homeDirectory = join(root, 'home'); mkdirSync(homeDirectory, { mode: 0o700 });
  const dbFile = join(root, 'connector.sqlite');
  const store = new ConnectorUserStore(dbFile, () => true, { runtimeOwner: true });
  let authorized = true;
  const calls: { id: string; text: string; finish: () => void; fail: () => void; stops: number }[] = [];
  const owner = new ClaudeOwnedRuntime({ store, config: { homeDirectory, sdkDirectory: join(root, 'unused-sdk'),
    workspace: join(root, 'workspace'), apiKeyFile: join(root, 'absent-key'), model: 'fixture',
    baseUrl: 'http://127.0.0.1:1', startupTimeoutMs: 1000 }, authorize: () => authorized,
    changed: () => { throw new Error('Projection failure must not undo a durable acceptance'); },
  }, ({ execution, text }, project) => {
    let release!: () => void, done!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finished = new Promise<void>(resolve => { done = resolve; });
    let quiet = false, closed = false, failed = false, interrupted = false, assistant = false;
    const call = { id: execution.id, text, finish: release, fail: () => { failed = true; release(); }, stops: 0 };
    calls.push(call);
    const session_id = execution.nativeSessionId, assistantId = randomUUID();
    return { finished,
      async *[Symbol.asyncIterator]() {
        try {
          yield { type: 'system', subtype: 'init', session_id, claude_code_version: CLAUDE_CLI_VERSION };
          const input = { type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null,
            message: { role: 'user', content: text } };
          if (mode !== 'lost-ack') { project(projectClaudeMessage(input, session_id)); yield input; }
          await gate;
          if (failed) throw new Error('Synthetic lost native connection');
          if (closed) return;
          if (!interrupted) {
            const output = { type: 'assistant', uuid: assistantId, session_id, parent_tool_use_id: null,
              user_message_uuid: execution.id, message: { role: 'assistant', content: 'Fixture reply' } };
            project(projectClaudeMessage(output, session_id)); assistant = true; yield output;
          }
          yield { type: 'result', uuid: randomUUID(), session_id, user_message_uuid: execution.id,
            subtype: interrupted ? 'error_during_execution' : 'success', is_error: interrupted };
        } finally { quiet = true; done(); }
      },
      interrupt: async () => {
        call.stops++;
        if (mode === 'lost-stop') throw new Error('Synthetic lost stop ACK');
        interrupted = true; release();
      },
      historyIdentities: async () => [{ type: 'user', uuid: execution.id, session_id, parent_tool_use_id: null },
        ...(assistant ? [{ type: 'assistant', uuid: assistantId, session_id, parent_tool_use_id: null }] : [])],
      inspectQuiescence: async () => quiet,
      close: () => { closed = true; release(); },
    };
  }, () => ({ ready: Promise.resolve(true), finished: Promise.resolve(), inspectQuiescence: () => true, close: () => {} }));
  if (initialize) assert.equal(await owner.initialize(), true);
  const createScope = JSON.stringify(['owner', 'claude-code']);
  const authorize = () => { if (!authorized) throw new TurnAuthorizationError(); };
  const create = async (commandKey = randomUUID()) => {
    await store.commands.claimAsync(createScope, commandKey, { title: 'Fixture' });
    return owner.commands.createSession('Fixture', { authorize,
      accept: result => store.commands.creationCommit(createScope, commandKey, { status: 201, body: result }) });
  };
  // Physical admission is genuinely asynchronous. Hold only the fixture's
  // wake notification while inspecting the durable pre-dispatch boundary;
  // never replace the disk admission port or bypass the owning transaction.
  const prepareSend = async (key: string, text: string, commandKey = randomUUID()) => {
    const scope = JSON.stringify(['owner', key]);
    await store.commands.claimAsync(scope, commandKey, { message: text });
    return async () => {
      const wake = owner.driver.wake;
      owner.driver.wake = async () => {};
      try {
        return await owner.commands.sendAsync(key, text, { actorId: 'owner',
          accept: result => store.commands.queueCommit(scope, commandKey, { status: 200, body: result }) });
      } finally { owner.driver.wake = wake; }
    };
  };
  const send = async (key: string, text: string, commandKey = randomUUID()) => {
    const result = await (await prepareSend(key, text, commandKey))();
    void owner.driver.wake(key);
    return result;
  };
  return { owner, store, dbFile, calls, create, send, prepareSend, createScope, authorize,
    revoke: () => { authorized = false; }, grant: () => { authorized = true; },
    close: async () => { await owner.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Claude create allocates once with an atomic receipt and no native invocation', async () => {
  const f = await fixture();
  try {
    const command = randomUUID(), result = (await f.create(command));
    assert.match(result.key, /^claude-code:/); assert.equal(f.calls.length, 0);
    assert.equal(f.store.claudeJournal.session(result.key)?.nativeState, 'allocated');
    assert.deepEqual(f.store.commands.get(f.createScope, command)?.result?.body, result);
    await assert.rejects(f.create(command), /not open for admission/);
    assert.deepEqual(f.store.claudeJournal.sessionKeys(), [result.key]);
  } finally { await f.close(); }
});

test('Claude creation rolls back identity and compatibility fence with a failing receipt', async () => {
  const f = await fixture();
  try {
    let owningDb!: DatabaseSync;
    assert.throws(() => f.owner.commands.createSession('Fixture', { authorize: f.authorize, accept: () => db => {
      owningDb = db;
      assert.equal(db.isTransaction, true);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'connector_sdk_writer_compatibility'").get());
      throw new Error('Synthetic receipt write failed');
    } }), /receipt write failed/);
    assert.deepEqual(f.store.claudeJournal.sessionKeys(), []);
    assert.equal(owningDb.isTransaction, false);
    assert.equal(owningDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'connector_sdk_writer_compatibility'").get(), undefined);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('Claude creation refuses cross-database receipts, revoked authority and invalid titles', async () => {
  const f = await fixture(), foreign = new ConnectorUserStore(':memory:');
  try {
    foreign.commands.claim('scope', 'key', {});
    assert.throws(() => f.owner.commands.createSession('Fixture', { authorize: f.authorize,
      accept: result => foreign.commands.creationCommit('scope', 'key', { status: 201, body: result }) }), /owning transaction/);
    assert.equal(foreign.commands.get('scope', 'key')?.state, 'outcome_unknown');
    for (const title of ['', ' ', 'x'.repeat(121), 'bad\ntitle']) {
      assert.throws(() => f.owner.commands.createSession(title, { authorize: f.authorize, accept: () => () => {} }), /title/);
    }
    assert.throws(() => f.owner.commands.createSession('Fixture', { authorize: f.authorize,
      accept: () => { f.revoke(); return () => {}; } }), TurnAuthorizationError);
    assert.deepEqual(f.store.claudeJournal.sessionKeys(), []);
  } finally { foreign.close(); await f.close(); }
});

test('Claude send commits first, distinguishes preparing/waiting and batches successors without polling', async () => {
  const f = await fixture();
  try {
    const { key } = (await f.create()), command = randomUUID();
    const sendFirst = await f.prepareSend(key, 'first', command);
    const first = await sendFirst();
    assert.equal(first.queueDisposition, 'preparing'); assert.equal(f.calls.length, 0);
    assert.equal(f.store.commands.get(JSON.stringify(['owner', key]), command)?.state, 'accepted');
    await assert.rejects(f.send(key, 'first', command), /not open for admission/);
    await f.owner.driver.wake(key); assert.equal(f.calls.length, 1);
    const second = (await f.send(key, 'second')), third = (await f.send(key, 'third'));
    assert.equal(second.queueDisposition, 'waiting'); assert.equal(third.queueDisposition, 'waiting');
    f.calls[0]!.finish(); await setImmediate();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.store.claudeJournal.current(key)?.members, [second.idempotencyKey, third.idempotencyKey]);
    assert.match(f.calls[1]!.text, /^second\n\n\[Queued message boundary .+\]\n\nthird$/);
    f.calls[1]!.finish(); await setImmediate();
    assert.equal(f.store.claudeJournal.current(key)?.phase, 'completed');
    assert.equal(f.store.turns.maintenanceCount(), 0);
  } finally { await f.close(); }
});

test('Claude send rollback prevents invocation on failed receipt or revoked/aborted admission', async () => {
  const f = await fixture();
  try {
    const { key } = (await f.create());
    await assert.rejects(f.owner.commands.sendAsync(key, 'text', { actorId: 'owner', accept: () => () => { throw new Error('receipt failed'); } }), /receipt failed/);
    const signal = AbortSignal.abort();
    await assert.rejects(f.owner.commands.sendAsync(key, 'text', { actorId: 'owner', signal, accept: () => () => {} }));
    await assert.rejects(f.owner.commands.sendAsync(key, 'text', { actorId: 'owner', accept: () => { f.revoke(); return () => {}; } }), TurnAuthorizationError);
    assert.equal(f.store.turns.maintenanceCount(), 0);
    await f.owner.driver.wake(key); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('Claude send rejects wrong runtime/session, delegated actors, invalid text and honors text limit', async () => {
  const f = await fixture();
  try {
    const { key } = (await f.create()), accept = () => () => {};
    for (const other of ['codex:test', 'ghcp:test', 'claude-code:absent']) {
      assert.throws(() => f.owner.commands.send(other, 'text', { actorId: 'owner', accept }), /not found/);
    }
    for (const actor of [{ actorId: 'actor_delegated' }, { actorId: '' },
      { actorId: 'owner', executionGrant: { id: 'lease', actorId: 'owner', issuerTokenId: 'issuer' } }]) {
      assert.throws(() => f.owner.commands.send(key, 'text', { ...actor, accept }), TurnAuthorizationError);
    }
    for (const text of ['', ' ', 'x'.repeat(MAX_MESSAGE_CHARS + 1)]) {
      assert.throws(() => f.owner.commands.send(key, text, { actorId: 'owner', accept }), /characters/);
    }
    (await f.send(key, 'x'.repeat(MAX_MESSAGE_CHARS)));
    await f.owner.driver.wake(key); assert.equal(f.calls[0]?.text.length, MAX_MESSAGE_CHARS);
  } finally { await f.close(); }
});

test('Claude checks authority again when accepted input reaches native dispatch', async () => {
  const f = await fixture();
  try {
    const { key } = (await f.create());
    const sendFirst = await f.prepareSend(key, 'not yet started');
    const first = await sendFirst(); f.revoke();
    await f.owner.driver.wake(key);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.turns.head('claude-code', key)?.state, 'blocked');
    f.grant();
    assert.equal(f.owner.commands.cancelQueued(key, first.idempotencyKey,
      f.store.turns.version('claude-code', key, first.idempotencyKey)!, { actorId: 'owner' }), true);
    assert.equal(f.store.turns.maintenanceCount(), 0);
  } finally { await f.close(); }
});

test('SDK command boundary refuses compact before admission or a queue edit commit', async () => {
  const f = await fixture();
  try {
    const { key } = (await f.create());
    let accepted = false, committed = false;
    for (const text of ['/compact', ' /compact focus ', '/compact\nkeep context']) {
      assert.throws(() => f.owner.commands.send(key, text, { actorId: 'owner', accept: () => {
        accepted = true; return () => {};
      } }), SdkUnsupportedTextCommand);
    }
    assert.equal(accepted, false);
    assert.equal(f.store.turns.maintenanceCount(), 0);
    assert.equal(f.calls.length, 0);
    (await f.send(key, 'Explain /compact')); await f.owner.driver.wake(key);
    const { idempotencyKey: id } = (await f.send(key, 'second'));
    const version = f.store.turns.version('claude-code', key, id)!;
    for (const text of ['/compact', '/compact focus', '\n/compact\tkeep context']) {
      assert.throws(() => f.owner.commands.editQueued(key, id, text, version,
        { actorId: 'owner' }, () => { committed = true; }), SdkUnsupportedTextCommand);
      assert.equal(f.store.turns.version('claude-code', key, id), version);
    }
    assert.equal(committed, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.owner.commands.cancelQueued(key, id, version, { actorId: 'owner' }), true);
    f.calls[0]!.finish(); await setImmediate();
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('Claude queue edit/cancel enforce owner, version, immutable claim and atomic mutation receipt', async () => {
  const f = await fixture();
  try {
    const { key } = (await f.create()); (await f.send(key, 'first')); await f.owner.driver.wake(key);
    const queued = (await f.send(key, 'second')), id = queued.idempotencyKey;
    const version = f.store.turns.version('claude-code', key, id)!;
    const scope = 'mutation'; await f.store.commands.claimAsync(scope, 'edit', {});
    const commit = f.store.commands.queueCommit(scope, 'edit', { status: 200, body: { ok: true } });
    assert.throws(() => f.owner.commands.editQueued(key, id, 'wrong', version, { actorId: 'other' }), TurnAuthorizationError);
    assert.throws(() => f.owner.commands.cancelQueued(key, id, version, { actorId: 'other' }), TurnAuthorizationError);
    assert.throws(() => f.owner.commands.editQueued(key, id, 'changed', version, { actorId: 'owner' }, () => { throw new Error('mutation failed'); }), /mutation failed/);
    assert.equal(f.store.turns.version('claude-code', key, id), version);
    assert.equal(f.owner.commands.editQueued(key, id, 'changed', version, { actorId: 'owner' }, commit), true);
    assert.equal(f.store.commands.get(scope, 'edit')?.state, 'accepted');
    assert.equal(f.owner.commands.cancelQueued(key, id, version, { actorId: 'owner' }), false);
    const nextVersion = f.store.turns.version('claude-code', key, id)!;
    assert.throws(() => f.owner.commands.cancelQueued(key, id, '', { actorId: 'owner' }), /version/);
    assert.throws(() => f.owner.commands.cancelQueued(key, id, nextVersion, { actorId: 'owner' }, () => { throw new Error('cancel failed'); }), /cancel failed/);
    assert.ok(f.store.turns.ownedEntry('claude-code', key, id, 'owner'));
    await f.store.commands.claimAsync(scope, 'cancel', {});
    assert.equal(f.owner.commands.cancelQueued(key, id, nextVersion, { actorId: 'owner' },
      f.store.commands.queueCommit(scope, 'cancel', { status: 200, body: { ok: true } })), true);
    assert.equal(f.store.commands.get(scope, 'cancel')?.state, 'accepted');
    f.calls[0]!.finish(); await setImmediate(); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('Claude stop never retargets a stale run or equates request ACK with terminal outcome', async () => {
  const f = await fixture();
  try {
    const { key } = (await f.create()); (await f.send(key, 'first')); await f.owner.driver.wake(key);
    const first = f.calls[0]!.id;
    await assert.rejects(f.owner.commands.interrupt(key, 'wrong-id', { actorId: 'owner' }), RunControlConflict);
    f.revoke(); await assert.rejects(f.owner.commands.interrupt(key, first, { actorId: 'owner' }), TurnAuthorizationError); f.grant();
    assert.equal(f.calls[0]!.stops, 0);
    assert.equal(await f.owner.commands.interrupt(key, first, { actorId: 'owner' }), 'accepted');
    await setImmediate(); assert.equal(f.store.claudeJournal.current(key)?.phase, 'interrupted');
    (await f.send(key, 'second')); await f.owner.driver.wake(key);
    await assert.rejects(f.owner.commands.interrupt(key, first, { actorId: 'owner' }), RunControlConflict);
    assert.equal(await f.owner.driver.interrupt(key, first, { actorId: 'owner', text: '', images: [] }), 'not_started');
    assert.equal(f.calls[1]!.stops, 0);
  } finally { await f.close(); }
});

test('Claude unknown invocation cannot be replayed', async () => {
  const f = await fixture();
  try {
    const { key } = (await f.create()); (await f.send(key, 'first')); await f.owner.driver.wake(key);
    f.calls[0]!.fail(); await setImmediate();
    assert.equal(f.store.claudeJournal.current(key)?.phase, 'unknown');
    await assert.rejects(f.send(key, 'retry'), /unknown/);
    await f.owner.driver.wake(key); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('Claude uncertain admission preserves the input and forbids edit/cancel/replay', async () => {
  const f = await fixture(true, 'lost-ack');
  try {
    const { key } = (await f.create()), sent = (await f.send(key, 'unconfirmed')), id = sent.idempotencyKey;
    await f.owner.driver.wake(key);
    assert.equal(f.store.claudeJournal.current(key)?.phase, 'unknown');
    assert.equal(f.store.turns.head('claude-code', key)?.state, 'outcome_unknown');
    const version = f.store.turns.version('claude-code', key, id)!;
    assert.equal(f.owner.commands.cancelQueued(key, id, version, { actorId: 'owner' }), false);
    assert.equal(f.owner.commands.editQueued(key, id, 'different', version, { actorId: 'owner' }), false);
    await assert.rejects(f.send(key, 'retry'), /unknown/);
    await f.owner.driver.wake(key); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('Claude uncertain stop is returned as unknown and cannot be issued again', async () => {
  const f = await fixture(true, 'lost-stop');
  try {
    const { key } = (await f.create()); (await f.send(key, 'first')); await f.owner.driver.wake(key);
    const id = f.calls[0]!.id;
    assert.equal(await f.owner.commands.interrupt(key, id, { actorId: 'owner' }), 'unknown');
    assert.equal(f.store.claudeJournal.current(key)?.phase, 'unknown');
    assert.equal(f.store.claudeJournal.current(key)?.stopRequested, true);
    await assert.rejects(f.owner.commands.interrupt(key, id, { actorId: 'owner' }), RunControlConflict);
    assert.equal(f.calls[0]!.stops, 1);
  } finally { await f.close(); }
});

test('Claude can cancel a provably unsent input before startup without waking native', async () => {
  const f = await fixture(false);
  try {
    const key = `claude-code:${randomUUID()}`, id = randomUUID();
    f.store.claudeJournal.create({ key, nativeSessionId: randomUUID(), title: 'Existing session', createdAt: 0 });
    await f.store.turns.enqueueAsync('claude-code', { id, sessionKey: key, createdAt: 0, payload: { actorId: 'owner', text: 'unsent', images: [] } });
    assert.equal(f.owner.commands.cancelQueued(key, id, f.store.turns.version('claude-code', key, id)!, { actorId: 'owner' }), true);
    await f.owner.driver.wake(key);
    assert.equal(f.calls.length, 0); assert.equal(f.owner.inspectMaintenance().startupState, 'pending');
  } finally { await f.close(); }
});

test('Claude commands respect startup, runtime and global maintenance fences', async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(f.create(), /not ready/);
    assert.deepEqual(f.store.claudeJournal.sessionKeys(), []);
    assert.equal(await f.owner.initialize(), true);
    const { key } = (await f.create());
    const globalResume = f.store.pauseTurnStarts();
    await assert.rejects(f.create(), /ownership/); await assert.rejects(f.send(key, 'text'), /ownership/);
    assert.equal(globalResume(), true);
    const pause = f.owner.pauseQueueWorker(); await pause.drained;
    await assert.rejects(f.create(), /ownership/); await assert.rejects(f.send(key, 'text'), /ownership/);
    assert.equal(pause.resume(), true);
    (await f.send(key, 'text')); await f.owner.driver.wake(key); assert.equal(f.calls.length, 1);
    await f.owner.close(); await assert.rejects(f.create(), /ownership/);
  } finally { await f.close(); }
});

test('Claude commands compose with HTTP receipts: lost responses recover without re-creation or re-send', async () => {
  const f = await fixture();
  try {
    const app = new Hono(), createPath = '/agents/:agentId/sessions', messagePath = '/sessions/:sessionKey';
    let creates = 0, sends = 0;
    const authorize = () => {
      try { f.authorize(); } catch { throw new HTTPException(403, { res: Response.json({ error: 'revoked' }, { status: 403 }) }); }
    };
    // Authenticated owner is fixed in this isolated fixture. These routes are
    // not product routes, which remain explicitly disabled for this runtime.
    registerCreationReceipts(app, createPath, { receipts: f.store.commands, scope: c => {
      authorize(); return JSON.stringify(['owner', c.req.param('agentId')]);
    } });
    app.post(createPath, c => {
      creates++;
      f.owner.commands.createSession('HTTP fixture', { authorize,
        accept: result => c.get('commitCreation')({ status: 201, body: result }) });
      return c.json({ error: 'Synthetic response loss after commit' }, 503);
    });
    registerMessageReceipts(app, messagePath, { receipts: f.store.commands, scope: c => {
      authorize(); return JSON.stringify(['owner', c.req.param('sessionKey')]);
    } });
    app.post(`${messagePath}/messages`, async c => {
      sends++;
      const key = c.req.param('sessionKey'), body = await c.req.json();
      await f.owner.commands.sendAsync(key, body.message, { actorId: 'owner',
        accept: result => f.store.commands.queueCommit(JSON.stringify(['owner', key]), c.get('commandKey'), { status: 200, body: result }) });
      return c.json({ error: 'Synthetic response loss after commit' }, 503);
    });
    const post = (path: string, command: string, body: object) => app.request(path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': command }, body: JSON.stringify(body) });
    const first = await post('/agents/claude-code/sessions', 'create-once', { title: 'HTTP fixture' });
    assert.equal(first.status, 201);
    const created = await first.json();
    assert.equal(created.command.state, 'accepted');
    assert.deepEqual(await (await post('/agents/claude-code/sessions', 'create-once', { title: 'HTTP fixture' })).json(), created);
    assert.equal(creates, 1);
    const path = `/sessions/${encodeURIComponent(created.key)}/messages`;
    const sent = await (await post(path, 'send-once', { message: 'First message' })).json();
    assert.equal(sent.command.state, 'accepted');
    assert.deepEqual(await (await post(path, 'send-once', { message: 'First message' })).json(), sent);
    assert.equal(sends, 1);
    await f.owner.driver.wake(created.key); assert.equal(f.calls.length, 1);
    f.revoke(); assert.equal((await post(path, 'send-once', { message: 'First message' })).status, 403);
    assert.equal(f.store.commands.get(JSON.stringify(['owner', created.key]), 'send-once')?.state, 'accepted');
  } finally { await f.close(); }
});

import assert from 'node:assert/strict';
import { SessionPreferencePersistenceError } from './session-preference-file.js';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ActivityEntry, ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { deleteConnectorSession } from '../connector/session-delete.js';
import { CodexAppServer } from '../codex/app-server.js';
import { DeckStore } from './deck-store.js';

const key = 'agent:ops-dev:dashboard:agentopsdeck-web-deleted';
const other = 'agent:ops-dev:dashboard:agentopsdeck-web-other';
const nativeReply = (method: string, sessionKey = key) => ({ connectionId: 'synthetic', payload: method === 'sessions.describe'
  ? { session: { key: sessionKey } } : { ok: true, key: sessionKey, deleted: true } });
const scope = (sessionKey = key) => JSON.stringify(['delete', JSON.stringify(['alice', sessionKey])]);
const summary = (sessionKey = key): SessionSummary => ({ sessionKey, agentId: 'ops-dev', source: 'web', title: 'Original', status: 'running' });
const message = (sessionKey = key): ChatMessage => ({ id: 'reply', sessionKey, role: 'assistant', text: 'Original reply', createdAt: 1 });
const activity = (sessionKey = key): ActivityEntry => ({ id: 'tool', sessionKey, toolCallId: 'tool', runId: 'run', toolName: 'exec',
  status: 'running', updatedAt: 1, durationMs: 0, hiddenArgumentCount: 0 });
function projection(owner: ConnectorUserStore, options: ConstructorParameters<typeof DeckStore>[0] = {}) {
  return new DeckStore({ eventLog: owner.events, sessionDeleted: key => owner.commands.sessionDeletion(key) === 'accepted', ...options });
}
function accept(owner: ConnectorUserStore, sessionKey = key) {
  owner.commands.claim(scope(sessionKey), 'delete', {});
  owner.commands.settle(scope(sessionKey), 'delete', { status: 200, body: { ok: true, status: 'delete_accepted' } });
}
function seed(store: DeckStore, sessionKey = key) {
  store.upsertSession(summary(sessionKey)); store.addMessage(message(sessionKey)); store.replaceActivities(sessionKey, [activity(sessionKey)]);
}
function absent(store: DeckStore, sessionKey = key) {
  assert.equal(store.getSession(sessionKey), undefined);
  assert.equal(store.getSessionExecution(sessionKey), undefined);
  assert.deepEqual(store.getMessages(sessionKey), []);
  assert.deepEqual(store.getActivity(sessionKey), []);
  assert.equal(store.getSessionsState({ includeHidden: true, includeArchived: true }).groups.flatMap(g => g.sessions).some(s => s.sessionKey === sessionKey), false);
  assert.equal(store.getAttention().sessions.some(s => s.sessionKey === sessionKey), false);
  assert.equal(store.getSessionDirectory().sessions.some(s => s.sessionKey === sessionKey), false);
  assert.deepEqual(store.getSessionDirectory({ sessionKey }).sessions, []);
}

for (const state of ['outcome_unknown', 'rejected', 'accepted'] as const) {
  test(`${state}: only durable acceptance excludes existing projection from every snapshot`, t => {
    const owner = new ConnectorUserStore(':memory:'); t.after(() => owner.close());
    const store = projection(owner); seed(store); seed(store, other);
    store.hideSession(key); store.archiveSession(key); store.pinSession(key);
    owner.commands.claim(scope(), 'delete', {});
    if (state === 'accepted') accept(owner);
    if (state === 'rejected') owner.commands.settle(scope(), 'delete', { status: 409, body: {} });
    if (state === 'accepted') {
      absent(store);
      const counts = store.getSessionsState({ includeHidden: true, includeArchived: true });
      assert.equal(counts.hiddenCount, 0); assert.equal(counts.archivedCount, 0); assert.equal(counts.pinnedCount, 0);
    } else {
      assert.equal(store.getSession(key)?.title, 'Original');
      assert.equal(store.getMessages(key)[0]?.text, 'Original reply');
      assert.equal(store.getActivity(key).length, 1);
      store.addMessage({ ...message(), id: 'late', text: 'Still visible' });
      assert.equal(store.getMessages(key).length, 2);
    }
    assert.equal(store.getSession(other)?.title, 'Original');
  });
}

for (const sessionKey of [key, 'codex:synthetic-thread', 'hermes:synthetic-session']) {
  test(`${sessionKey}: accepted deletion suppresses late refresh, restore, tools and overrides across restart`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-projection-deletion-'));
    const file = join(directory, 'synthetic.sqlite');
    let owner = new ConnectorUserStore(file);
    t.after(() => { owner.close(); rmSync(directory, { recursive: true, force: true }); });
    await owner.commands.claimAsync(scope(sessionKey), 'delete', {});
    accept(owner, sessionKey);
    const receipt = owner.commands.get(scope(sessionKey), 'delete');
    owner.close(); owner = new ConnectorUserStore(file); owner.events.beginEpoch();
    const store = projection(owner);
    const cursor = store.latestEventId();
    seed(store, sessionKey);
    store.replaceSessions([{ ...summary(sessionKey), key: sessionKey }]);
    store.replaceMessages(sessionKey, [message(sessionKey)], { authoritative: true });
    store.ingestGatewayEvent({ event: 'tool.started', payload: activity(sessionKey) });
    store.ingestGatewayEvent({ event: 'chat', payload: { sessionKey, state: 'error', errorMessage: 'Late failure' } });
    store.applySessionUsage(new Map([[sessionKey, { totalTokens: 100 }]]));
    store.markSessionBusy(sessionKey);
    store.renameSession(sessionKey, 'Late title');
    store.persistSessionTitleOverride(sessionKey, 'Late persisted title');
    store.persistSessionThinkingOverride(sessionKey, 'high');
    store.hideSession(sessionKey); store.unhideSession(sessionKey);
    store.archiveSession(sessionKey); store.unarchiveSession(sessionKey);
    store.pinSession(sessionKey); store.unpinSession(sessionKey);
    assert.equal(store.removeMessage(sessionKey, 'reply'), false);
    absent(store, sessionKey);
    assert.equal(store.latestEventId(), cursor, 'no late presentation event enters durable SSE journal');
    assert.deepEqual(owner.commands.get(scope(sessionKey), 'delete'), receipt);
    assert.equal(owner.turns.list('openclaw').length, 0);
    assert.equal(owner.turns.list('codex').length, 0);
    seed(store, other); assert.equal(store.getMessages(other).length, 1);
  });
}

test('acceptance during an awaited history fetch suppresses its eventual projection without replay', async t => {
  const owner = new ConnectorUserStore(':memory:'); t.after(() => owner.close());
  const store = projection(owner); seed(store);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const refresh = (async () => { await wait; seed(store); store.replaceMessages(key, [message()]); })();
  accept(owner); store.removeSession(key);
  const cursor = store.latestEventId();
  release(); await refresh;
  absent(store); assert.equal(store.latestEventId(), cursor);
});

test('refresh removes a pre-ACK synthetic session without restoring it through the previous-row fallback', t => {
  const owner = new ConnectorUserStore(':memory:'); t.after(() => owner.close());
  const store = projection(owner); seed(store); seed(store, other);
  accept(owner);
  const cursor = store.latestEventId();
  store.replaceSessions([summary()]);
  absent(store); assert.ok(store.getSession(other), 'unrelated synthetic session remains');
  const events = store.getEventsSince(cursor);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.payload, { sessionKey: key, status: 'deleted' });
  const deletedCursor = store.latestEventId();
  store.replaceSessions([summary()]); assert.equal(store.latestEventId(), deletedCursor);
});

test('accepted deletion publishes removal before a preference write fails; reads do not repeat cleanup', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-deletion-preferences-'));
  const hiddenFile = join(directory, 'hidden.json');
  const owner = new ConnectorUserStore(join(directory, 'synthetic.sqlite'));
  t.after(() => { owner.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = projection(owner, { hiddenSessionsFile: hiddenFile }); seed(store);
  store.hideSession(key);
  // Replace only the synthetic test file with a directory to force EISDIR.
  rmSync(hiddenFile); mkdirSync(hiddenFile);
  const cursor = store.latestEventId(); let nativeWrites = 0;
  await owner.commands.claimAsync(scope(), 'delete', {});
  await assert.rejects(deleteConnectorSession({ store, refreshSessions: async () => {}, gateway: {
    requestBound: async method => { if (method === 'sessions.delete') nativeWrites++; return nativeReply(method) as never; },
  } }, key, () => {}, () => accept(owner)), SessionPreferencePersistenceError);
  assert.equal(nativeWrites, 1);
  assert.equal(owner.commands.get(scope(), 'delete')?.state, 'accepted');
  absent(store);
  assert.deepEqual(store.getEventsSince(cursor).map(e => e.payload), [{ sessionKey: key, status: 'deleted' }]);
  // A later user preference for another session must not be erased by reads.
  rmSync(hiddenFile, { recursive: true });
  store.hideSession(other);
  const saved = readFileSync(hiddenFile, 'utf8');
  store.replaceSessions([summary()]); absent(store);
  assert.equal(readFileSync(hiddenFile, 'utf8'), saved);
  assert.equal(nativeWrites, 1);
});

test('deleting an absent projection still emits a bounded removal marker after durable acceptance', t => {
  const owner = new ConnectorUserStore(':memory:'); t.after(() => owner.close());
  const store = projection(owner); accept(owner);
  const cursor = store.latestEventId();
  assert.equal(store.removeSession(key), false);
  assert.deepEqual(store.getEventsSince(cursor).map(e => e.payload), [{ sessionKey: key, status: 'deleted' }]);
});

test('late native evidence still updates its durable execution fact without reviving presentation', t => {
  const owner = new ConnectorUserStore(':memory:'); t.after(() => owner.close());
  const store = projection(owner); seed(store);
  const runs = owner.openClawExecutions;
  store.bindOpenClawExecutions(runs);
  runs.begin(key, 'command'); runs.acknowledge(key, 'command', 'run');
  owner.turns.enqueue('openclaw', { id: 'legacy-queued', sessionKey: key, createdAt: 1, payload: { text: 'Do not discard' } });
  const queued = owner.turns.list('openclaw');
  // Simulate a historical accepted receipt coexisting with legacy execution.
  accept(owner); store.removeSession(key);
  const before = runs.get(key)!;
  const cursor = store.latestEventId();
  store.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey: key, runId: 'run' } });
  const after = runs.get(key)!;
  assert.equal(after.phase, 'completed'); assert.equal(after.commandId, before.commandId);
  assert.ok(after.revision !== undefined && before.revision !== undefined && after.revision > before.revision);
  assert.equal(after.historySync?.state, 'pending', 'deletion never invents successful response synchronization');
  assert.deepEqual(owner.turns.list('openclaw'), queued, 'projection removal never cancels durable queued work');
  absent(store);
  const events = store.getEventsSince(cursor);
  assert.equal(events.length, 1);
  assert.equal((events[0]?.payload as { invalidation: boolean }).invalidation, true, 'execution invalidation is preserved, not a visible run projection');
});

test('deletion visibility is node-local even when two nodes use the same raw session key', t => {
  const first = new ConnectorUserStore(':memory:'), second = new ConnectorUserStore(':memory:');
  t.after(() => { first.close(); second.close(); });
  const a = projection(first), b = projection(second); seed(a); seed(b);
  accept(first); a.removeSession(key); absent(a);
  assert.equal(b.getSession(key)?.title, 'Original');
  assert.deepEqual(b.getMessages(key), [message()]);
  assert.equal(second.commands.sessionDeletion(key), undefined);
});

test('hiding an accepted deleted child does not invent native quiescence for its parent', t => {
  const owner = new ConnectorUserStore(':memory:'); t.after(() => owner.close());
  const store = projection(owner), child = 'agent:ops-dev:subagent:synthetic-child';
  accept(owner, child);
  store.replaceSessions([{ ...summary(), status: 'idle' }, {
    sessionKey: child, agentId: 'ops-dev', status: 'running', requesterSessionKey: key,
  }]);
  assert.equal(store.getSession(child), undefined);
  assert.equal(store.getSession(key)?.pendingSubagentCount, 1, 'native child activity remains evidence, not a visible deleted row');
});

test('unavailable deletion facts fail snapshot and late write closed', t => {
  let failed = false;
  const store = new DeckStore({ sessionDeleted: () => { if (failed) throw new Error('receipt database unavailable'); return false; } });
  seed(store); failed = true;
  for (const read of [() => store.getSession(key), () => store.getSessionExecution(key), () => store.getMessages(key),
    () => store.getActivity(key), () => store.getSessionDirectory(), () => store.getSessionsState(), () => store.getAttention()]) {
    assert.throws(read, /receipt database unavailable/);
  }
  assert.throws(() => store.addMessage({ ...message(), id: 'late' }), /receipt database unavailable/);
  failed = false; assert.equal(store.getMessages(key).length, 1);
});

for (const runtime of ['openclaw', 'codex']) {
  test(`${runtime}: ACK and deletion notification do not yield to another live reader`, async t => {
    const owner = new ConnectorUserStore(':memory:');
    const store = projection(owner), sessionKey = runtime === 'codex' ? 'codex:synthetic' : key;
    seed(store, sessionKey);
    let codex: CodexAppServer | undefined;
    t.after(async () => { await codex?.close(); owner.close(); });
    let nativeWrites = 0;
    if (runtime === 'codex') {
      codex = new CodexAppServer({ enabled: false, command: 'must-not-launch', defaultCwd: '/nonexistent',
        defaultModel: 'test', approvalPolicy: 'never', requestTimeoutMs: 5, store, turnQueue: owner.turns,
        executions: owner.codexExecutions, authorizeTurn: () => false });
      const adapter = codex as any;
      adapter.ensureStarted = async () => {};
      adapter.request = async (method: string) => { assert.equal(method, 'thread/archive'); nativeWrites++; return {}; };
    }
    const cursor = store.latestEventId();
    let observed: unknown[] | undefined;
    await deleteConnectorSession({ store, ...(codex ? { codex } : {}), refreshSessions: async () => {}, gateway: {
      requestBound: async method => { if (method === 'sessions.delete') nativeWrites++; return nativeReply(method, sessionKey) as never; },
    } }, sessionKey, () => {}, () => {
      accept(owner, sessionKey);
      queueMicrotask(() => { observed = store.getEventsSince(cursor).map(e => e.payload); });
    });
    assert.equal(nativeWrites, 1);
    assert.deepEqual(observed, [{ sessionKey, status: 'deleted' }]);
    absent(store, sessionKey);
  });
}

for (const checkpoint of ['before_receipt', 'after_receipt', 'after_event']) {
  test(`process exit ${checkpoint}: restart replaces the old cursor and derives visibility from durable evidence`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-delete-crash-'));
    const file = join(directory, 'synthetic.sqlite');
    let owner: ConnectorUserStore | undefined;
    t.after(() => { owner?.close(); rmSync(directory, { recursive: true, force: true }); });
    const script = `
      import { ConnectorUserStore } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? '../connector/connector-user-store.ts' : '../connector/connector-user-store.js', import.meta.url).href)};
      import { DeckStore } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? './deck-store.ts' : './deck-store.js', import.meta.url).href)};
      import { deleteConnectorSession } from ${JSON.stringify(new URL(import.meta.url.endsWith('.ts') ? '../connector/session-delete.ts' : '../connector/session-delete.js', import.meta.url).href)};
      const owner = new ConnectorUserStore(${JSON.stringify(file)}, undefined, { runtimeOwner: true });
      owner.events.beginEpoch();
      const key = ${JSON.stringify(key)}, scope = ${JSON.stringify(scope())}, checkpoint = ${JSON.stringify(checkpoint)};
      const store = new DeckStore({ eventLog: owner.events, sessionDeleted: key => owner.commands.sessionDeletion(key) === 'accepted' });
      store.upsertSession(${JSON.stringify(summary())});
      await owner.commands.claimAsync(scope, 'delete', {});
      const append = owner.events.append.bind(owner.events);
      owner.events.append = event => {
        const result = append(event);
        if (checkpoint === 'after_event' && event.payload.status === 'deleted') process.exit(0);
        return result;
      };
      await deleteConnectorSession({ store, refreshSessions: async () => {}, gateway: {
        requestBound: async method => ({ connectionId: 'synthetic', payload: method === 'sessions.describe'
          ? { session: { key } } : { ok: true, key, deleted: true } })
      } }, key,
        () => {}, () => {
          if (checkpoint === 'before_receipt') process.exit(0);
          owner.commands.settle(scope, 'delete', { status: 200, body: { ok: true, status: 'delete_accepted' } });
          if (checkpoint === 'after_receipt') process.exit(0);
        });
      process.exit(2);
    `;
    const child = spawnSync(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    owner = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    const original = owner.commands.get(scope(), 'delete');
    assert.equal(original?.state, checkpoint === 'before_receipt' ? 'outcome_unknown' : 'accepted');
    const events = owner.events.getEventsSince(owner.events.latestEventId().replace(/:\d+$/, ':0'));
    assert.equal(events.length, checkpoint === 'after_event' ? 2 : 1);
    const oldCursor = events[0]!.id;
    // This is the same mandatory epoch transition as Connector composition.
    owner.events.beginEpoch();
    assert.equal(owner.events.hasEvent(oldCursor), false);
    assert.deepEqual(owner.events.getEventsSince(oldCursor), []);
    const store = projection(owner); seed(store);
    if (checkpoint === 'before_receipt') assert.equal(store.getSession(key)?.title, 'Original', 'native ACK without a receipt remains unknown, not deletion proof');
    else absent(store);
    assert.deepEqual(owner.commands.get(scope(), 'delete'), original, 'recovery never rewrites or retries the command');
  });
}

test('deletion event I/O failure preserves its receipt and recovers visibility through a new snapshot epoch', async t => {
  const owner = new ConnectorUserStore(':memory:'); t.after(() => owner.close());
  const store = projection(owner); seed(store);
  const before = store.latestEventId()!;
  const db = (owner as unknown as { db: DatabaseSync }).db;
  db.exec(`CREATE TRIGGER synthetic_deletion_failure BEFORE INSERT ON connector_events
    WHEN json_extract(new.body, '$.payload.status') = 'deleted'
    BEGIN SELECT RAISE(ABORT, 'synthetic journal I/O failure'); END;`);
  const controller = new AbortController(); t.after(() => controller.abort());
  const wake = store.changes.wait(store.changes.revision, controller.signal);
  let nativeWrites = 0;
  const result = await deleteConnectorSession({ store, refreshSessions: async () => {}, gateway: {
    requestBound: async method => { if (method === 'sessions.delete') nativeWrites++; return nativeReply(method) as never; },
  } }, key, () => {}, () => accept(owner));
  await wake;
  assert.equal(nativeWrites, 1); assert.deepEqual(result, { ok: true });
  assert.equal(owner.commands.get(scope(), 'delete')?.state, 'accepted');
  assert.equal(store.changes.waiting, 0);
  assert.throws(() => owner.events.latestEventId(), /journal unavailable/);
  // Only deletion events are rejected: a reset is writable, and the accepted
  // receipt plus synchronous removal already determine the current snapshot.
  const after = store.latestEventId()!;
  assert.notEqual(after, before); assert.match(after, /:0$/);
  assert.equal(store.hasEvent(before), false);
  assert.deepEqual(store.getEventsSince(after), []);
  absent(store);
  assert.equal(owner.commands.get(scope(), 'delete')?.state, 'accepted');
  assert.equal(nativeWrites, 1, 'snapshot recovery never redispatches deletion');
});

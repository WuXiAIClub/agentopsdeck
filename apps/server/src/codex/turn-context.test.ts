import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from '@agentopsdeck/shared';
import { appendTurnContext, normalizeTurnContext } from './turn-context.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { CodexExecutions } from './executions.js';
import { CodexAppServer, historicalMessages } from './app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';

const sessionKey = 'codex:synthetic';
const echo = (text: string): ChatMessage => ({ id: 'command', sessionKey, turnId: 'native-run', role: 'user', text,
  status: 'sent', createdAt: 1, updatedAt: 1 });

test('batch context identity indexes retain exact and ambiguous proof semantics across pages', () => {
  const db = new DatabaseSync(':memory:'), logs: any[] = [];
  const prepare = db.prepare.bind(db), original = Error('private query failure');
  let failRead = false;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('run_id AS runId, hash')) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => { if (failRead) throw original; return Reflect.apply(all, statement, args) as ReturnType<typeof all>; };
    }
    return statement;
  };
  const executions = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, undefined,
    new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  try {
    const contextual = appendTurnContext([{ type: 'text', text: '  original\n' }], 'private-context');
    const text = contextual.input[0].text, proof = contextual.proof!;
    const insert = db.prepare('INSERT INTO connector_codex_turn_context VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 260; i++) insert.run(sessionKey, `command-${i}`, `run-${i}`, proof.hash, proof.originalLength);
    insert.run(sessionKey, 'ambiguous-a', 'shared-run', proof.hash, proof.originalLength);
    insert.run(sessionKey, 'ambiguous-b', 'shared-run', proof.hash, proof.originalLength);
    insert.run(sessionKey, 'empty-run', '', proof.hash, proof.originalLength);
    const messages: ChatMessage[] = Array.from({ length: 260 }, (_, i) => ({ ...echo(text), id: `command-${i}`, turnId: `run-${i}` }));
    const { turnId: _turnId, ...withoutRun } = echo(text);
    messages.push(
      { ...echo(text), id: 'command-0', turnId: 'run-1' }, // two different identities
      { ...echo(text), id: 'ambiguous-a', turnId: 'shared-run' },
      { ...echo(text), id: 'unknown', turnId: 'shared-run' },
      { ...echo(text), id: 'unknown', turnId: '' },
      { ...withoutRun, id: 'unknown' },
      { ...echo(text), id: 'command-2', role: 'assistant' },
      { ...echo(text), id: 'command-2', sessionKey: 'foreign' },
      { ...echo(text + ' changed'), id: 'command-2' });
    const rows = db.prepare('SELECT command_id AS commandId, run_id AS runId, hash, original_length AS originalLength FROM connector_codex_turn_context WHERE session_key = ?').all(sessionKey) as any[];
    const expected = messages.map(message => {
      const matches = rows.filter(row => row.commandId === message.id || row.runId === message.turnId);
      return message.role === 'user' && message.sessionKey === sessionKey && matches.length === 1
        ? normalizeTurnContext(message, matches[0]) : message;
    });
    const actual = executions.normalizeTurnContexts(sessionKey, messages);
    assert.deepEqual(actual, expected);
    assert.equal(executions.normalizeTurnContext(messages[0]!).text, '  original\n');
    for (const index of [260, 261, 262]) {
      // UNION must not collapse two distinct commands with identical proof data.
      assert.equal(executions.normalizeTurnContext(messages[index]!), messages[index]);
    }
    for (let i = 0; i < messages.length; i++) if (expected[i] === messages[i]) assert.equal(actual[i], messages[i]);
    assert.equal(logs[0].operation, 'codex-context-normalize');
    assert.equal(logs[0].changed, 261); assert.ok(logs[0].records >= 263);
    assert.equal(logs[0].settled, undefined); assert.equal(typeof logs[0].bodyMs, 'number');
    assert.doesNotMatch(JSON.stringify(logs), /private-context|command-\d|run-\d|SELECT/);
    db.exec('BEGIN'); db.prepare('DELETE FROM connector_codex_turn_context WHERE session_key = ?').run(sessionKey);
    assert.equal(executions.normalizeTurnContexts(sessionKey, messages), messages);
    db.exec('ROLLBACK'); assert.deepEqual(executions.normalizeTurnContexts(sessionKey, messages), expected);
    failRead = true;
    assert.throws(() => executions.normalizeTurnContexts(sessionKey, messages), error => error === original);
    assert.equal(logs.at(-1).category, 'failed');
    assert.doesNotMatch(JSON.stringify(logs), /private query/);
  } finally { db.close(); }
});

test('context reads reuse at most eight indexed batch shapes with nonmatching NULL padding', () => {
  const db = new DatabaseSync(':memory:'), prepare = db.prepare.bind(db);
  const counts = new Map<string, number>(), batches: { sql: string; bindings: unknown[]; rows: number }[] = [];
  db.prepare = sql => {
    counts.set(sql, (counts.get(sql) ?? 0) + 1);
    const statement = prepare(sql);
    if (sql.includes('run_id AS runId, hash')) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = Reflect.apply(all, statement, args) as ReturnType<typeof all>;
        batches.push({ sql, bindings: args, rows: rows.length }); return rows;
      };
    }
    return statement;
  };
  try {
    const executions = new CodexExecutions(db), contextual = appendTurnContext([{ type: 'text', text: 'original' }], 'context');
    const message = echo(contextual.input[0].text), proof = contextual.proof!;
    const insert = prepare('INSERT INTO connector_codex_turn_context VALUES (?, ?, ?, ?, ?)');
    insert.run(sessionKey, message.id, message.turnId!, proof.hash, proof.originalLength);
    // Padding with '' would unnecessarily fetch both of these unrelated rows.
    insert.run(sessionKey, '', 'unrelated-run', proof.hash, proof.originalLength);
    insert.run(sessionKey, 'unrelated-command', '', proof.hash, proof.originalLength);
    for (let repeat = 0; repeat < 2; repeat++) {
      for (let length = 1; length <= 128; length++) {
        const messages = Array<ChatMessage>(length).fill(message);
        assert.ok(executions.normalizeTurnContexts(sessionKey, messages).every(result => result.text === 'original'));
        const batch = batches.at(-1)!;
        assert.equal(batch.rows, 1);
        const size = (batch.bindings.length - 2) / 2;
        assert.ok(size >= length && size < length * 2);
        assert.deepEqual(batch.bindings.slice(1 + length, 1 + size), Array(size - length).fill(null));
        assert.equal(batch.bindings[1 + size], sessionKey);
        assert.deepEqual(batch.bindings.slice(2 + size + length), Array(size - length).fill(null));
      }
      assert.equal(executions.normalizeTurnContext(message).text, 'original');
    }
    const queries = [...counts].filter(([sql]) => sql.includes('FROM connector_codex_turn_context'));
    assert.equal(queries.length, 10); // existence + point read + eight batch shapes
    assert.ok(queries.every(([, count]) => count === 1));
    for (const sql of new Set(batches.map(batch => batch.sql))) {
      const batch = batches.find(batch => batch.sql === sql)!;
      const plan = JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...batch.bindings as (string | null)[]));
      assert.match(plan, /\(session_key=\? AND command_id=\?\)/);
      assert.match(plan, /\(session_key=\? AND run_id=\?\)/);
      assert.doesNotMatch(plan, /SCAN connector_codex_turn_context/);
    }
    const pointSql = queries.find(([sql]) => sql.includes('LIMIT 2'))![0];
    assert.match(pointSql, /run_id = \? LIMIT 2\s*\) LIMIT 2/);
    const pointPlan = JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${pointSql}`).all(sessionKey, message.id, sessionKey, message.turnId!));
    assert.match(pointPlan, /\(session_key=\? AND command_id=\?\)/);
    assert.match(pointPlan, /\(session_key=\? AND run_id=\?\)/);
    assert.deepEqual(executions.normalizeTurnContexts(sessionKey, []), []);
    assert.equal(batches.length, 256);
    const foreignDb = new DatabaseSync(':memory:'), foreign = new CodexExecutions(foreignDb);
    try { assert.equal(foreign.normalizeTurnContext(message), message); }
    finally { foreignDb.close(); }
    db.exec('BEGIN; DELETE FROM connector_codex_turn_context');
    assert.equal(executions.normalizeTurnContext(message), message);
    db.exec('ROLLBACK'); assert.equal(executions.normalizeTurnContext(message).text, 'original');
    for (let i = 0; i < 64; i++) insert.run(sessionKey, `duplicate-${i}`, 'duplicate-run', proof.hash, proof.originalLength);
    const ambiguous = { ...message, id: 'duplicate-63', turnId: 'duplicate-run' };
    assert.equal(executions.normalizeTurnContext(ambiguous), ambiguous);
  } finally { db.close(); }
});

test('context proof is durable, scoped and exact, including lost ACK, whitespace and empty image-only input', () => {
  for (const text of ['  original\n', '']) {
    const db = new DatabaseSync(':memory:');
    try {
      const executions = new CodexExecutions(db);
      const input = text ? [{ type: 'text', text }] : [{ type: 'localImage', path: '/synthetic/image.png' }];
      const contextual = appendTurnContext(input, 'private file convention');
      const native = contextual.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
      assert.equal(contextual.input.filter(item => item.type === 'text').length, 1);
      assert.equal(contextual.input.filter(item => item.type === 'text').map(item => item.text).join(''), native,
        'native flattened history and live event must produce the same text');
      assert.ok(executions.begin(sessionKey, 'command', 'connection', false, undefined, false, contextual.proof));
      assert.equal(executions.normalizeTurnContext(echo(native)).text, text); // client ID before ACK
      const uncorrelated = { ...echo(native), id: 'native-item' };
      assert.equal(executions.normalizeTurnContext(uncorrelated), uncorrelated);
      assert.ok(executions.acknowledge(sessionKey, 'command', 'connection', 'native-run', () => {}));
      const restarted = new CodexExecutions(db);
      assert.equal(restarted.normalizeTurnContext(uncorrelated).text, text);
      const changed = { ...echo(native), text: native + 'user continuation' };
      assert.equal(restarted.normalizeTurnContext(changed), changed);
      const foreign = { ...echo(native), sessionKey: 'codex:foreign' };
      assert.equal(restarted.normalizeTurnContext(foreign), foreign);
      assert.equal(restarted.normalizeTurnContext({ ...echo(native), role: 'assistant' }).text, native);
      assert.deepEqual(restarted.normalizeTurnContexts(sessionKey, [uncorrelated, foreign]), [{ ...uncorrelated, text }, foreign]);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM connector_codex_turn_context').all()).includes('private file'), false);
    } finally { db.close(); }
  }
});

test('proof transaction failure never begins an execution or displaces prior proof', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const executions = new CodexExecutions(db), proof = appendTurnContext([{ type: 'text', text: 'original' }], 'context').proof!;
    db.prepare('INSERT INTO connector_codex_turn_context VALUES (?, ?, ?, ?, ?)').run(sessionKey, 'command', null, proof.hash, proof.originalLength);
    assert.throws(() => executions.begin(sessionKey, 'command', 'connection', false, undefined, false, proof));
    assert.equal(executions.get(sessionKey), undefined);
    assert.equal((db.prepare('SELECT count(*) AS n FROM connector_codex_turn_context').get() as { n: number }).n, 1);
    assert.throws(() => appendTurnContext([], 'x'.repeat(64_001)), /limit/);
    assert.throws(() => appendTurnContext([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'context'), /envelope/);
  } finally { db.close(); }
});

for (const queued of [false, true]) test(`native file context preserves ${queued ? 'batch members' : 'original user input'} through history projection`, async () => {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore();
  let allowed = true, contextReads = 0;
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions,
    authorizeTurn: () => allowed, fileBoardContext: () => { contextReads++; return 'Task progress file: synthetic/tasks.json'; } });
  const runtime = codex as any, calls: { method: string; params: any }[] = [];
  runtime.connectionId = 'synthetic-connection'; runtime.ensureStarted = async () => {};
  runtime.request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'synthetic' } };
    if (method === 'thread/name/set') return {};
    assert.equal(method, 'turn/start'); return { turn: { id: 'native-run' } };
  };
  try {
    await codex.createSession({ title: 'Synthetic' }, () => {}, () => {});
    assert.equal(contextReads, 0); assert.equal(calls.filter(call => call.method === 'turn/start').length, 0);
    const batch = queued ? { separator: '\n\n[synthetic boundary]\n\n', members: [
      { id: 'command', createdAt: 1, imageCount: 0 }, { id: 'command-2', createdAt: 2, imageCount: 0 }] } : undefined;
    const text = batch ? 'first' + batch.separator + '  second\n' : '  original\n';
    allowed = false;
    await assert.rejects(runtime.startTurn(sessionKey, 'synthetic', [{ type: 'text', text }], 'command', undefined, undefined, batch));
    assert.equal(contextReads, 0); allowed = true;
    await runtime.startTurn(sessionKey, 'synthetic', [{ type: 'text', text }], 'command', undefined, undefined, batch);
    const dispatched = calls.filter(call => call.method === 'turn/start'); assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.params.clientUserMessageId, 'command');
    assert.ok(dispatched[0]!.params.input[0].text.startsWith(text + '\n\n'));
    const native = await historicalMessages(sessionKey, [{ id: 'native-run', items: [
      { type: 'userMessage', id: 'native-item', content: dispatched[0]!.params.input }] }]);
    runtime.replaceHistory(sessionKey, native, true);
    assert.deepEqual(store.getMessages(sessionKey).map(message => message.text), batch ? ['first', '  second\n'] : [text]);
    if (batch) assert.deepEqual(store.getMessages(sessionKey).map(message => message.id), ['command', 'command-2']);
    runtime.replaceHistory(sessionKey, native, true);
    assert.deepEqual(store.getMessages(sessionKey).map(message => message.text), batch ? ['first', '  second\n'] : [text]);
  } finally { await codex.close(); database.close(); }
});

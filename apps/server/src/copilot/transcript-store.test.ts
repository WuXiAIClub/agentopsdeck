import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal } from '../connector/sdk-execution-journal.js';
import { COPILOT_TRANSCRIPT_PAGE_BYTES, CopilotTranscriptStore } from './transcript-store.js';
import { projectCopilotMessage } from './message-projection.js';
import { projectCopilotToolDetail } from './tool-details.js';
const separator = '\n\n[Queued message boundary 00000000-0000-4000-8000-000000000001]\n\n';

test('lazy tool bodies persist separately, bind exact execution/scope, and never inflate pages', () => {
  const f = fixture();
  try {
    const append = (phase: 'start' | 'complete', agentId?: string) => {
      const event = { id: `${phase}-${agentId ?? 'root'}`, type: `tool.execution_${phase}`, timestamp: new Date(5).toISOString(),
        ...(agentId ? { agentId } : {}), data: { toolCallId: 'same-call', ...(phase === 'start'
          ? { toolName: 'view', arguments: { path: 'LAZY_PATH' } } : { success: true, result: { content: 'LAZY_BODY'.repeat(20_000) } }) } };
      const row = projectCopilotMessage(event)!, detail = projectCopilotToolDetail(event, row)!;
      f.store.append(f.ref, row, undefined, detail); f.store.append(f.ref, row, undefined, detail);
      assert.throws(() => f.store.append(f.ref, row, undefined, { ...detail, text: 'changed' }));
      return f.store.page(f.key)!.messages.at(-1)!;
    };
    append('start'); const rootResult = append('complete'), childResult = append('complete', 'child');
    const page = f.store.page(f.key)!;
    assert.equal(page.totalCount, 3); assert.ok(page.messages.every(row => row.toolDetailAvailable));
    assert.ok(!JSON.stringify(page).includes('LAZY_'));
    assert.ok(f.store.toolDetail(f.key, rootResult.id)!.text.startsWith('Input\n'));
    assert.ok(!f.store.toolDetail(f.key, childResult.id)!.text.includes('LAZY_PATH'));
    assert.ok(f.store.toolDetail(f.key, rootResult.id)!.text.length <= 64_000);
    assert.equal(f.store.toolDetail(f.key, rootResult.id)!.truncated, true);
    assert.equal(f.store.toolDetail(f.key, 'foreign'), undefined);
    assert.throws(() => f.store.append(f.ref, f.row(), undefined, { text: 'illegal', truncated: false }));
    f.db.prepare("UPDATE copilot_transcript_details SET execution_id = 'foreign' WHERE public_id = ?").run(rootResult.id);
    assert.throws(() => f.store.toolDetail(f.key, rootResult.id));
  } finally { f.db.close(); }
});

function fixture(file = ':memory:', batch = false) {
  const db = new DatabaseSync(file), turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, 'ghcp');
  const store = new CopilotTranscriptStore(db, () => 1234), key = 'ghcp:fixture', ref = { key, id: 'execution', epoch: 'epoch' };
  if (!journal.session(key)) {
    journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
    turns.enqueue('ghcp', { id: 'first', sessionKey: key, createdAt: 0, payload: { text: 'Hello' } });
    if (batch) turns.enqueue('ghcp', { id: 'second', sessionKey: key, createdAt: 1, payload: { text: 'World' } });
    journal.begin(ref, batch ? ['first', 'second'] : ['first'], turns, batch ? { separator, members: [
      { id: 'first', createdAt: 0, imageCount: 0 }, { id: 'second', createdAt: 1, imageCount: 0 },
    ] } : undefined);
  }
  const row = (id = 'message', text = 'Hello', role = 'assistant', parent?: string) => projectCopilotMessage({
    id, type: `${role}.message`, timestamp: new Date(5000).toISOString(),
    data: { messageId: id, content: text, ...(parent ? { parentToolCallId: parent } : {}) },
  })!;
  return { db, store, journal, turns, key, ref, row };
}

test('file evidence walks bounded summary pages without overlaps or tool-detail tables', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 45; i++) f.store.append(f.ref, f.row(`file-page-${i}`, `text-${i}`));
    f.db.exec('ALTER TABLE copilot_transcript_details RENAME TO hidden_details');
    const texts: string[] = [], sizes: number[] = [];
    let before: string | undefined;
    do {
      const page = f.store.fileEvidencePage(f.key, before);
      sizes.push(page.scanned); texts.unshift(...page.messages.map(message => message.text));
      assert.ok(page.bytes <= 1024 * 1024);
      before = page.before;
    } while (before);
    assert.deepEqual(sizes, [20, 20, 5]);
    assert.deepEqual(texts, Array.from({ length: 45 }, (_, i) => `text-${i}`));
    f.db.exec("UPDATE sdk_agent_sessions SET native_session_id = 'replacement'");
    assert.throws(() => f.store.fileEvidencePage(f.key));
  } finally { f.db.close(); }
});

test('file evidence UTF-8 byte budget advances without dropping boundary summaries', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 7; i++) f.store.append(f.ref, f.row(`large-${i}`, '中'.repeat(100_000)));
    const sizes: number[] = [], ids = new Set<string>();
    let before: string | undefined;
    do {
      const page = f.store.fileEvidencePage(f.key, before);
      assert.ok(page.bytes <= COPILOT_TRANSCRIPT_PAGE_BYTES);
      sizes.push(page.scanned);
      for (const message of page.messages) { assert.ok(!ids.has(message.id)); ids.add(message.id); }
      before = page.before;
    } while (before);
    assert.deepEqual(sizes, [3, 3, 1]); assert.equal(ids.size, 7);
  } finally { f.db.close(); }
});

test('durable final history survives reopening with stable stream identity and no double text storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'copilot-transcript-')), file = join(root, 'store.sqlite');
  let f = fixture(file);
  try {
    f.store.updateStream(f.ref, { messageId: 'message', text: 'Hel', truncated: false });
    const id = f.store.liveMessages(f.key)[0]!.id;
    f.store.append(f.ref, f.row()); f.store.append(f.ref, f.row());
    assert.equal(f.store.liveMessages(f.key).length, 0);
    const page = f.store.page(f.key)!;
    assert.equal(page.messages.length, 1); assert.equal(page.messages[0]!.id, id);
    assert.equal(f.store.message(f.key, id)?.text, 'Hello');
    assert.throws(() => f.store.updateStream(f.ref, { messageId: 'message', text: 'late', truncated: false }));
    assert.throws(() => f.store.append(f.ref, f.row('message', 'changed')));
    assert.equal((f.db.prepare('SELECT length(data) AS bytes FROM copilot_transcript_events').get() as { bytes: number }).bytes, 64);
    f.db.close(); f = fixture(file);
    assert.deepEqual(f.store.page(f.key), page);
    assert.equal(f.store.liveMessages(f.key).length, 0);
  } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('root echo splits only server-authorized batch identities at actual dispatch time', () => {
  const f = fixture(':memory:', true);
  try {
    const text = `Hello${separator}World`, row = f.row('input', text, 'user');
    assert.throws(() => f.store.append(f.ref, row));
    assert.throws(() => f.store.append(f.ref, row, 'different'));
    assert.equal(f.store.page(f.key)!.totalCount, 0);
    f.store.append(f.ref, row, text);
    let page = f.store.page(f.key)!;
    assert.deepEqual(page.messages.map(row => [row.id, row.text, row.status, row.createdAt]), [
      ['first', 'Hello', 'sending', 5000], ['second', 'World', 'sending', 5000],
    ]);
    f.journal.acknowledge(f.ref, 'input', f.turns);
    page = f.store.page(f.key)!;
    assert.ok(page.messages.every(row => row.status === 'sent'));
    assert.throws(() => f.store.append(f.ref, f.row('different-user', text, 'user'), text));
    assert.equal(f.store.page(f.key)!.totalCount, 2);
    assert.equal(f.store.page(f.key, 1, 'second')!.messages[0]!.id, 'first');
    assert.equal(f.store.page(f.key, 1, 'second')!.hiddenCount, 0);
  } finally { f.db.close(); }
});

test('uncertain admission stays uncertain, stale epoch and foreign native binding fail closed', () => {
  const f = fixture();
  try {
    f.store.append(f.ref, f.row('input', 'Hello', 'user'), 'Hello');
    assert.throws(() => f.store.append({ ...f.ref, epoch: 'stale' }, f.row()));
    assert.throws(() => f.store.updateStream({ ...f.ref, epoch: 'stale' }, { messageId: 'm', text: 'x', truncated: false }));
    f.journal.markUnknown(f.ref, f.turns);
    assert.equal(f.store.page(f.key)!.messages[0]!.status, 'outcome_unknown');
    assert.throws(() => f.store.append(f.ref, f.row()));
    f.db.prepare("UPDATE sdk_agent_sessions SET native_session_id = 'foreign' WHERE runtime = 'ghcp'").run();
    assert.throws(() => f.store.page(f.key));
  } finally { f.db.close(); }
});

test('paging bounds UTF-8 payload and scopes cursors to session without skips', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 12; i++) f.store.append(f.ref, f.row(`m-${i}`, '漢'.repeat(100_000)));
    let page = f.store.page(f.key)!;
    assert.ok(page.messages.length < 12);
    const all: string[] = [];
    for (;;) {
      assert.equal(page.totalCount, 12);
      assert.ok(page.messages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0) <= COPILOT_TRANSCRIPT_PAGE_BYTES);
      all.unshift(...page.messages.map(m => m.id));
      if (!page.hiddenCount) break;
      page = f.store.page(f.key, 200, page.messages[0]!.id)!;
    }
    assert.equal(all.length, 12); assert.equal(new Set(all).size, 12);
    assert.equal(f.store.page(f.key, 200, 'foreign'), undefined);
    assert.throws(() => f.store.page(f.key, 201));
    assert.equal(f.store.page(f.key, 200, all[0])!.messages.length, 0);
  } finally { f.db.close(); }
});

test('tool summary omits raw arguments/results and child scope remains distinct', () => {
  const f = fixture();
  try {
    for (const parent of [undefined, 'child']) {
      f.store.append(f.ref, f.row(parent ? 'child-answer' : 'root-answer', 'answer', 'assistant', parent));
      const row = projectCopilotMessage({ id: parent ? 'child-tool' : 'root-tool', type: 'tool.execution_complete',
        timestamp: new Date(5000).toISOString(), data: { toolCallId: 'tool', success: true,
          result: 'SECRET_RAW_PAYLOAD', ...(parent ? { parentToolCallId: parent } : {}) } })!;
      f.store.append(f.ref, row);
    }
    const page = f.store.page(f.key)!;
    assert.equal(JSON.stringify(page).includes('SECRET_RAW_PAYLOAD'), false);
    const tools = page.messages.filter(m => m.role === 'tool');
    assert.notEqual(tools[0]!.toolCallId, tools[1]!.toolCallId);
    assert.ok(tools.every(m => m.toolDetailAvailable === false));
  } finally { f.db.close(); }
});

test('failed display write rolls back event claim and permits one exact retry', () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER reject_display BEFORE INSERT ON copilot_transcript_messages BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.throws(() => f.store.append(f.ref, f.row()));
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM copilot_transcript_events').get() as { n: number }).n, 0);
    f.db.exec('DROP TRIGGER reject_display'); f.store.append(f.ref, f.row());
    assert.equal(f.store.page(f.key)!.totalCount, 1);
  } finally { f.db.close(); }
});

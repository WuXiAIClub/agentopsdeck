import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal } from '../connector/sdk-execution-journal.js';
import { projectClaudeMessage } from './message-projection.js';
import { ClaudeTranscriptStore, CLAUDE_TRANSCRIPT_PAGE_BYTES } from './transcript-store.js';
import { claudeChatMessages, claudeMessageAnchor } from './session-view.js';
import { projectClaudeToolDetails } from './tool-details.js';

function fixture(file = ':memory:') {
  const db = new DatabaseSync(file), turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, 'claude-code');
  const store = new ClaudeTranscriptStore(db, () => 1234);
  const key = 'claude-code:fixture', ref = { key, id: 'execution', epoch: 'epoch' };
  if (!journal.session(key)) {
    journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
    turns.enqueue('claude-code', { id: 'first', sessionKey: key, createdAt: 0, payload: {} });
    journal.begin(ref, ['first'], turns);
  }
  const rows = (uuid = 'message', text = 'Hello') => projectClaudeMessage({ type: 'assistant', uuid,
    session_id: 'native', parent_tool_use_id: null, message: { role: 'assistant', content: text } }, 'native');
  return { db, turns, journal, store, key, ref, rows };
}

test('file evidence walks bounded summary pages without overlaps or tool-detail tables', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 45; i++) f.store.append(f.ref, f.rows(`file-page-${i}`, `text-${i}`));
    f.db.exec('ALTER TABLE claude_transcript_details RENAME TO hidden_details');
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
    for (let i = 0; i < 7; i++) f.store.append(f.ref, f.rows(`large-${i}`, '中'.repeat(100_000)));
    const sizes: number[] = [], ids = new Set<string>();
    let before: string | undefined;
    do {
      const page = f.store.fileEvidencePage(f.key, before);
      assert.ok(page.bytes <= CLAUDE_TRANSCRIPT_PAGE_BYTES);
      sizes.push(page.scanned);
      for (const message of page.messages) { assert.ok(!ids.has(message.id)); ids.add(message.id); }
      before = page.before;
    } while (before);
    assert.deepEqual(sizes, [3, 3, 1]); assert.equal(ids.size, 7);
  } finally { f.db.close(); }
});

test('tool details persist separately, resolve exact parent links and survive reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-details-')), file = join(root, 'store.sqlite');
  let f = fixture(file);
  try {
    const append = (uuid: string, parent: string | null, type: string, block: unknown) => {
      const event = { type, uuid, session_id: 'native', parent_tool_use_id: parent, message: { role: type, content: [block] } };
      const rows = projectClaudeMessage(event, 'native'), details = projectClaudeToolDetails(event, 'native');
      f.store.append(f.ref, rows, undefined, details);
      f.store.append(f.ref, rows, undefined, details);
      assert.throws(() => f.store.append(f.ref, rows, undefined, details.map(row => ({ ...row, text: 'changed' }))));
    };
    append('call', null, 'assistant', { type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'PRIVATE_PATH' } });
    append('child-call', 'child', 'assistant', { type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'OTHER_PARENT' } });
    append('result', null, 'user', { type: 'tool_result', tool_use_id: 'tool', content: 'x'.repeat(10_000) + 'RESULT_END' });
    const page = claudeChatMessages(f.key, f.store.pageBlocks(f.key)!.messages);
    assert.equal(JSON.stringify(page).includes('PRIVATE_PATH'), false);
    assert.equal(JSON.stringify(page).includes('RESULT_END'), false);
    assert.ok(page.every(row => row.toolDetailAvailable));
    const anchor = { nativeMessageId: 'result', parentToolUseId: null, blockIndex: 0 };
    const detail = f.store.toolDetail(f.key, anchor)!;
    assert.match(detail.text, /PRIVATE_PATH/); assert.match(detail.text, /RESULT_END/);
    assert.equal(detail.text.includes('OTHER_PARENT'), false);
    assert.equal(f.store.toolDetail(f.key, { ...anchor, parentToolUseId: 'child' }), undefined);
    f.db.close(); f = fixture(file);
    assert.deepEqual(f.store.toolDetail(f.key, anchor), detail);
  } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failed detail persistence rolls back summary and details together', () => {
  const f = fixture();
  try {
    const event = { type: 'assistant', uuid: 'call', session_id: 'native', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { path: 'file' } }] } };
    f.db.exec("CREATE TRIGGER reject_detail BEFORE INSERT ON claude_transcript_details BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.throws(() => f.store.append(f.ref, projectClaudeMessage(event, 'native'), undefined, projectClaudeToolDetails(event, 'native')));
    assert.equal(f.store.page(f.key).messages.length, 0);
    f.db.exec('DROP TRIGGER reject_detail');
    f.store.append(f.ref, projectClaudeMessage(event, 'native'));
    assert.equal(claudeChatMessages(f.key, f.store.pageBlocks(f.key)!.messages)[0]!.toolDetailAvailable, false);
    assert.throws(() => f.store.append(f.ref, projectClaudeMessage(event, 'native'), undefined, projectClaudeToolDetails(event, 'native')));
  } finally { f.db.close(); }
});

test('public history pages displayed blocks without skipping blocks within a native envelope', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) {
      const first = f.rows(`native-${i}`)[0]!;
      f.store.append(f.ref, Array.from({ length: 5 }, (_, blockIndex) => ({ ...first, blockIndex, text: `${i}:${blockIndex}` })));
    }
    let page = f.store.pageBlocks(f.key, 4)!;
    const all: string[] = [];
    for (;;) {
      const messages = claudeChatMessages(f.key, page.messages);
      assert.equal(page.totalCount, 15);
      assert.ok(messages.length <= 4);
      all.unshift(...messages.map(message => message.text));
      if (!page.hiddenCount) break;
      const anchor = claudeMessageAnchor(f.key, messages[0]!.id)!;
      assert.ok(anchor);
      page = f.store.pageBlocks(f.key, 4, anchor)!;
    }
    assert.deepEqual(all, Array.from({ length: 15 }, (_, i) => `${Math.floor(i / 5)}:${i % 5}`));
    const id = claudeChatMessages(f.key, f.store.pageBlocks(f.key)!.messages)[0]!.id;
    assert.equal(claudeMessageAnchor('claude-code:foreign', id), undefined);
    assert.equal(claudeMessageAnchor(f.key, `${id}=`), undefined);
    for (const anchor of [
      { nativeMessageId: 'missing', parentToolUseId: null, blockIndex: 0 },
      { nativeMessageId: 'native-0', parentToolUseId: 'foreign', blockIndex: 0 },
      { nativeMessageId: 'native-0', parentToolUseId: null, blockIndex: 99 },
    ]) assert.equal(f.store.pageBlocks(f.key, 4, anchor), undefined);
    assert.equal(f.store.pageBlocks(f.key, 4, claudeMessageAnchor(f.key, id))!.messages.length, 0);
  } finally { f.db.close(); }
});

test('public history UTF-8 budget is bounded and counts use the summary-count index', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 7; i++) f.store.append(f.ref, f.rows(`message-${i}`, '中'.repeat(100_000)));
    const page = f.store.pageBlocks(f.key)!;
    assert.equal(page.messages.length, 3);
    assert.equal(page.totalCount, 7);
    assert.equal(page.hiddenCount, 4);
    assert.ok(page.messages.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.rows)), 0) < CLAUDE_TRANSCRIPT_PAGE_BYTES);
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT sum(json_array_length(data)) FROM claude_transcript_messages
      INDEXED BY claude_transcript_block_counts WHERE session_key = ? AND sequence < ?`).all(f.key, 100);
    assert.match(JSON.stringify(plan), /COVERING INDEX claude_transcript_block_counts/);
    f.db.exec('UPDATE claude_transcript_messages SET created_at = -1');
    assert.throws(() => f.store.pageBlocks(f.key));
  } finally { f.db.close(); }
});

test('Claude bounded transcript survives database restart with stable message/time identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-claude-transcript-')), file = join(root, 'store.sqlite');
  let f = fixture(file);
  try {
    f.store.append(f.ref, f.rows());
    const page = f.store.page(f.key);
    f.db.close(); f = fixture(file);
    f.journal.recover(f.turns);
    assert.deepEqual(f.store.page(f.key), page);
    assert.equal(page.messages[0]?.createdAt, 1234);
    assert.equal(page.messages[0]?.rows[0]?.text, 'Hello');
    assert.equal(f.journal.current(f.key)?.phase, 'unknown', 'stored content does not prove native completion');
    assert.throws(() => f.store.append(f.ref, f.rows('late')), /could not be confirmed/);
  } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Claude transcript rejects stale worker/foreign execution and immutable-content collisions', () => {
  const f = fixture();
  try {
    const rows = f.rows();
    f.store.append(f.ref, rows); f.store.append(f.ref, rows);
    assert.equal(f.store.page(f.key).messages.length, 1);
    rows[0]!.text = 'mutated';
    assert.throws(() => f.store.append(f.ref, rows));
    assert.throws(() => f.store.append({ ...f.ref, epoch: 'stale' }, f.rows('other')));
    assert.throws(() => f.store.append({ ...f.ref, key: 'ghcp:fixture' }, f.rows('other')));
    assert.throws(() => f.store.append({ ...f.ref, id: 'other' }, f.rows('other')));
    assert.equal(f.store.page(f.key).messages[0]?.rows[0]?.text, 'Hello');
    f.journal.observeTerminal(f.ref, 'completed', f.turns); f.journal.confirmSettled(f.ref);
    assert.throws(() => f.store.append(f.ref, f.rows('after-completion')));
    f.turns.enqueue('claude-code', { id: 'second', sessionKey: f.key, createdAt: 1, payload: {} });
    const next = { ...f.ref, id: 'next' }; f.journal.begin(next, ['second'], f.turns);
    assert.throws(() => f.store.append(next, f.rows()), 'native message cannot move to a later execution');
    assert.throws(() => f.store.append(f.ref, f.rows('late')));
  } finally { f.db.close(); }
});

test('Claude transcript stores tool summaries without large parameters, binary or provider fields', () => {
  const f = fixture();
  try {
    const rows = projectClaudeMessage({ type: 'assistant', uuid: 'tools', session_id: 'native', parent_tool_use_id: null,
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tool', name: 'Read', input: { data: 'private-heavy-body'.repeat(100_000) } },
        { type: 'image', source: { data: 'binary'.repeat(100_000) } },
        { type: 'thinking', thinking: 'private-reasoning' },
      ] } }, 'native');
    f.store.append(f.ref, rows.map(row => ({ ...row, providerSecret: 'not-a-field' })));
    const page = JSON.stringify(f.store.page(f.key));
    assert.ok(page.length < 1000);
    for (const value of ['private-heavy-body', 'binary', 'private-reasoning', 'providerSecret']) assert.equal(page.includes(value), false);
    assert.equal(f.store.page(f.key).messages[0]?.rows[0]?.toolName, 'Read');
  } finally { f.db.close(); }
});

test('Claude transcript pagination obeys count and UTF-8 payload budgets without dropping identities', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 7; i++) f.store.append(f.ref, f.rows(`message-${i}`, '中'.repeat(100_000)));
    let page = f.store.page(f.key), collected: string[] = [];
    assert.equal(page.messages.length, 3, 'byte cap applies before 200-message count');
    for (;;) {
      assert.ok(page.messages.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.rows)), 0) <= CLAUDE_TRANSCRIPT_PAGE_BYTES);
      collected = [...page.messages.map(row => row.nativeMessageId), ...collected];
      if (!page.hasMore) break;
      assert.ok(page.before); page = f.store.page(f.key, 200, page.before);
    }
    assert.deepEqual(collected, Array.from({ length: 7 }, (_, i) => `message-${i}`));
    assert.equal(f.store.page(f.key, 1).messages[0]?.nativeMessageId, 'message-6');
    for (const limit of [0, 201, 1.5]) assert.throws(() => f.store.page(f.key, limit));
  } finally { f.db.close(); }
});

test('Claude transcript pagination rejects foreign and malformed cursors or rebound native history', () => {
  const f = fixture();
  try {
    f.store.append(f.ref, f.rows());
    const key = 'claude-code:other';
    f.journal.create({ key, nativeSessionId: 'other-native', title: '', createdAt: 0 });
    const cursor = f.store.page(f.key).messages[0]!.cursor;
    assert.throws(() => f.store.page(key, 200, cursor));
    assert.throws(() => f.store.page('claude-code:missing'));
    for (const cursor of ['0', '-1', '01', '2', '1 OR 1', '9007199254740992']) assert.throws(() => f.store.page(f.key, 200, cursor));
    f.db.exec("UPDATE claude_transcript_messages SET native_session_id = 'foreign'");
    assert.throws(() => f.store.page(f.key));
  } finally { f.db.close(); }
});

test('Claude transcript validates a whole message before persisting any blocks', () => {
  const f = fixture();
  try {
    const first = f.rows()[0]!;
    assert.throws(() => f.store.append(f.ref, [first, { ...first, blockIndex: 1, nativeMessageId: 'foreign' }]));
    assert.equal(f.store.page(f.key).messages.length, 0);
    assert.throws(() => f.store.append(f.ref, [{ ...first, text: 'x'.repeat(100_001) }]));
    f.store.append(f.ref, f.rows());
    assert.equal(f.store.page(f.key).messages.length, 1, 'rollback does not poison later valid writes');
  } finally { f.db.close(); }
});

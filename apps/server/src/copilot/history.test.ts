import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { describeBatch } from '../codex/queued-batch.js';
import { copilotHistoryPage, copilotHistoryMessage } from './history.js';
import { projectCopilotMessage } from './message-projection.js';
import { COPILOT_TRANSCRIPT_PAGE_BYTES } from './transcript-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CopilotSessionProjection } from './session-projection.js';

function fixture() {
  const source = new ConnectorUserStore(':memory:', () => true);
  const key = 'ghcp:history', ref = { key, id: 'execution', epoch: 'epoch' };
  source.copilotJournal.create({ key, nativeSessionId: 'native', title: 'History', createdAt: 1 });
  const enqueue = (id: string, text = id, at = 2) => source.turns.enqueue('ghcp', {
    id, sessionKey: key, createdAt: at, payload: { text, images: [], actorId: 'owner' },
  });
  const append = (id: string, text: string, role: 'user' | 'assistant' = 'assistant') =>
    source.copilotTranscript.append(ref, projectCopilotMessage({ id: `event-${id}`, type: `${role}.message`,
      timestamp: new Date(5000).toISOString(), data: { messageId: id, content: text } })!, role === 'user' ? text : undefined);
  return { source, key, ref, enqueue, append, page: (limit = 200, before?: string) => copilotHistoryPage(source, key, limit, before)! };
}

test('deleted Copilot history and lazy tool reads are unavailable while audit rows remain', () => {
  const f = fixture();
  try {
    f.enqueue('input'); f.source.copilotJournal.begin(f.ref, ['input'], f.source.turns);
    f.append('reply', 'Retained audit');
    f.source.copilotJournal.observeTerminal(f.ref, 'completed', f.source.turns);
    f.source.copilotJournal.confirmSettled(f.ref);
    const reply = f.page().messages.find(row => row.text === 'Retained audit')!;
    assert.ok(reply);
    f.source.copilotJournal.settleDeletion(f.source.copilotJournal.beginDeletion(f.key, 'delete'), true);
    assert.equal(copilotHistoryPage(f.source, f.key), undefined);
    assert.equal(copilotHistoryMessage(f.source, f.key, reply.id), undefined);
    assert.equal(f.source.copilotTranscript.page(f.key, 200)?.messages.length, 1);
  } finally { f.source.close(); }
});

test('queue identity survives native echo, lost ACK and restart recovery without duplicate or false sent state', () => {
  const f = fixture();
  try {
    f.enqueue('input');
    assert.equal(f.page().messages[0]?.queueDisposition, 'preparing');
    f.source.copilotJournal.begin(f.ref, ['input'], f.source.turns);
    f.append(f.ref.id, 'input', 'user');
    assert.deepEqual(f.page().messages.map(m => [m.id, m.status]), [['input', 'sending']]);
    assert.equal(f.page().totalCount, 1);
    f.source.copilotJournal.recover(f.source.turns);
    assert.deepEqual(f.page().messages.map(m => [m.id, m.status]), [['input', 'outcome_unknown']]);
    assert.equal(copilotHistoryMessage(f.source, f.key, 'input')?.status, 'outcome_unknown');
    assert.equal(f.source.copilotJournal.canStart(f.key), false);
  } finally { f.source.close(); }
});

test('batched native echo preserves FIFO member IDs, removes separators and pages within the batch', () => {
  const f = fixture();
  try {
    f.enqueue('a', 'First'); f.enqueue('b', 'Second');
    const entries = f.source.turns.list<{ text: string; images: unknown[]; actorId: string }>('ghcp', f.key);
    const batch = describeBatch(entries)!;
    f.source.copilotJournal.begin(f.ref, ['a', 'b'], f.source.turns, batch);
    f.append(f.ref.id, `First${batch.separator}Second`, 'user');
    f.source.copilotJournal.acknowledge(f.ref, 'request', f.source.turns);
    f.append('reply', 'Response');
    assert.deepEqual(f.page().messages.map(m => [m.id === 'a' || m.id === 'b' ? m.id : 'reply', m.text]),
      [['a', 'First'], ['b', 'Second'], ['reply', 'Response']]);
    assert.equal(f.page().messages[0]?.status, 'sent');
    assert.deepEqual(f.page(1, 'b').messages.map(m => m.id), ['a']);
    assert.equal(f.page(1, 'a').messages.length, 0);
    assert.equal(copilotHistoryMessage(f.source, f.key, 'b')?.text, 'Second');
    assert.equal(copilotHistoryMessage(f.source, f.key, 'missing'), undefined);
  } finally { f.source.close(); }
});

test('bounded history pages from pending rows into native rows, with stable totals and strict anchors', () => {
  const f = fixture();
  try {
    f.enqueue('input'); f.source.copilotJournal.begin(f.ref, ['input'], f.source.turns);
    f.append(f.ref.id, 'input', 'user'); f.source.copilotJournal.acknowledge(f.ref, 'request', f.source.turns);
    for (let i = 0; i < 205; i++) f.append(`reply-${i}`, `Reply ${i}`);
    f.enqueue('pending-a'); f.enqueue('pending-b'); f.enqueue('pending-c');
    let page = f.page(2);
    assert.deepEqual(page.messages.map(m => m.id), ['pending-b', 'pending-c']);
    assert.equal(page.totalCount, 209); assert.equal(page.hiddenCount, 207);
    page = f.page(2, page.messages[0]!.id);
    assert.deepEqual(page.messages.map(m => m.text), ['Reply 204', 'pending-a']);
    assert.equal(page.hiddenCount, 205);
    page = f.page(2, page.messages[0]!.id);
    assert.deepEqual(page.messages.map(m => m.text), ['Reply 202', 'Reply 203']);
    assert.equal(page.totalCount, 209); assert.equal(page.hiddenCount, 203);
    assert.equal(copilotHistoryMessage(f.source, f.key, 'input')?.text, 'input', 'old detail is independent of latest cache');
    assert.equal(f.page(2, 'missing'), undefined);
    for (const limit of [0, 201, 1.5, NaN]) assert.throws(() => f.page(limit));
  } finally { f.source.close(); }
});

test('combined native and queued UTF-8 wire rows stay below page budget without losing older rows', () => {
  const f = fixture();
  try {
    f.enqueue('input'); f.source.copilotJournal.begin(f.ref, ['input'], f.source.turns);
    f.append(f.ref.id, 'input', 'user'); f.source.copilotJournal.acknowledge(f.ref, 'request', f.source.turns);
    for (let i = 0; i < 8; i++) f.append(`native-${i}`, '字'.repeat(99_999));
    for (let i = 0; i < 8; i++) f.enqueue(`pending-${i}`, '文'.repeat(99_999));
    let page = f.page(); const ids: string[] = [];
    for (;;) {
      assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= COPILOT_TRANSCRIPT_PAGE_BYTES);
      ids.unshift(...page.messages.map(m => m.id));
      assert.equal(page.totalCount, 17);
      if (!page.hiddenCount) break;
      page = f.page(200, page.messages[0]!.id);
    }
    assert.equal(ids.length, 17); assert.equal(new Set(ids).size, 17);
  } finally { f.source.close(); }
});

test('authoritative SDK projection keeps pending at bottom and removes cancelled rows from cache and SSE', () => {
  const f = fixture(), target = new DeckStore(), projection = new CopilotSessionProjection(f.source, target);
  try {
    f.enqueue('input'); f.source.copilotJournal.begin(f.ref, ['input'], f.source.turns);
    f.append(f.ref.id, 'input', 'user'); f.source.copilotJournal.acknowledge(f.ref, 'request', f.source.turns);
    f.append('reply', 'Reply'); f.enqueue('pending');
    projection.publish(f.key, true);
    assert.equal(target.getMessages(f.key).at(-1)?.id, 'pending');
    const version = f.source.turns.commandState('ghcp', f.key, 'pending', 'owner');
    assert.equal(version.presence, 'present');
    if (version.presence !== 'present') throw new Error('Missing queue fixture');
    f.source.turns.cancel('ghcp', f.key, 'pending');
    projection.publish(f.key, true);
    assert.equal(target.getMessages(f.key).some(m => m.id === 'pending'), false);
    assert.equal(f.page(200, 'pending'), undefined);
  } finally { f.source.close(); }
});

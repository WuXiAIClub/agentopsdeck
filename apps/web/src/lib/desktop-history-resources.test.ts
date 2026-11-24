import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '@agentopsdeck/shared';
import { createMessageItemProjector, type MessageItem } from './incremental-message-items.js';
import { createMessageSearch } from './message-search.js';
import { createIdleToolDetailCache } from './idle-tool-detail-cache.js';
import { shareMessageRows } from './message-sharing.js';
import { mergeMessages } from './optimistic-messages.js';

type Row = { id: number; kind: 'hidden' | 'tool' | 'chat'; text: string };
const row = (id: number, kind: Row['kind'] = 'chat'): Row => ({ id, kind, text: `row ${id}` });
function reference(messages: Row[]) {
  const items: MessageItem<Row>[] = [];
  let tools: Row[] = [], start = -1;
  messages.forEach((message, index) => {
    if (message.kind === 'hidden') return;
    if (message.kind === 'tool') { if (!tools.length) start = index; tools.push(message); return; }
    items.push({ kind: 'message', message, index, ...(tools.length ? { attachedTools: tools } : {}) });
    tools = []; start = -1;
  });
  if (tools.length) items.push({ kind: 'toolGroup', messages: tools, startIndex: start, endIndex: messages.length - 1 });
  return items;
}

test('incremental grouping retains old tool array identities and classifies only changed objects', () => {
  for (const length of [200, 2000]) {
    let visits = 0;
    const project = createMessageItemProjector<Row>(message => { visits++; return message.kind; });
    let messages = Array.from({ length }, (_, i) => [row(i * 2, 'tool'), row(i * 2 + 1)]).flat();
    const first = project(messages);
    visits = 0;
    for (let update = 0; update < 40; update++) {
      messages = [...messages.slice(0, -1), { ...messages.at(-1)!, text: `update ${update}` }];
      const next = project(messages);
      assert.equal(next[0], first[0]);
      assert.deepEqual(next, reference(messages));
    }
    assert.equal(visits, 40);
    console.log(JSON.stringify({ incrementalGrouping: { chats: length, updates: 40, classifications: visits } }));
  }
});

test('grouping matches reference across arbitrary prepends, edits, deletions, reorders and hidden/tool transitions', () => {
  const project = createMessageItemProjector<Row>(message => message.kind);
  let messages: Row[] = [];
  let seed = 42;
  const random = (n: number) => { seed = (1664525 * seed + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 1500; i++) {
    const index = random(messages.length + 1), kind = (['chat', 'tool', 'hidden'] as const)[random(3)]!;
    switch (random(5)) {
      case 0: messages = [...messages, row(i, kind)]; break;
      case 1: messages = [row(i, kind), ...messages]; break;
      case 2: messages = messages.filter((_, n) => n !== index); break;
      case 3: messages = messages.map((message, n) => n === index ? { ...message, kind } : message); break;
      case 4: messages = [...messages].reverse(); break;
    }
    const next = project(messages);
    assert.deepEqual(next, reference(messages));
    assert.equal(project([...messages]), next, 'equivalent input array reuses output');
  }
  assert.deepEqual(project([]), []);
});

test('a trailing tool group attaches on append and preserves earlier chat groups', () => {
  const project = createMessageItemProjector<Row>(message => message.kind);
  const messages = [row(0), row(1, 'hidden'), row(2, 'tool'), row(3, 'hidden')];
  const first = project(messages), next = project([...messages, row(4)]);
  assert.equal(first[0], next[0]);
  assert.deepEqual(next, reference([...messages, row(4)]));
  assert.equal(next[1]?.kind, 'message');
});

test('search reuses text and matches, updates old rows, and releases closed/deleted history', () => {
  let reads = 0;
  const search = createMessageSearch<Row>(message => { reads++; return message.text.toLowerCase(); });
  let messages = Array.from({ length: 2000 }, (_, i) => row(i));
  assert.deepEqual(search.search(messages, ' ROW 19 '), messages.filter(message => message.text.includes('row 19')));
  assert.equal(reads, 2000);
  for (let n = 0; n < 40; n++) {
    messages = [...messages.slice(0, -1), { ...messages.at(-1)!, text: `update ${n}` }];
    search.search(messages, 'row 19');
  }
  assert.equal(reads, 2040);
  search.search(messages, 'row 18');
  assert.equal(reads, 2040, 'a new query reuses cached normalized text');
  messages = messages.slice(-20);
  search.search(messages, 'update');
  assert.equal(search.stats().entries, 20);
  assert.deepEqual(search.search(messages, ''), []);
  assert.deepEqual(search.stats(), { entries: 0, bytes: 0 });
});

test('search respects byte/count budgets and weakly memoizes oversized text for the current query', () => {
  let reads = 0;
  const search = createMessageSearch<Row>(message => { reads++; return message.text; }, 20, 2);
  const messages = [row(1), row(2), row(3), { ...row(4), text: 'x'.repeat(1000) }];
  search.search(messages, 'x');
  assert.ok(search.stats().bytes <= 20 && search.stats().entries <= 2);
  assert.equal(search.search(messages, 'x').length, 1);
  assert.equal(reads, 4);
});

test('idle details bound bytes/entries, preserve empty results, and transfer ownership out of cache', () => {
  const cache = createIdleToolDetailCache(20, 2);
  cache.put('a', '123'); cache.put('b', '456');
  cache.put('c', '789');
  assert.equal(cache.take('a'), undefined);
  assert.equal(cache.take('b'), '456');
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 8 });
  cache.put('c', '');
  assert.equal(cache.take('c'), '');
  cache.put('big', 'x'.repeat(20));
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
  cache.put('a', 'x'); cache.clear();
  assert.equal(cache.take('a'), undefined);
});

const message = (id: string): ChatMessage => ({ sessionKey: 'one', id, role: 'assistant', text: id, createdAt: 1 });
test('message sharing compares every field without resurrecting removed fields, queue state or media', () => {
  const previous: ChatMessage[] = [{ ...message('1'), status: 'queued', queueVersion: 'opaque', media: [{ type: 'file', name: 'one', url: '/one' }] }, message('2')];
  assert.equal(shareMessageRows(previous, structuredClone(previous)), previous);
  for (const patch of [ { text: 'new' }, { queueVersion: 'new' }, { status: 'sent' }, { media: [] }, { futureProtocol: { permission: false } } ]) {
    const incoming = [{ ...previous[0]!, ...patch } as ChatMessage, { ...previous[1]! }];
    const next = shareMessageRows(previous, incoming);
    assert.equal(next[0], incoming[0]); assert.equal(next[1], previous[1]);
    assert.deepEqual(next, incoming);
  }
  const removed = [{ ...message('1') }];
  assert.equal(shareMessageRows(previous, removed)[0], removed[0]);
  const otherSession = [{ ...previous[0]!, sessionKey: 'two' }];
  assert.equal(shareMessageRows(previous, otherSession)[0], otherSession[0]);
  const duplicates = [structuredClone(previous[0]!), structuredClone(previous[0]!)];
  assert.equal(shareMessageRows(previous, duplicates)[0], duplicates[0]);
});

test('merge fast path preserves stable sorted input but still repairs unsorted timestamps and queue order', () => {
  const early = { ...message('early'), createdAt: 0 }, late = { ...message('late'), createdAt: 2 };
  const pending = { ...message('pending'), role: 'user' as const, status: 'queued' as const, createdAt: -1 };
  const sorted = [early, late, pending];
  assert.equal(mergeMessages(sorted, []), sorted);
  const unsorted = [pending, late, early];
  assert.deepEqual(mergeMessages(unsorted, []), sorted);
  assert.deepEqual(unsorted, [pending, late, early], 'input never mutated');
});

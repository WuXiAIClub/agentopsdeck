import assert from 'node:assert/strict';
import test from 'node:test';
import { describeBatch, expandBatchMessage, waitingBatch } from './queued-batch.js';
import type { QueuedTurn } from '../commands/turn-queue.js';
import type { ExecutionGrantAuthority } from '../connector/execution-grants.js';

type Payload = { text: string; images: unknown[]; actorId?: string; executionGrant?: ExecutionGrantAuthority };
const entry = (id: string, text = id): QueuedTurn<Payload> => ({ id, sessionKey: 'codex:test', state: 'queued', createdAt: Number(id) || 1,
  payload: { text, images: [], actorId: 'alice', executionGrant: { id: 'grant', actorId: 'alice', issuerTokenId: 'issuer' } } });

test('batch selects the waiting FIFO prefix without mixing authority or bypassing a blocker', () => {
  const rows = [entry('1'), entry('2'), entry('3')];
  assert.equal(waitingBatch(rows, () => true).length, 3);
  for (const field of ['id', 'actorId', 'issuerTokenId'] as const) {
    const changed = structuredClone(rows); changed[1]!.payload.executionGrant![field] = 'other';
    assert.deepEqual(waitingBatch(changed, () => true).map(row => row.id), ['1']);
  }
  rows[1]!.payload.actorId = 'bob';
  assert.deepEqual(waitingBatch(rows, () => true).map(row => row.id), ['1']);
  rows[1]!.payload.actorId = 'alice';
  for (const state of ['blocked', 'dispatching', 'outcome_unknown'] as const) {
    rows[1]!.state = state;
    assert.deepEqual(waitingBatch(rows, () => true).map(row => row.id), ['1']);
  }
  rows[1]!.state = 'queued';
  assert.deepEqual(waitingBatch(rows, row => row.id !== '2').map(row => row.id), ['1']);
  assert.deepEqual(waitingBatch(rows, () => false), []);
});

test('batch bounds aggregate payload and identities without dropping the remaining queue', () => {
  assert.equal(waitingBatch(Array.from({ length: 20 }, (_, i) => entry(String(i))), () => true).length, 16);
  assert.equal(waitingBatch([entry('1', 'x'.repeat(700_000)), entry('2', 'y'.repeat(700_000))], () => true).length, 1);
});

test('ACK metadata reconstructs original message identity, text, order and attachment ownership', () => {
  const rows = [entry('1', 'same\ntext'), entry('2', 'same\ntext'), entry('3', '')];
  rows[1]!.payload.images = ['image']; rows[2]!.payload.images = ['second-image'];
  const batch = describeBatch(rows)!;
  const media = [{ type: 'image' as const, url: '/first', name: 'first.png' }, { type: 'image' as const, url: '/second', name: 'second.png' }];
  const message = { id: 'native', sessionKey: 'codex:test', turnId: 'turn', role: 'user' as const,
    text: rows.map(row => row.payload.text).join(batch.separator), status: 'sent' as const, createdAt: 100, media };
  const expanded = expandBatchMessage(message, batch);
  assert.deepEqual(expanded.map(row => [row.id, row.text, row.createdAt, row.turnId]), rows.map(row => [row.id, row.payload.text, message.createdAt, 'turn']));
  assert.deepEqual(batch.members.map(member => member.createdAt), rows.map(row => row.createdAt), 'admission audit metadata stays unchanged');
  assert.equal(expanded[0]!.media, undefined);
  assert.deepEqual(expanded[1]!.media, [media[0]]); assert.deepEqual(expanded[2]!.media, [media[1]]);
  assert.throws(() => expandBatchMessage({ ...message, text: 'incomplete' }, batch), /boundaries/);
  assert.throws(() => expandBatchMessage({ ...message, media: media.slice(1) }, batch), /attachment boundaries/);
  assert.equal(describeBatch(rows.slice(0, 1)), undefined);
  assert.ok(!JSON.stringify(batch).includes('same\\ntext'), 'metadata contains no message body');
});

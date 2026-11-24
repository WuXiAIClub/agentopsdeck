import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BoardContent, WorkspaceFileCard } from '@agentopsdeck/shared';
import { WorkspaceFileMetadata, FileBoardError } from './workspace-file-metadata.js';
import { boardFileCodec } from './workspace-board-file-format.js';
import { cardFileCodec } from './workspace-file-card-format.js';

const owner = 'connector-token', sessionKey = 'codex:metadata-test';
const intent = () => ({ id: randomUUID(), sessionKey, content: { title: 'Tasks', tasks: [] } satisfies BoardContent });
const denied = (status: number) => (error: unknown) => error instanceof FileBoardError && error.status === status;
function fixture() {
  const db = new DatabaseSync(':memory:'); let allowed = true;
  const authorized = () => allowed;
  const metadata = new WorkspaceFileMetadata(db, authorized, boardFileCodec);
  return { db, metadata, authorized, deny: () => { allowed = false; }, allow: () => { allowed = true; }, close: () => db.close() };
}
function installed(metadata: WorkspaceFileMetadata<BoardContent>) {
  const input = intent(), result = metadata.installation(owner, input, true);
  assert.equal(result.existing, false);
  if (result.existing) throw Error('Unexpected duplicate');
  metadata.installed(owner, input.id, result.fingerprint);
  return input;
}
const write = () => ({ mutationId: randomUUID(), expectedHash: 'a'.repeat(64), content: { title: 'Updated', tasks: [] } satisfies BoardContent });

test('inspection has no effects; final installation admission observes another original owner', () => {
  const f = fixture();
  try {
    const input = intent(), other = new WorkspaceFileMetadata(f.db, f.authorized, boardFileCodec);
    assert.equal(f.metadata.installation(owner, input).existing, false);
    assert.throws(() => f.metadata.owned(owner, input.id), denied(404));
    assert.equal(other.installation(owner, input, true).existing, false);
    const duplicate = f.metadata.installation(owner, input, true);
    assert.equal(duplicate.existing, true);
    if (duplicate.existing) assert.equal(duplicate.row.state, 'prepared');
    assert.throws(() => other.installation(owner, { ...input, content: { title: 'Different', tasks: [] } }, true), denied(409));
  } finally { f.close(); }
});
test('original tables reopen prepared and uncertain receipts without re-admission', () => {
  const f = fixture();
  try {
    const prepared = intent(); f.metadata.installation(owner, prepared, true);
    const input = installed(f.metadata), mutation = write();
    assert.equal(f.metadata.writeIntent(owner, input.id, mutation, 0).existing, false);
    f.metadata.close();
    const reopened = new WorkspaceFileMetadata(f.db, f.authorized, boardFileCodec);
    assert.equal(reopened.installation(owner, prepared, true).existing, true);
    assert.deepEqual(reopened.writeIntent(owner, input.id, mutation, 0), { existing: true, receipt: { mutationId: mutation.mutationId, state: 'uncertain' } });
  } finally { f.close(); }
});
test('final write admission rechecks current authority and exact mutation after intervening I/O', () => {
  const f = fixture();
  try {
    const input = installed(f.metadata), mutation = write();
    assert.equal(f.metadata.writeIntent(owner, input.id, mutation).existing, false);
    f.deny(); assert.throws(() => f.metadata.writeIntent(owner, input.id, mutation, 0), denied(403));
    f.allow(); const other = new WorkspaceFileMetadata(f.db, f.authorized, boardFileCodec);
    other.writeIntent(owner, input.id, mutation, 0);
    assert.equal(f.metadata.writeIntent(owner, input.id, mutation, 0).existing, true);
    assert.throws(() => f.metadata.writeIntent(owner, input.id, { ...mutation, expectedHash: 'b'.repeat(64) }, 0), denied(409));
  } finally { f.close(); }
});
test('write result is bound to original fingerprint and terminal receipts cannot be changed', () => {
  const f = fixture();
  try {
    const input = installed(f.metadata), mutation = write(), result = f.metadata.writeIntent(owner, input.id, mutation, 0);
    if (result.existing) throw Error('Unexpected duplicate');
    assert.throws(() => f.metadata.settleWrite(owner, input.id, mutation.mutationId, 'wrong', 'saved'), denied(409));
    assert.throws(() => f.metadata.settleWrite('other', input.id, mutation.mutationId, result.fingerprint, 'saved'), denied(409));
    f.metadata.settleWrite(owner, input.id, mutation.mutationId, result.fingerprint, 'saved');
    f.metadata.settleWrite(owner, input.id, mutation.mutationId, result.fingerprint, 'saved');
    assert.throws(() => f.metadata.settleWrite(owner, input.id, mutation.mutationId, result.fingerprint, 'conflict'), denied(409));
    assert.equal(f.metadata.receipt(owner, input.id, mutation.mutationId).state, 'saved');
  } finally { f.close(); }
});
test('revocation does not need lost execution permission and cannot be undone by late completion', () => {
  const f = fixture();
  try {
    const input = intent(), reservation = f.metadata.installation(owner, input, true);
    if (reservation.existing) throw Error('Unexpected duplicate');
    f.deny(); assert.equal(f.metadata.revoke(owner, input.id).state, 'revoked');
    f.allow(); assert.throws(() => f.metadata.installed(owner, input.id, reservation.fingerprint), denied(409));
    const late = f.metadata.installation(owner, input, true);
    assert.equal(late.existing, true); assert.equal(f.metadata.owned(owner, input.id).state, 'revoked');
  } finally { f.close(); }
});
test('cancellation before installation persists original owner/session tombstone', () => {
  const f = fixture();
  try {
    const input = intent(); f.metadata.revoke(owner, input.id, sessionKey);
    assert.equal(f.metadata.installation(owner, input, true).existing, true);
    assert.throws(() => f.metadata.installation('other', input, true), denied(409));
    assert.throws(() => f.metadata.revoke(owner, input.id, 'codex:other'), denied(404));
  } finally { f.close(); }
});
test('reconcile is durable and restored permission never revives a binding', () => {
  const f = fixture();
  try {
    const input = installed(f.metadata); f.deny();
    assert.deepEqual(f.metadata.reconcile(), [input.id]);
    f.allow(); assert.deepEqual(f.metadata.reconcile(), []);
    assert.deepEqual(f.metadata.filesForSession(owner, sessionKey), []);
    assert.equal(f.metadata.owned(owner, input.id).state, 'revoked');
  } finally { f.close(); }
});
test('board and card final reservations share the original active quota', () => {
  const f = fixture();
  try {
    const cards = new WorkspaceFileMetadata(f.db, f.authorized, cardFileCodec());
    const card = { id: randomUUID(), sessionKey, content: { kind: 'notebook', content: { title: 'Note', text: '' } } satisfies WorkspaceFileCard };
    assert.equal(cards.installation(owner, card).existing, false);
    for (let n = 0; n < 64; n++) f.metadata.installation(owner, intent(), true);
    assert.throws(() => cards.installation(owner, card, true), denied(429));
    assert.throws(() => cards.owned(owner, card.id), denied(404));
  } finally { f.close(); }
});
test('card kind is stored with preparation and enforced on future write intents', () => {
  const f = fixture();
  try {
    const cards = new WorkspaceFileMetadata(f.db, f.authorized, cardFileCodec());
    const input = { id: randomUUID(), sessionKey, content: { kind: 'notebook', content: { title: 'Note', text: '' } } satisfies WorkspaceFileCard };
    const reserved = cards.installation(owner, input, true); if (reserved.existing) throw Error('Unexpected duplicate');
    cards.installed(owner, input.id, reserved.fingerprint);
    assert.throws(() => cards.writeIntent(owner, input.id, { ...write(), content: { kind: 'report', content: { title: 'Report', text: '' } } }, 0), denied(409));
    assert.equal(cards.writeIntent(owner, input.id, { ...write(), content: input.content }, 0).existing, false);
  } finally { f.close(); }
});
test('kind preparation failure rolls back binding and does not leave a phantom intent', () => {
  const f = fixture();
  try {
    const cards = new WorkspaceFileMetadata(f.db, f.authorized, { ...boardFileCodec, bindingType: () => { throw Error('kind failure'); } });
    const input = intent(); assert.throws(() => cards.installation(owner, input, true), /kind failure/);
    assert.throws(() => cards.owned(owner, input.id), denied(404));
  } finally { f.close(); }
});
test('invalid retention and over-budget writes never create receipts', () => {
  const f = fixture();
  try {
    const input = installed(f.metadata), mutation = write();
    for (const retained of [-1, NaN, Infinity, 0.5, 64 * 1024 * 1024]) {
      assert.throws(() => f.metadata.writeIntent(owner, input.id, mutation, retained), denied(429));
      assert.throws(() => f.metadata.receipt(owner, input.id, mutation.mutationId), denied(404));
    }
  } finally { f.close(); }
});
test('close freezes new work but permits exact already-admitted result settlement', () => {
  const f = fixture();
  try {
    const input = installed(f.metadata), mutation = write(), result = f.metadata.writeIntent(owner, input.id, mutation, 0);
    if (result.existing) throw Error('Unexpected duplicate');
    f.metadata.close();
    assert.throws(() => f.metadata.installation(owner, intent(), true), denied(403));
    assert.throws(() => f.metadata.writeIntent(owner, input.id, write(), 0), denied(503));
    assert.throws(() => f.metadata.revoke(owner, input.id), denied(503));
    f.metadata.settleWrite(owner, input.id, mutation.mutationId, result.fingerprint, 'saved');
    const reopened = new WorkspaceFileMetadata(f.db, f.authorized, boardFileCodec);
    assert.equal(reopened.receipt(owner, input.id, mutation.mutationId).state, 'saved');
  } finally { f.close(); }
});

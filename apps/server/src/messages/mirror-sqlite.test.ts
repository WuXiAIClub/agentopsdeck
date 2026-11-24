import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { MirrorOutbox, type MirrorParams } from './mirror.js';
import { OpenClawExecutions } from '../openclaw/executions.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-sqlite-'));
  const db = new DatabaseSync(join(dir, 'connector.sqlite'));
  const outbox = new MirrorOutbox(db);
  const params: MirrorParams = { actorId: 'original-actor', sessionKey: 'synthetic', after: 1, inputText: 'original input', idempotencyKey: 'one',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' } };
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, outbox, params };
}

test('mirror SQLite admission belongs to the exact original transaction', t => {
  const { db, outbox, params } = fixture(t);
  assert.throws(() => outbox.admitInTransaction(db, params), /transaction/i);
  db.exec('BEGIN IMMEDIATE');
  outbox.admitInTransaction(db, params);
  assert.equal(outbox.list().length, 1);
  db.exec('ROLLBACK');
  assert.deepEqual(outbox.list(), []);
  db.exec('BEGIN IMMEDIATE'); outbox.admitInTransaction(db, params); db.exec('COMMIT');
  assert.equal(new MirrorOutbox(db).list()[0]?.actorId, 'original-actor');
});

test('mirror native evidence is transaction-bound, immutable, capacity-bound and cannot be injected through admission or legacy import', context => {
  const { db, dir, outbox, params } = fixture(context);
  outbox.upsert(params);
  const reply = { source: 'cli' as const, commandId: 'one', text: 'original final' };
  assert.throws(() => outbox.recordCliReplyInTransaction(db, params, reply.text), /transaction/);
  const foreign = new DatabaseSync(':memory:');
  try {
    foreign.exec('BEGIN IMMEDIATE');
    assert.throws(() => outbox.recordCliReplyInTransaction(foreign, params, reply.text), /transaction/);
  } finally { foreign.close(); }
  db.exec('BEGIN IMMEDIATE');
  outbox.recordCliReplyInTransaction(db, params, reply.text);
  db.exec('ROLLBACK');
  assert.equal(outbox.get('one')?.nativeReply, undefined);
  db.exec('BEGIN IMMEDIATE');
  assert.throws(() => outbox.recordCliReplyInTransaction(db, { ...params, actorId: 'other' }, reply.text), /conflict/);
  assert.throws(() => outbox.recordCliReplyInTransaction(db, params, 'x'.repeat(1024 * 1024 + 1)), /Invalid/);
  outbox.recordCliReplyInTransaction(db, params, reply.text);
  outbox.recordCliReplyInTransaction(db, params, reply.text);
  assert.throws(() => outbox.recordCliReplyInTransaction(db, params, 'different final'), /conflict/);
  assert.throws(() => outbox.editInputInTransaction(db, 'synthetic', 'one', 'changed input'), /conflict/);
  assert.throws(() => outbox.cancelInTransaction(db, 'synthetic', 'one'), /cannot be removed/);
  db.exec('COMMIT');
  assert.deepEqual(outbox.get('one')?.nativeReply, reply);
  const reopenedDb = new DatabaseSync(join(dir, 'connector.sqlite'));
  try { assert.deepEqual(new MirrorOutbox(reopenedDb).get('one')?.nativeReply, reply); } finally { reopenedDb.close(); }
  const job = outbox.get('one'); assert.ok(job);
  assert.throws(() => outbox.saveJob({ ...job, nativeReply: { ...reply, text: 'forged' } }), /conflict/);
  const { nativeReply: _reply, ...withoutReply } = job;
  assert.throws(() => outbox.saveJob(withoutReply), /conflict/);
  assert.throws(() => outbox.upsert({ ...params, ...{ nativeReply: reply } }), /separate native evidence/);
  const legacyFile = join(dir, 'legacy.json');
  const { actorId: _actor, ...legacy } = job;
  writeFileSync(legacyFile, JSON.stringify({ jobs: [legacy] }));
  assert.throws(() => outbox.importLegacy(legacyFile), /provenance/);
});

test('mirror SQLite binds actor, original grant and route on duplicates', t => {
  const { outbox, params } = fixture(t);
  const original = { ...params, executionGrant: { id: 'original-grant', actorId: params.actorId!, issuerTokenId: 'original-issuer' } };
  const job = outbox.upsert(original);
  assert.throws(() => outbox.upsert(params), /conflict/i);
  const { executionGrant: _grant, ...withoutGrant } = job;
  assert.throws(() => outbox.saveJob(withoutGrant), /conflict/i);
  for (const change of [{ actorId: 'other', executionGrant: { ...original.executionGrant, actorId: 'other' } }, { executionGrant: { ...original.executionGrant, issuerTokenId: 'other' } },
    { explicitRoute: { ...params.explicitRoute, outboundTarget: 'other' } }]) {
    assert.throws(() => outbox.upsert({ ...original, ...change }), /conflict/i);
    assert.throws(() => outbox.saveJob({ ...job, ...change }), /conflict/i);
  }
  assert.deepEqual(outbox.list(), [job]);
});

test('mirror SQLite stale owner cannot select an already selected send', t => {
  const { db, outbox, params } = fixture(t);
  const stale = outbox.upsert(params), other = new MirrorOutbox(db);
  const selected = { ...stale, deliveryState: 'outcome_unknown' as const, selectedMessageId: 'message', outputSha256: 'a'.repeat(64), attemptedAt: 10 };
  other.saveJob(selected);
  assert.throws(() => outbox.saveJob(selected), /conflict/i);
  assert.equal(outbox.list()[0]?.deliveryState, 'outcome_unknown');
});

test('mirror SQLite imports legacy evidence once without rewriting or enabling it', t => {
  const { dir, db, outbox, params } = fixture(t), file = join(dir, 'legacy.json');
  const { actorId: _actor, ...legacy } = params;
  const bytes = JSON.stringify({ jobs: [{ ...legacy, createdAt: 1, attempts: 0, deliveryState: 'pending' }] });
  writeFileSync(file, bytes);
  outbox.importLegacy(file);
  const imported = outbox.list()[0];
  assert.ok(imported);
  assert.equal(imported.legacy, true);
  assert.equal(imported.actorId, undefined);
  new MirrorOutbox(db).importLegacy(file);
  assert.equal(outbox.list().length, 1);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.throws(() => outbox.saveJob(imported), /conflict/i);
});

test('mirror SQLite capacity failure rolls back intent and preserves legacy source', t => {
  const { dir, db, params } = fixture(t), file = join(dir, 'legacy.json');
  const outbox = new MirrorOutbox(db, 1);
  outbox.upsert(params);
  assert.throws(() => outbox.upsert({ ...params, idempotencyKey: 'two' }), /capacity/i);
  const { actorId: _actor, ...legacy } = params;
  const bytes = JSON.stringify({ jobs: [{ ...legacy, idempotencyKey: 'legacy', createdAt: 1, attempts: 0 }] });
  writeFileSync(file, bytes);
  assert.throws(() => outbox.importLegacy(file));
  assert.equal(outbox.list().length, 1);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('native reply capacity rejection rolls back execution completion and outbox usage together', context => {
  const { db, params } = fixture(context);
  const outbox = new MirrorOutbox(db, 2, 1024), executions = new OpenClawExecutions(db);
  outbox.upsert(params);
  executions.begin(params.sessionKey, params.idempotencyKey);
  executions.useCli(params.sessionKey, params.idempotencyKey);
  const original = executions.get(params.sessionKey);
  const usage = () => db.prepare('SELECT rows, bytes FROM connector_mirror_usage').get();
  const before = usage();
  assert.throws(() => executions.finishCli(params.sessionKey, params.idempotencyKey, 'completed', transaction => {
    outbox.recordCliReplyInTransaction(transaction, params, 'reply'.repeat(400));
  }), /capacity/);
  assert.deepEqual(executions.get(params.sessionKey), original);
  assert.equal(outbox.get(params.idempotencyKey)?.nativeReply, undefined);
  assert.deepEqual(usage(), before);
  assert.equal(executions.finishCli(params.sessionKey, params.idempotencyKey, 'completed', transaction => {
    outbox.recordCliReplyInTransaction(transaction, params, 'final');
  }), true);
  assert.equal(outbox.get(params.idempotencyKey)?.nativeReply?.text, 'final');
});

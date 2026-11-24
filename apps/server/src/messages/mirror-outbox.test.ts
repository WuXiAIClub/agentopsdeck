import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { MirrorOutbox, type MirrorParams } from './mirror.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

for (const operation of ['receipt', 'reclamation'] as const) for (const nested of [false, true]) {
  test(`mirror ${operation} async participant preserves facts and fences original owner (nested=${nested})`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<void> | undefined, calls = 0, armed = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const callback = () => { if (!armed) return; calls++; return late = (async () => { await held; insert.run(); })(); };
    const outbox = new MirrorOutbox(db, 1, undefined, {
      recordMirrorInTransaction: operation === 'receipt' ? callback : () => {},
      reclaimCompletedInTransaction: operation === 'reclamation' ? callback : () => {},
    });
    const params: MirrorParams = { actorId: 'synthetic', sessionKey: 's', after: 1, inputText: 'private', idempotencyKey: 'one',
      explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' } };
    try {
      const job = outbox.upsert(params);
      const rows = raw.prepare('SELECT * FROM connector_mirror_outbox').all();
      const usage = raw.prepare('SELECT * FROM connector_mirror_usage').all(); armed = true;
      if (nested) db.exec('BEGIN');
      assert.throws(() => operation === 'receipt' ? outbox.saveJob({ ...job, attempts: 1 })
        : outbox.upsert({ ...params, idempotencyKey: 'two' }), /must be synchronous/);
      assert.equal(calls, 1);
      assert.deepEqual(raw.prepare('SELECT * FROM connector_mirror_outbox').all(), rows);
      assert.deepEqual(raw.prepare('SELECT * FROM connector_mirror_usage').all(), usage);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.throws(() => db.exec('COMMIT'), StorageConnectionUnavailable);
      const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });
}

function fixture(context: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-outbox-'));
  const databaseFile = join(dir, 'connector.sqlite'), db = new DatabaseSync(databaseFile);
  context.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = join(dir, 'outbox.json');
  const params: MirrorParams = { actorId: 'synthetic-actor', sessionKey: 'synthetic', after: 1, inputText: 'original input',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' }, idempotencyKey: 'one' };
  const { actorId: _actor, ...legacyParams } = params;
  const legacy = { ...legacyParams, createdAt: 1, attempts: 0 };
  return { dir, file, databaseFile, db, params, legacy, outbox: new MirrorOutbox(db) };
}

test('mirror outbox cleanup failure preserves conflict and original immutable job', context => {
  const { db, params, outbox } = fixture(context), job = outbox.upsert(params), exec = db.exec.bind(db);
  db.exec = sql => { if (sql === 'ROLLBACK') { exec(sql); throw Error('synthetic-cleanup'); } exec(sql); };
  assert.throws(() => outbox.upsert({ ...params, inputText: 'conflicting replacement' }), /request conflict/);
  assert.equal(db.isTransaction, false); assert.deepEqual(outbox.get(params.idempotencyKey), job);
});

for (const executed of [false, true]) test(`mirror outbox lost commit acknowledgement preserves exact receipt (${executed})`, context => {
  const { db, params, outbox } = fixture(context), exec = db.exec.bind(db), original = Error('synthetic-commit');
  let commits = 0;
  db.exec = sql => { if (sql === 'COMMIT') { commits++; if (executed) exec(sql); throw original; } exec(sql); };
  assert.throws(() => outbox.upsert(params), error => error === original);
  assert.equal(commits, 1); assert.equal(db.isTransaction, false);
  assert.equal(Boolean(outbox.get(params.idempotencyKey)), executed);
  // Query the original result, never automatically retry external delivery.
  if (executed) assert.equal(outbox.get(params.idempotencyKey)?.attempts, 0);
});

for (const malformed of ['{', '{}', '{"jobs":null}', '{"jobs":[{}]}', '{"jobs":[],"futureVersion":2}']) {
  test(`mirror import preserves unsupported or malformed evidence: ${malformed}`, context => {
    const { file, db, outbox } = fixture(context);
    fs.writeFileSync(file, malformed);
    assert.throws(() => outbox.importLegacy(file), /mirror outbox/i);
    assert.equal(fs.readFileSync(file, 'utf8'), malformed);
    assert.deepEqual(outbox.list(), []);
    assert.equal(db.prepare('SELECT count(*) AS total FROM connector_mirror_import').get()?.total, 0);
  });
}

test('mirror import distinguishes missing file from inaccessible/non-file evidence', context => {
  const { file, outbox } = fixture(context);
  outbox.importLegacy(file);
  assert.deepEqual(outbox.list(), []);
  fs.mkdirSync(file);
  assert.throws(() => outbox.importLegacy(file));
  assert.equal(fs.statSync(file).isDirectory(), true);
});

test('mirror import never replaces a dangling link with an empty queue', context => {
  const { file, outbox } = fixture(context);
  fs.symlinkSync('missing-synthetic-target', file);
  assert.throws(() => outbox.importLegacy(file), /mirror outbox/i);
  assert.equal(fs.readlinkSync(file), 'missing-synthetic-target');
});

test('mirror import never writes, renames or unlinks legacy evidence or unrelated temporary paths', context => {
  const { file, params, legacy, outbox } = fixture(context);
  const bytes = JSON.stringify({ jobs: [legacy] });
  fs.writeFileSync(file, bytes);
  const foreign = `${file}.tmp`;
  fs.writeFileSync(foreign, 'unrelated owner');
  const originalOpen = fs.openSync;
  context.mock.method(fs, 'openSync', (path: fs.PathLike, flags: number) => {
    assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    return originalOpen(path, flags);
  });
  for (const name of ['writeFileSync', 'renameSync', 'unlinkSync'] as const) {
    context.mock.method(fs, name, () => { throw new Error('Legacy evidence must remain read-only'); });
  }
  syncBuiltinESMExports();
  try {
    outbox.importLegacy(file);
    const job = outbox.upsert({ ...params, idempotencyKey: 'new' });
    outbox.saveJob({ ...job, attempts: 1 });
    outbox.remove(job.idempotencyKey);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'unrelated owner');
});

test('mirror import rejects duplicate identities, injected provenance and malformed optional progress', context => {
  const { file, legacy, outbox } = fixture(context);
  for (const jobs of [[legacy, legacy], [{ ...legacy, attempts: -1 }], [{ ...legacy, mirroredMessageIds: [null] }],
    [{ ...legacy, actorId: 'injected' }], [{ ...legacy, legacy: true }],
    [{ ...legacy, executionGrant: { id: 'injected', actorId: 'injected', issuerTokenId: 'injected' } }],
    [{ ...legacy, lastMirroredAt: '1' }], [{ ...legacy, explicitRoute: { ...legacy.explicitRoute, originatingAccountId: 7 } }]]) {
    const bytes = JSON.stringify({ jobs }); fs.writeFileSync(file, bytes);
    assert.throws(() => outbox.importLegacy(file));
    assert.deepEqual(outbox.list(), []);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

test('mirror outbox binds existing request to original session, input and complete route', context => {
  const { params, outbox } = fixture(context);
  const job = outbox.upsert(params);
  assert.deepEqual(outbox.upsert({ ...params, explicitRoute: { outboundTarget: 'original', originatingTo: 'original', originatingChannel: 'synthetic' } }), job);
  for (const change of [{ sessionKey: 'other' }, { after: 2 }, { inputText: 'different input' },
    ...['originatingChannel', 'originatingTo', 'originatingAccountId', 'outboundTarget'].map(key => ({ explicitRoute: { ...params.explicitRoute, [key]: 'other' } }))]) {
    assert.throws(() => outbox.upsert({ ...params, ...change }), /conflict/i);
    assert.throws(() => outbox.saveJob({ ...job, ...change }), /conflict/i);
    assert.deepEqual(outbox.list(), [job]);
  }
});

test('mirror outbox refuses missing-job save and isolates caller route mutations', context => {
  const { db, params, outbox } = fixture(context);
  const job = outbox.upsert(params);
  params.explicitRoute.outboundTarget = 'mutated caller';
  assert.equal(job.explicitRoute.outboundTarget, 'original');
  outbox.saveJob({ ...job, attempts: 1, lastError: 'synthetic failure' });
  assert.equal(new MirrorOutbox(db).list()[0]?.attempts, 1);
  outbox.remove(job.idempotencyKey);
  assert.throws(() => outbox.saveJob(job), /missing/i);
  assert.deepEqual(outbox.list(), []);
});

test('mirror SQLite progress rolls back completely and reopens without changing imported evidence', context => {
  const { databaseFile, db, file, params, legacy, outbox } = fixture(context);
  const bytes = JSON.stringify({ jobs: [legacy] });
  fs.writeFileSync(file, bytes, { mode: 0o640 });
  const originalMode = fs.statSync(file).mode & 0o777;
  outbox.importLegacy(file);
  const job = outbox.upsert({ ...params, idempotencyKey: 'new' });
  db.exec('BEGIN IMMEDIATE');
  outbox.saveJob({ ...job, attempts: 1 });
  db.exec('ROLLBACK');
  assert.equal(outbox.get('new')?.attempts, 0);
  outbox.saveJob({ ...job, attempts: 1 });
  const reopened = new DatabaseSync(databaseFile);
  try {
    const recovered = new MirrorOutbox(reopened);
    recovered.importLegacy(file);
    assert.equal(recovered.get('new')?.attempts, 1);
    assert.equal(recovered.get('one')?.legacy, true);
  } finally { reopened.close(); }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.statSync(file).mode & 0o777, originalMode);
});

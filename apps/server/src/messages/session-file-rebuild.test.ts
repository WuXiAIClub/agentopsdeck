import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { validateSessionFileRebuild, type ChatMessage } from '@agentopsdeck/shared';
import { SessionFileIndex } from './session-file-index.js';
import { SessionFileRebuilds, FileRebuildError, type FileEvidenceBatch } from './session-file-rebuild.js';

const key = 'ghcp:rebuild', actor = 'reader';
const message = (i: number): ChatMessage => ({ id: `tool-${i}`, sessionKey: key, role: 'tool', toolPhase: 'result', status: 'sent',
  text: '', createdAt: i, sourceFiles: [{ path: `/repo/${i}.ts`, kind: 'modified' }] });
function fixture(read?: (before?: string) => FileEvidenceBatch) {
  const db = new DatabaseSync(':memory:'), index = new SessionFileIndex(db);
  let now = 1000, native: string | undefined = 'native', reads = 0;
  const jobs = new SessionFileRebuilds(index, () => native, (_key, before) => {
    reads++;
    return read ? read(before) : before ? { messages: [message(1)], bytes: 10, scanned: 1 }
      : { messages: [message(2)], before: 'older', bytes: 10, scanned: 1 };
  }, () => now);
  return { db, index, jobs, tick: (ms = 251) => { now += ms; }, reads: () => reads, bind: (id?: string) => { native = id; } };
}

test('explicit start resumes an owned scan without reads, budget reset or a second job', () => {
  const f = fixture();
  try {
    const start = f.jobs.start(key, actor);
    assert.deepEqual(f.jobs.start(key, actor), start, 'lost start response can be recovered explicitly');
    const first = f.jobs.step(key, actor, start.id, 0);
    const resumed = f.jobs.start(key, actor);
    assert.deepEqual(resumed, first, 'closing/reopening retains cursor and accounting');
    resumed.step = 999;
    assert.deepEqual(f.jobs.start(key, actor), first, 'receipt cannot mutate stored progress');
    assert.deepEqual(f.jobs.step(key, actor, start.id, first.step), first, 'resume preserves cooldown');
    assert.equal(f.reads(), 1, 'resume does not read summaries');
    for (let i = 0; i < 3; i++) f.jobs.start(`ghcp:${i}`, actor);
    assert.deepEqual(f.jobs.start(key, actor), first, 'resume works at capacity');
    f.tick();
    const done = f.jobs.step(key, actor, start.id, first.step);
    assert.equal(done.state, 'completed'); assert.equal(done.scanned, 2);
    assert.equal(f.reads(), 2);
  } finally { f.db.close(); }
});

for (const change of ['append', 'rebind', 'deleted'] as const) {
  test(`explicit resume fences ${change} without continuing stale work`, () => {
    const f = fixture();
    try {
      const start = f.jobs.start(key, actor);
      f.jobs.step(key, actor, start.id, 0);
      if (change === 'append') f.index.append(key, 'native', [message(9)]);
      else f.bind(change === 'rebind' ? 'new-native' : undefined);
      const before = f.index.page(key);
      assert.throws(() => f.jobs.start(key, 'other'), (e: unknown) => e instanceof FileRebuildError && e.status === 409,
        'another actor cannot resume or invalidate the owned job');
      assert.equal(f.jobs.start(key, actor).state, 'conflict');
      assert.equal(f.reads(), 1);
      assert.deepEqual(f.index.page(key), before);
      assert.equal(f.jobs.cancel(key, actor, start.id).state, 'conflict');
    } finally { f.db.close(); }
  });
}

test('explicit resume neither extends expiry nor revives cancelled or committed work', () => {
  const f = fixture();
  try {
    const original = f.jobs.start(key, actor);
    f.tick(299_999); assert.deepEqual(f.jobs.start(key, actor), original);
    f.tick(1);
    const fresh = f.jobs.start(key, actor);
    assert.notEqual(fresh.id, original.id); assert.equal(fresh.step, 0);
    assert.throws(() => f.jobs.step(key, actor, original.id, 0), FileRebuildError);
    f.jobs.cancel(key, actor, fresh.id);
    const afterCancel = f.jobs.start(key, actor);
    assert.notEqual(afterCancel.id, fresh.id);
    f.jobs.step(key, actor, afterCancel.id, 0); f.tick();
    assert.equal(f.jobs.step(key, actor, afterCancel.id, 1).state, 'completed');
    assert.notEqual(f.jobs.start(key, actor).id, afterCancel.id);
  } finally { f.db.close(); }
});

test('explicit staged rebuild is metadata-only, ordered, fenced and step-idempotent', () => {
  const f = fixture();
  try {
    const start = f.jobs.start(key, actor);
    assert.equal(f.reads(), 0, 'creation does not scan history');
    const first = f.jobs.step(key, actor, start.id, 0);
    assert.equal(first.state, 'scanning'); assert.equal(first.found, 1);
    assert.equal(f.index.page(key).coverage, 'unavailable', 'partial work is not published');
    assert.deepEqual(f.jobs.step(key, actor, start.id, 0), first);
    assert.deepEqual(f.jobs.step(key, actor, start.id, 1), first, 'server cooldown also limits fast clients');
    assert.equal(f.reads(), 1);
    f.tick();
    const last = f.jobs.step(key, actor, start.id, 1);
    assert.equal(last.state, 'completed'); assert.equal(last.scanned, 2);
    assert.deepEqual(validateSessionFileRebuild(last), last);
    assert.deepEqual(f.index.page(key).entries.map(e => e.messageId), ['tool-2', 'tool-1']);
    assert.equal(f.index.page(key).coverage, 'partial');
    assert.deepEqual(f.jobs.cancel(key, actor, start.id), last, 'commit won cancellation race');
    assert.deepEqual(f.jobs.step(key, actor, start.id, 1), last);
    assert.equal(f.reads(), 2);
  } finally { f.db.close(); }
});

for (const cause of ['cancel', 'append', 'rebind', 'deleted', 'expire', 'read-failure', 'storage-failure'] as const) {
  test(`${cause} preserves original file evidence`, () => {
    let calls = 0;
    const f = fixture(before => {
      if (++calls === 2 && cause === 'read-failure') throw new Error('private details must not leak');
      return { messages: [message(before ? 1 : 2)], scanned: 1, bytes: 10, ...(!before ? { before: 'older' } : {}) };
    });
    try {
      f.index.append(key, 'native', [message(9)]);
      const start = f.jobs.start(key, actor);
      f.jobs.step(key, actor, start.id, 0); f.tick();
      if (cause === 'append') f.index.append(key, 'native', [message(10)]);
      if (cause === 'rebind') f.bind('new-native');
      if (cause === 'deleted') f.bind();
      if (cause === 'storage-failure') f.db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON session_file_evidence BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
      const original = f.index.page(key);
      if (cause === 'expire') { f.tick(300_001); assert.throws(() => f.jobs.step(key, actor, start.id, 1), FileRebuildError); }
      else {
        const result = cause === 'cancel' ? f.jobs.cancel(key, actor, start.id) : f.jobs.step(key, actor, start.id, 1);
        assert.equal(result.state, cause === 'cancel' ? 'cancelled' : cause.endsWith('failure') ? 'failed' : 'conflict');
        assert.ok(!JSON.stringify(result).includes('private'));
      }
      assert.deepEqual(f.index.page(key), original);
    } finally { f.db.close(); }
  });
}

test('actor/session isolation, active-job capacity, expiry and shutdown', () => {
  const f = fixture();
  try {
    const job = f.jobs.start(key, actor);
    assert.throws(() => f.jobs.step(key, 'other-actor', job.id, 0), FileRebuildError);
    assert.throws(() => f.jobs.cancel('other-session', actor, job.id), FileRebuildError);
    assert.throws(() => f.jobs.start(key, 'other-actor'), FileRebuildError);
    assert.throws(() => f.jobs.step(key, actor, job.id, 8), FileRebuildError);
    for (let i = 0; i < 3; i++) f.jobs.start(`ghcp:${i}`, actor);
    assert.throws(() => f.jobs.start('ghcp:over-cap', actor), FileRebuildError);
    f.jobs.cancel(key, actor, job.id);
    f.jobs.start('ghcp:replacement', actor);
    f.tick(300_001); assert.doesNotThrow(() => f.jobs.start(key, actor));
    f.jobs.close(); assert.throws(() => f.jobs.cancel(key, actor, job.id), FileRebuildError);
    assert.equal(f.reads(), 0);
  } finally { f.db.close(); }
});

for (const change of ['coverage', 'empty-rebind'] as const) {
  test(`${change} invalidates in-flight rebuild even without new file evidence`, () => {
    const f = fixture();
    try {
      f.index.append(key, 'native', [message(9)]);
      const job = f.jobs.start(key, actor);
      assert.equal(f.jobs.step(key, actor, job.id, 0).state, 'scanning');
      if (change === 'coverage') f.index.append(key, 'native',
        Array.from({ length: 100_001 }, () => ({ ...message(10), sourceFiles: [] })));
      else f.index.append(key, 'replacement', []);
      const before = f.index.page(key);
      f.tick();
      assert.equal(f.jobs.step(key, actor, job.id, 1).state, 'conflict');
      assert.deepEqual(f.index.page(key), before, 'old rebuild cannot replace the new scope');
      assert.equal(f.reads(), 1, 'fence prevents another scan');
    } finally { f.db.close(); }
  });
}

test('scan budgets stop empty-evidence histories without fake completeness or body access', () => {
  const f = fixture(before => {
    const row = message(1); row.sourceFiles = [];
    Object.defineProperty(row, 'text', { get() { throw new Error('body access'); } });
    return { messages: [row], scanned: 20, bytes: 1024 * 1024, before: String(Number(before ?? 0) + 1) };
  });
  try {
    let progress = f.jobs.start(key, actor);
    for (let i = 0; i < 64; i++) { f.tick(); progress = f.jobs.step(key, actor, progress.id, progress.step); }
    assert.equal(progress.state, 'completed'); assert.equal(progress.limited, true); assert.equal(progress.found, 0);
    assert.equal(progress.bytes, 64 * 1024 * 1024); assert.equal(f.reads(), 64);
    assert.equal(f.index.page(key).limited, true); assert.equal(f.index.page(key).coverage, 'partial');
  } finally { f.db.close(); }
});

test('newest metadata wins under cap; duplicates never reorder or overwrite evidence', () => {
  let newest = 5000;
  const f = fixture(() => ({ messages: Array.from({ length: 20 }, (_, i) => message(newest - 19 + i)), scanned: 20, bytes: 3000, before: String(newest -= 20) }));
  try {
    let progress = f.jobs.start(key, actor);
    for (let i = 0; i < 202 && progress.state === 'scanning'; i++) { f.tick(); progress = f.jobs.step(key, actor, progress.id, progress.step); }
    assert.equal(progress.state, 'completed'); assert.equal(progress.limited, true); assert.equal(progress.found, 4000);
    const page = f.index.page(key);
    assert.equal(page.entries[0]!.messageId, 'tool-5000'); assert.equal(page.entries.length, 50);
    assert.ok(!JSON.stringify(page).includes('text'));
  } finally { f.db.close(); }
});

test('untrusted progress cannot inject errors, URLs, huge counters or unknown states', () => {
  const f = fixture();
  try {
    const start = f.jobs.start(key, actor);
    assert.deepEqual(validateSessionFileRebuild({ ...start, secret: 'private' } as any), start);
    for (const extra of [{ id: '../other' }, { state: 'success-full-history' }, { step: -1 }, { bytes: 1e12 }, { found: 4001 }])
      assert.throws(() => validateSessionFileRebuild({ ...start, ...extra } as any));
  } finally { f.db.close(); }
});

test('large file metadata reaches byte budget before row budget and retains newest evidence', () => {
  let newest = 5000;
  const f = fixture(() => ({ messages: Array.from({ length: 20 }, (_, i) => ({ ...message(newest - 19 + i),
    sourceFiles: [{ path: `/repo/${'x'.repeat(1900)}/${newest - 19 + i}.ts`, kind: 'modified' as const }] })),
    scanned: 20, bytes: 70_000, before: String(newest -= 20) }));
  try {
    let progress = f.jobs.start(key, actor);
    for (let i = 0; i < 100 && progress.state === 'scanning'; i++) { f.tick(); progress = f.jobs.step(key, actor, progress.id, progress.step); }
    assert.equal(progress.state, 'completed'); assert.equal(progress.limited, true);
    assert.ok(progress.found > 0 && progress.found < 2000);
    const rows = f.db.prepare('SELECT data FROM session_file_evidence').all() as { data: string }[];
    assert.ok(Buffer.byteLength(`[${rows.map(row => row.data).join(',')}]`) <= 2 * 1024 * 1024);
    assert.equal(f.index.page(key).entries[0]!.messageId, 'tool-5000');
  } finally { f.db.close(); }
});

test('conflicting duplicates abort instead of replacing original index', () => {
  const f = fixture(before => ({ messages: [{ ...message(1), createdAt: before ? 2 : 1 }], scanned: 1, bytes: 100,
    ...(!before ? { before: 'older' } : {}) }));
  try {
    f.index.append(key, 'native', [message(9)]);
    const original = f.index.page(key), start = f.jobs.start(key, actor);
    f.jobs.step(key, actor, start.id, 0); f.tick();
    assert.equal(f.jobs.step(key, actor, start.id, 1).state, 'failed');
    assert.deepEqual(f.index.page(key), original);
  } finally { f.db.close(); }
});

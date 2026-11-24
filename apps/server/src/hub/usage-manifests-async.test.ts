import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { UsageManifests, usageSelection } from './usage-manifests.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { DelegationMember } from './workspace-delegation-preview.js';
import { NativeTokenUsageStore } from '../connector/native-token-usage.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:'); let closed = false, authority = true, admissions = 0;
  const logs: Record<string, unknown>[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  let admission: (write: () => Promise<unknown>) => Promise<unknown> = write => write();
  const store = new UsageManifests(db, () => authority, () => 1000,
    () => { throw Error('synchronous admission must not run'); }, diagnostics,
    async <T>(bytes: number, write: () => Promise<T>) => {
      admissions++; assert.ok(bytes >= 16 * 1024 ** 2); assert.equal(db.isTransaction, false);
      return await admission(write) as T;
    });
  const other = new UsageManifests(db, () => authority, () => 1000, undefined, diagnostics);
  const selection = usageSelection({ requestId: randomUUID(), from: 0, to: 60000, bucketMs: 60000, tags: [], tagMode: 'all' });
  const member: DelegationMember = { owner: 'alice', sessionId: 'session', nodeId: 'node', connectionId: 'dev', runtime: 'codex', authorityEpoch: 1, groupId: null, tags: [], taskBinding: 'unknown' };
  const close = () => { if (!closed) { closed = true; db.close(); } }; t.after(close);
  return { db, store, other, selection, member, logs, close, revoke: () => { authority = false; },
    setAdmission: (value: typeof admission) => { admission = value; }, get admissions() { return admissions; },
    rows: () => Number(db.prepare('SELECT count(*) n FROM hub_usage_manifests').get()!.n) };
}

for (const operation of ['prepare','confirm','claim','record','cancel'] as const) {
  test(`manifest ${operation} rechecks original proof inside its write transaction and rolls back refusal`,async t => {
    const f = fixture(t);
    let original = operation === 'prepare' ? undefined : await f.store.prepareAsync('alice',f.selection,'directory',[f.member]);
    if (operation === 'claim' || operation === 'record') f.store.confirm('alice',f.selection.requestId);
    if (operation === 'record') await f.store.claimAsync('alice',f.selection.requestId,original!.members[0]!.requestId);
    original = f.store.read('alice',f.selection.requestId);
    let transactionalChecks = 0;
    const check = () => { if (f.db.isTransaction) { transactionalChecks++; throw Error('original-proof-revoked'); } };
    const work = async () => {
      if (operation === 'prepare') return f.store.prepareAsync('alice',f.selection,'directory',[f.member],check);
      if (operation === 'confirm') return f.store.confirm('alice',f.selection.requestId,check);
      if (operation === 'claim') return f.store.claimAsync('alice',f.selection.requestId,original!.members[0]!.requestId,check);
      if (operation === 'cancel') return f.store.cancel('alice',f.selection.requestId,check);
      return f.store.record('alice',f.selection.requestId,original!.members[0]!.requestId,{},check);
    };
    await assert.rejects(work(),/original-proof-revoked/); assert.equal(transactionalChecks,1);
    assert.equal(f.db.isTransaction,false); assert.deepEqual(f.store.read('alice',f.selection.requestId),original);
    assert.equal(f.store.cancelled('alice',f.selection.requestId),false);
  });
}

for(const operation of ['prepare','claim'] as const) {
  test(`manifest ${operation} rejects known async request guards before their body or admission`,async t=>{
    const f=fixture(t);let calls=0;
    const check=async()=>{calls++;};
    if(operation==='prepare')await assert.rejects(f.store.prepareAsync('alice',f.selection,'directory',[f.member],check));
    else {
      const original=f.other.prepare('alice',f.selection,'directory',[f.member]);f.other.confirm('alice',f.selection.requestId);
      await assert.rejects(f.store.claimAsync('alice',f.selection.requestId,original.members[0]!.requestId,check));
      assert.equal(f.other.read('alice',f.selection.requestId)!.members[0]!.state,'prepared');
    }
    assert.equal(calls,0);assert.equal(f.admissions,0);assert.equal(f.db.isTransaction,false);
  });
}

test('manifest refuses known async member authority before its body without retiring a healthy owner',async t=>{
  const f=fixture(t);let calls=0;
  const store=new UsageManifests(f.db,(async()=>{calls++;return true;}) as any);
  await assert.rejects(store.prepareAsync('alice',f.selection,'directory',[f.member]));
  assert.equal(calls,0);assert.equal(f.rows(),0);assert.equal(f.db.isTransaction,false);
  assert.equal((await f.store.prepareAsync('alice',f.selection,'directory',[f.member])).state,'prepared');
});

for(const value of [1,'true',new Boolean(true),{get then(){throw Error('then must not be inspected');}}]) {
  test(`manifest refuses nonliteral authority ${typeof value} without inspecting then`,async t=>{
    const f=fixture(t),store=new UsageManifests(f.db,(()=>value) as any);
    await assert.rejects(store.prepareAsync('alice',f.selection,'directory',[f.member]),/members/);
    assert.equal(f.rows(),0);assert.equal(f.db.isTransaction,false);
  });
}

test('manifest authority preserves original receiver and arguments',async t=>{
  const f=fixture(t);let calls=0;
  const store=new UsageManifests(f.db,function(this:UsageManifests,owner,member){
    calls++;assert.equal(this,store);assert.equal(owner,'alice');assert.deepEqual(member,f.member);return true;
  });
  const result=await store.prepareAsync('alice',f.selection,'directory',[f.member]);
  assert.equal(result.state,'prepared');assert.ok(calls>0);assert.equal(f.rows(),1);
});

test('manifest request guard is revalidated after admission and refuses a nonvoid value',async t=>{
  const f=fixture(t),entered=gate(),release=gate();let stale=false;
  f.setAdmission(async write=>{entered.release();await release.promise;return write();});
  const pending=f.store.prepareAsync('alice',f.selection,'directory',[f.member],(()=>stale?true:undefined) as any);
  await entered.promise;stale=true;release.release();await assert.rejects(pending,/request-authority/);
  assert.equal(f.rows(),0);assert.equal(f.db.isTransaction,false);
});

for (const fault of ['rejected', 'uninvoked', 'duplicate', 'forged-result'] as const) {
  test(`manifest refuses ${fault} admission callbacks outside original write lifetime`, async t => {
    const f = fixture(t); let late!: () => Promise<unknown>;
    const failure = Error('synthetic admission rejected');
    f.setAdmission(async write => {
      late = write;
      if (fault === 'rejected') throw failure;
      if (fault === 'uninvoked') return undefined;
      await write();
      if (fault === 'duplicate') return write();
      return { forged: true };
    });
    const pending = f.store.prepareAsync('alice', f.selection, 'directory', [f.member]);
    if (fault === 'forged-result') assert.deepEqual(await pending, f.store.read('alice', f.selection.requestId));
    else if (fault === 'rejected') await assert.rejects(pending, error => error === failure);
    else await assert.rejects(pending);
    const original = f.store.read('alice', f.selection.requestId), logs = JSON.stringify(f.logs);
    assert.equal(f.rows(), fault === 'duplicate' || fault === 'forged-result' ? 1 : 0);
    await assert.rejects(late(), /admission ended/);
    assert.deepEqual(f.store.read('alice', f.selection.requestId), original);
    assert.equal(JSON.stringify(f.logs), logs); assert.equal(f.db.isTransaction, false);
  });
}

test('async preview waits without a SQL transaction and snapshots caller-owned input', async t => {
  const f = fixture(t), entered = gate(), release = gate();
  f.setAdmission(async write => { entered.release(); await release.promise; return write(); });
  const pending = f.store.prepareAsync('alice', f.selection, 'directory', [f.member]); await entered.promise;
  assert.equal(f.db.isTransaction, false); assert.equal(f.rows(), 0);
  f.selection.tags.push('late-secret'); f.member.tags.push('late-secret'); release.release();
  const result = await pending; assert.deepEqual(result.selection.tags, []); assert.deepEqual(result.members[0]!.member.tags, []);
  assert.equal(f.admissions, 1); assert.equal(f.rows(), 1); assert.equal(f.db.isTransaction, false);
  const log = f.logs.find(row => row.operation === 'usage-manifest-admission');
  assert.equal(log?.changed, 1); assert.equal(log?.category, 'routine');
  for (const field of ['queueMs', 'bodyMs', 'releaseMs']) assert.equal(typeof log?.[field], 'number');
  assert.equal(JSON.stringify(f.logs).includes('late-secret'), false);
});

test('preview duplicate bypasses admission pressure but cannot reuse different immutable input', async t => {
  const f = fixture(t), original = await f.store.prepareAsync('alice', f.selection, 'directory', [f.member]);
  f.setAdmission(async () => { throw Error('pressure'); });
  assert.deepEqual(await f.store.prepareAsync('alice', f.selection, 'changed', []), original); assert.equal(f.admissions, 1);
  await assert.rejects(f.store.prepareAsync('alice', { ...f.selection, tags: ['changed'] }, 'directory', []), /request-reused/);
  assert.equal(f.rows(), 1);
});

test('concurrent preview creation retains original manifest and exact child IDs after waiting', async t => {
  const f = fixture(t), entered = gate(), release = gate();
  f.setAdmission(async write => { entered.release(); await release.promise; return write(); });
  const pending = f.store.prepareAsync('alice', f.selection, 'directory', [f.member]); await entered.promise;
  const original = f.other.prepare('alice', f.selection, 'original', [f.member]); release.release();
  assert.deepEqual(await pending, original); assert.equal(f.rows(), 1);
  assert.equal(f.logs.find(row => row.operation === 'usage-manifest-admission')?.changed, undefined);
});

test('concurrent incompatible preview rejects without replacing the original receipt', async t => {
  const f = fixture(t), entered = gate(), release = gate();
  f.setAdmission(async write => { entered.release(); await release.promise; return write(); });
  const pending = f.store.prepareAsync('alice', f.selection, 'directory', [f.member]); await entered.promise;
  const original = f.other.prepare('alice', { ...f.selection, tags: ['other'] }, 'original', [f.member]); release.release();
  await assert.rejects(pending, /request-reused/); assert.deepEqual(f.other.read('alice', f.selection.requestId), original);
});

for (const reason of ['cancelled', 'revoked', 'closed', 'outer-transaction', 'request-aborted'] as const) {
  test(`preview ${reason} during admission cannot commit its delayed writer`, async t => {
    const f = fixture(t), entered = gate(), release = gate(); let aborted = false;
    f.setAdmission(async write => { entered.release(); await release.promise; return write(); });
    const pending = f.store.prepareAsync('alice', f.selection, 'directory', [f.member], () => { if (aborted) throw Error('request-aborted'); });
    await entered.promise;
    if (reason === 'cancelled') f.other.cancel('alice', f.selection.requestId);
    if (reason === 'revoked') f.revoke();
    if (reason === 'closed') f.close();
    if (reason === 'outer-transaction') f.db.exec('BEGIN');
    if (reason === 'request-aborted') aborted = true;
    release.release(); await assert.rejects(pending);
    if (reason === 'outer-transaction') { assert.equal(f.db.isTransaction, true); f.db.exec('ROLLBACK'); }
    if (reason !== 'closed') assert.equal(f.rows(), 0);
    assert.equal(f.logs.find(row => row.operation === 'usage-manifest-admission')?.deferred, 1);
  });
}

test('outer transaction present at invocation never enters asynchronous admission', async t => {
  const f = fixture(t); f.db.exec('BEGIN');
  await assert.rejects(f.store.prepareAsync('alice', f.selection, 'directory', []), /outer-transaction/);
  assert.equal(f.admissions, 0); assert.equal(f.db.isTransaction, true); f.db.exec('ROLLBACK');
});

test('preview lost release acknowledgment preserves original result for read-only recovery', async t => {
  const f = fixture(t); f.setAdmission(async write => { await write(); throw Error('lost private release'); });
  await assert.rejects(f.store.prepareAsync('alice', f.selection, 'directory', [f.member]), /lost private release/);
  const original = f.store.read('alice', f.selection.requestId)!; assert.equal(original.state, 'prepared');
  assert.deepEqual(await f.store.prepareAsync('alice', f.selection, 'directory', [f.member]), original); assert.equal(f.admissions, 1);
  const log = f.logs.find(row => row.operation === 'usage-manifest-admission' && row.category === 'failed');
  assert.equal(log?.unknown, 1); assert.equal(JSON.stringify(f.logs).includes(f.selection.requestId), false);
  assert.equal(JSON.stringify(f.logs).includes('private'), false);
});

test('child lost release acknowledgment is durably UNKNOWN and duplicate never reclaims', async t => {
  const f = fixture(t), original = f.other.prepare('alice', f.selection, 'directory', [f.member]);
  f.store.confirm('alice', f.selection.requestId); const child = original.members[0]!.requestId;
  f.setAdmission(async write => { await write(); throw Error('lost release'); });
  await assert.rejects(f.store.claimAsync('alice', f.selection.requestId, child), /lost release/);
  assert.equal(f.store.read('alice', f.selection.requestId)!.members[0]!.state, 'unknown');
  assert.equal(await f.store.claimAsync('alice', f.selection.requestId, child), false); assert.equal(f.admissions, 1);
  assert.equal(f.logs.find(row => row.operation === 'usage-manifest-admission' && row.category === 'failed')?.unknown, 1);
});

test('two concurrent child claims settle to exactly one dispatch permission', async t => {
  const f = fixture(t), original = f.other.prepare('alice', f.selection, 'directory', [f.member]);
  f.store.confirm('alice', f.selection.requestId); const child = original.members[0]!.requestId;
  const entered = gate(), release = gate(); let waiting = 0;
  f.setAdmission(async write => { if (++waiting === 2) entered.release(); await release.promise; return write(); });
  const first = f.store.claimAsync('alice', f.selection.requestId, child), second = f.store.claimAsync('alice', f.selection.requestId, child);
  await entered.promise; assert.equal(f.db.isTransaction, false); release.release();
  assert.deepEqual((await Promise.all([first, second])).sort(), [false, true]);
  assert.equal(f.store.read('alice', f.selection.requestId)!.members[0]!.state, 'unknown');
});

for (const reason of ['revoked', 'request-aborted', 'closed'] as const) {
  test(`child ${reason} during admission cannot transition a prepared member`, async t => {
    const f = fixture(t), original = f.other.prepare('alice', f.selection, 'directory', [f.member]);
    f.store.confirm('alice', f.selection.requestId); const child = original.members[0]!.requestId;
    const entered = gate(), release = gate(); let aborted = false;
    f.setAdmission(async write => { entered.release(); await release.promise; return write(); });
    const pending = f.store.claimAsync('alice', f.selection.requestId, child, () => { if (aborted) throw Error('request-aborted'); });
    await entered.promise;
    if (reason === 'revoked') f.revoke(); if (reason === 'closed') f.close(); if (reason === 'request-aborted') aborted = true;
    release.release(); await assert.rejects(pending);
    if (reason !== 'closed') {
      const row = f.db.prepare('SELECT payload FROM hub_usage_manifests WHERE id=?').get(f.selection.requestId)!;
      assert.equal(JSON.parse(String(row.payload)).members[0].state, 'prepared');
    }
  });
}

test('after-write lifetime invalidation cannot grant dispatch or clear the unknown fence', async t => {
  const f = fixture(t), original = f.other.prepare('alice', f.selection, 'directory', [f.member]); let available = true;
  f.store.confirm('alice', f.selection.requestId); const child = original.members[0]!.requestId;
  f.setAdmission(async write => { const result = await write(); available = false; return result; });
  await assert.rejects(f.store.claimAsync('alice', f.selection.requestId, child, () => { if (!available) throw Error('closed route'); }), /closed route/);
  assert.equal(f.store.read('alice', f.selection.requestId)!.members[0]!.state, 'unknown');
  assert.equal(f.logs.find(row => row.operation === 'usage-manifest-admission' && row.category === 'failed')?.unknown, 1);
});

for (const operation of ['preview', 'child'] as const) {
  test(`${operation} connection closed after commit rejects even without a caller lifetime check`, async t => {
    const f = fixture(t);
    const original = operation === 'child' ? f.other.prepare('alice', f.selection, 'directory', [f.member]) : undefined;
    if (original) f.store.confirm('alice', f.selection.requestId);
    let committedState: string | undefined;
    f.setAdmission(async write => {
      const result = await write();
      const receipt = f.other.read('alice', f.selection.requestId)!;
      committedState = operation === 'child' ? receipt.members[0]!.state : receipt.state;
      f.close(); return result;
    });
    const pending = original
      ? f.store.claimAsync('alice', f.selection.requestId, original.members[0]!.requestId)
      : f.store.prepareAsync('alice', f.selection, 'directory', [f.member]);
    await assert.rejects(pending);
    assert.equal(committedState, operation === 'child' ? 'unknown' : 'prepared');
    assert.equal(f.admissions, 1);
    assert.equal(f.logs.find(row => row.operation === 'usage-manifest-admission' && row.category === 'failed')?.unknown, 1);
  });
}

test('preview cancelled after commit never returns the stale prepared receipt', async t => {
  const f = fixture(t);
  f.setAdmission(async write => { const result = await write(); f.other.cancel('alice', f.selection.requestId); return result; });
  await assert.rejects(f.store.prepareAsync('alice', f.selection, 'directory', [f.member]), /cancelled/);
  assert.equal(f.other.read('alice', f.selection.requestId)!.state, 'cancelled');
  assert.equal(f.logs.find(row => row.operation === 'usage-manifest-admission' && row.category === 'failed')?.unknown, 1);
});

test('preview advanced during release returns the original current receipt instead of a stale preview', async t => {
  const f = fixture(t);
  f.setAdmission(async write => { const result = await write(); f.other.confirm('alice', f.selection.requestId); return result; });
  const receipt = await f.store.prepareAsync('alice', f.selection, 'directory', [f.member]);
  assert.equal(receipt.state, 'collecting'); assert.deepEqual(receipt, f.other.read('alice', f.selection.requestId));
});

test('child completed by original-only recovery during release never returns another dispatch permission', async t => {
  const f = fixture(t), original = f.other.prepare('alice', f.selection, 'directory', [f.member]);
  f.other.confirm('alice', f.selection.requestId); const child = original.members[0]!.requestId;
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const ledger = new NativeTokenUsageStore(db, () => 1000);
  const snapshot = ledger.snapshot('codex', 'codex:synthetic', child, 0, 60000, 60000);
  f.setAdmission(async write => { const result = await write(); f.other.record('alice', f.selection.requestId, child, snapshot); return result; });
  assert.equal(await f.store.claimAsync('alice', f.selection.requestId, child), false);
  assert.equal(f.other.read('alice', f.selection.requestId)!.state, 'complete');
  assert.equal(f.admissions, 1);
});

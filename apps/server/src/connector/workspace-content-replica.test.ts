import assert from 'node:assert/strict';
import { WorkspaceContentMetadata, type WorkspaceContentMetadataPort } from './workspace-content-metadata.js';
import { WorkspaceContentEffects } from './workspace-content-replica.js';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ContentProposalStore } from '../hub/content-proposal-store.js';
import { ConnectorFileBoards, ConnectorWorkspaceFiles } from './workspace-board-files.js';
import { cardFileCodec } from './workspace-file-card-format.js';
import type { WorkspaceFileCard } from '@agentopsdeck/shared';
import { boardFileCodec } from './workspace-board-file-format.js';
import { WorkspaceContentReplica, type ContentProposalEndpoint, type ContentReplicaStorageAdmission } from './workspace-content-replica.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'content-replica-'));
  const hubDb = new DatabaseSync(':memory:');
  let db = new DatabaseSync(join(root, 'connector.sqlite'));
  let files = new ConnectorFileBoards(db, root, owner => owner === 'alice');
  t.after(async () => { await local.close(); await files.close(); db.close(); hubDb.close(); await rm(root, { recursive: true, force: true }); });
  const canonical = (text: string) => {
    const value: unknown = JSON.parse(text); if (!boardFileCodec.valid(value)) throw Error('schema');
    return JSON.stringify(boardFileCodec.parse(Buffer.from(boardFileCodec.serialize(value)))!.content);
  };
  const hub = new ContentProposalStore(hubDb, canonical, owner => owner === 'alice');
  const base = hub.initialize('alice', 'board', 'epoch1', JSON.stringify({ title: 'Original', tasks: [] }));
  let local = new WorkspaceContentReplica(db, files);
  async function reopen() {
    await local.close(); await files.close(); db.close();
    db = new DatabaseSync(join(root, 'connector.sqlite'));
    files = new ConnectorFileBoards(db, root, owner => owner === 'alice');
    local = new WorkspaceContentReplica(db, files);
  }
  async function attach() {
    const b = hub.bind('alice', 'board', randomUUID(), 'authority1');
    const input = { id: b.id, generation: b.generation, resource: 'board', sessionKey: `codex:${randomUUID()}`, base };
    const proof = await local.install('alice', input);
    hub.acknowledgeInstallation('alice', 'board', b.id, b.generation, proof);
    return { ...b, input, path: files.get('alice', b.id).path };
  }
  const a = await attach(), b = await attach();
  const endpoint: ContentProposalEndpoint = {
    propose: async (resource, proposal) => hub.propose('alice', resource, proposal),
    original: async (resource, proposal) => hub.receipt('alice', resource, proposal.bindingId, proposal.generation, proposal.mutationId),
  };
  const edit = (path: string, title: string) => writeFile(path, boardFileCodec.serialize({ title, tasks: [] }));
  async function publish(title = 'Changed') {
    await edit(a.path, title); const p = (await local.observe('alice', a.id))!;
    const result = await local.publish('alice', a.id, p.proposal.mutationId, endpoint);
    return { p, result };
  }
  function claim() {
    const job = hub.projections('alice', 'board', b.id, b.generation).find(p => p.state === 'pending')!;
    return hub.claimProjection('alice', 'board', job.id, base.hash, false).job;
  }
  return { root, get db() { return db; }, hubDb, hub, get files() { return files; }, get local() { return local; }, base, a, b, endpoint, edit, publish, claim, reopen };
}

function delayedAdmission() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const admission: ContentReplicaStorageAdmission = async (_bytes, write) => {
    enter(); await gate; return write();
  };
  return { admission, entered, release };
}

for (const failed of [false, true]) test(`close drains original network settlement without resending (${failed})`, async t => {
  const f = await fixture(t); await f.edit(f.a.path, 'Pending close');
  const proposal = (await f.local.observe('alice', f.a.id))!, gate = delayedAdmission();
  let sends = 0, drained = false;
  const flight = f.local.publish('alice', f.a.id, proposal.proposal.mutationId, {
    ...f.endpoint, propose: async (...args) => {
      sends++; await gate.admission(0, () => undefined);
      if (failed) throw Error('unknown transport');
      return f.endpoint.propose(...args);
    },
  });
  await gate.entered;
  const closing = f.local.close().then(() => { drained = true; });
  try {
    await assert.rejects(f.local.view('alice', f.b.id), /closing/);
    await assert.rejects(f.local.revoke('alice', f.b.id), /closing/);
    await assert.rejects(f.local.install('alice', f.b.input), /closing/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal(f.local.proposals('alice', f.a.id)[0]!.state, 'unknown');
  } finally { gate.release(); }
  assert.equal((await flight).state, failed ? 'unknown' : 'committed');
  await closing; await f.local.close(); assert.equal(sends, 1);
  await f.reopen();
  assert.equal((await f.local.recover('alice', f.a.id, proposal.proposal.mutationId, f.endpoint)).state,
    failed ? 'unknown' : 'committed');
  assert.equal(sends, 1);
});

test('close drains original file writer and final projection receipt before dependencies close', async t => {
  const f = await fixture(t); await f.publish(); const job = f.claim(), gate = delayedAdmission();
  const write = f.files.write.bind(f.files); let writes = 0, drained = false;
  f.files.write = async (...args) => { writes++; await gate.admission(0, () => undefined); return write(...args); };
  const flight = f.local.project('alice', f.b.id, job);
  await gate.entered; const closing = f.local.close().then(() => { drained = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
  } finally { gate.release(); }
  assert.equal((await flight).state, 'saved'); await closing;
  await f.reopen(); await f.edit(f.b.path, 'Later edit');
  assert.equal((await f.local.projectionReceipt('alice', f.b.id, job)).state, 'saved');
  assert.equal(JSON.parse(await readFile(f.b.path, 'utf8')).title, 'Later edit'); assert.equal(writes, 1);
});

test('revocation still fences busy bindings and its physical cleanup participates in drain', async t => {
  const f = await fixture(t), gate = delayedAdmission();
  const replica = new WorkspaceContentReplica(f.db, f.files, gate.admission);
  await f.edit(f.a.path, 'Private'); const flight = replica.observe('alice', f.a.id);
  const rejected = assert.rejects(flight, /replica-unavailable|403/);
  await gate.entered;
  const cleanupGate = delayedAdmission(), revoke = f.files.revoke.bind(f.files);
  f.files.revoke = async (...args) => { await cleanupGate.admission(0, () => undefined); return revoke(...args); };
  const revoked = replica.revoke('alice', f.a.id);
  await cleanupGate.entered;
  let drained = false; const closing = replica.close().then(() => { drained = true; });
  try {
    gate.release(); await rejected; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false, 'revocation cleanup must not be lost when the other work completes');
  } finally { gate.release(); cleanupGate.release(); }
  await revoked; await closing;
  assert.equal(JSON.parse(await readFile(f.a.path, 'utf8')).title, 'Private');
});

test('reentrant close tracks accepted work before metadata callbacks, ignoring public promise mutation', async t => {
  const f = await fixture(t), gate = delayedAdmission();
  const metadata = new WorkspaceContentMetadata(f.db, f.files);
  let closing: Promise<void> | undefined, drained = false;
  const replica = new WorkspaceContentEffects(new Proxy(metadata, { get(target, key) {
    if (key === 'owned') return async (...args: Parameters<typeof metadata.owned>) => {
      closing ??= replica.close().then(() => { drained = true; });
      await gate.admission(0, () => undefined); return target.owned(...args);
    };
    const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
  } }), f.files);
  const flight = replica.view('alice', f.a.id), result = flight.then(value => value);
  flight.then = (() => { throw Error('caller-mutated promise'); }) as typeof flight.then;
  await gate.entered;
  try { await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false); }
  finally { gate.release(); }
  assert.equal((await result).resource, 'board'); await closing; assert.equal(drained, true);
});

for (const revoked of [false, true]) {
  test(`conflict resolution revalidates original replica after physical wait: ${revoked}`, async t => {
    const { f, request } = await conflicted(t), gate = delayedAdmission();
    const replica = new WorkspaceContentReplica(f.db, f.files, gate.admission);
    const flight = replica.resolve('alice', f.b.id, request); void flight.catch(() => {});
    try {
      await gate.entered;
      const before = f.local.proposals('alice', f.b.id);
      assert.equal(before.length, 1); assert.equal(before[0]!.resolvedBy, undefined);
      if (revoked) await f.local.revoke('alice', f.b.id);
      gate.release();
      if (revoked) {
        await assert.rejects(flight, /replica-unavailable/);
        const persisted = f.db.prepare('SELECT payload FROM connector_local_proposals WHERE binding=?').all(f.b.id);
        assert.equal(persisted.length, 1); assert.equal(JSON.parse(String(persisted[0]!.payload)).resolvedBy, undefined);
      } else {
        const result = await flight;
        assert.equal(result.state, 'prepared'); assert.equal(result.proposal.mutationId, request.mutationId);
      }
    } finally { gate.release(); await flight.catch(() => {}); }
  });
}

for (const action of ['claim', 'publish', 'observe', 'project'] as const) {
  for (const revoked of [false, true]) {
    test(`replica ${action} waits for original durable admission and rechecks revocation: ${revoked}`, async t => {
      const f = await fixture(t), gate = delayedAdmission();
      let mutation = '', job: ReturnType<typeof f.claim> | undefined;
      if (action === 'project') { await f.publish(); job = f.claim(); }
      else {
        await f.edit(f.a.path, 'Captured draft');
        if (action !== 'observe') mutation = (await f.local.observe('alice', f.a.id))!.proposal.mutationId;
      }
      const id = action === 'project' ? f.b.id : f.a.id;
      let sends = 0, writes = 0;
      const endpoint = { ...f.endpoint, propose: async (...args: Parameters<typeof f.endpoint.propose>) => {
        sends++; return f.endpoint.propose(...args);
      } };
      const write = f.files.write.bind(f.files);
      f.files.write = async (...args) => { writes++; return write(...args); };
      const replica = new WorkspaceContentReplica(f.db, f.files, gate.admission);
      const flight = action === 'claim' ? replica.claimPublish('alice', id, mutation)
        : action === 'publish' ? replica.publish('alice', id, mutation, endpoint)
        : action === 'observe' ? replica.observe('alice', id) : replica.project('alice', id, job!);
      // Attach immediately: a rejected admission must never become unhandled.
      void flight.catch(() => {});
      try {
        await gate.entered; await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(sends, 0, 'no network handoff before durable UNKNOWN');
        assert.equal(writes, 0, 'no file replacement before durable projection intent');
        if (action === 'claim' || action === 'publish') assert.equal(f.local.proposals('alice', id)[0]!.state, 'prepared');
        if (action === 'observe') assert.equal(f.local.proposals('alice', id).length, 0);
        if (action === 'project') assert.equal(f.db.prepare('SELECT count(*) n FROM connector_content_projections').get()!.n, 0);
        if (revoked) await f.local.revoke('alice', id);
        gate.release();
        if (revoked) {
          await assert.rejects(flight, /replica-unavailable|403/);
          assert.equal(sends, 0); assert.equal(writes, 0);
          if (action === 'project') assert.equal(f.db.prepare('SELECT count(*) n FROM connector_content_projections').get()!.n, 0);
          if (action === 'observe') assert.equal(f.db.prepare('SELECT count(*) n FROM connector_local_proposals').get()!.n, 0);
        } else {
          const result = await flight;
          assert.ok(result);
          assert.equal(sends, action === 'publish' ? 1 : 0);
          assert.equal(writes, action === 'project' ? 1 : 0);
        }
      } finally { gate.release(); await flight.catch(() => {}); }
    });
  }
}

test('replica installation cannot touch files before original durable intent', async t => {
  const f = await fixture(t), gate = delayedAdmission();
  const binding = f.hub.bind('alice', 'board', randomUUID(), 'authority1');
  const input = { id: binding.id, generation: binding.generation, resource: 'board', sessionKey: `codex:${randomUUID()}`, base: f.base };
  let installs = 0;
  const install = f.files.install.bind(f.files);
  f.files.install = async (...args) => { installs++; return install(...args); };
  const replica = new WorkspaceContentReplica(f.db, f.files, gate.admission);
  const flight = replica.install('alice', input); void flight.catch(() => {});
  try {
    await gate.entered; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(installs, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM connector_content_replicas WHERE id=?').get(input.id)!.n, 0);
    gate.release(); await flight;
    assert.equal(installs, 1);
    await f.reopen();
    assert.equal((await f.local.view('alice', input.id)).initial.hash, f.base.hash);
  } finally { gate.release(); await flight.catch(() => {}); }
});

test('first proposal handoff reserves storage; denial preserves prepared intent and original queries stay available', async t => {
  const f = await fixture(t);
  await f.edit(f.a.path, 'Durable handoff');
  const proposal = (await f.local.observe('alice', f.a.id))!;
  let denied = true, admissions = 0, sends = 0;
  const replica = new WorkspaceContentReplica(f.db, f.files, (bytes, write) => {
    admissions++; assert.ok(bytes >= 8 * 1024 * 1024);
    if (denied) throw Error('low-space');
    return write();
  });
  const endpoint = { ...f.endpoint, propose: async (...args: Parameters<typeof f.endpoint.propose>) => { sends++; return f.endpoint.propose(...args); } };
  await assert.rejects(replica.claimPublish('alice', f.a.id, proposal.proposal.mutationId), /low-space/);
  await assert.rejects(replica.publish('alice', f.a.id, proposal.proposal.mutationId, endpoint), /low-space/);
  assert.equal(sends, 0);
  assert.equal((await replica.view('alice', f.a.id)).proposals[0]!.state, 'prepared');
  denied = false;
  assert.equal((await replica.claimPublish('alice', f.a.id, proposal.proposal.mutationId)).claimed, true);
  denied = true; const before = admissions;
  assert.equal((await replica.claimPublish('alice', f.a.id, proposal.proposal.mutationId)).claimed, false);
  assert.equal((await replica.publish('alice', f.a.id, proposal.proposal.mutationId, endpoint)).state, 'unknown');
  assert.equal(admissions, before); assert.equal(sends, 0);
  const receipt = await f.endpoint.propose('board', proposal.proposal);
  assert.equal((await replica.settle('alice', f.a.id, proposal.proposal.mutationId, receipt)).state, 'committed');
  assert.equal(admissions, before);
});

test('same production effects await every metadata and file read across the complete proposal/projection chain', async t => {
  const f = await fixture(t);
  const journal = new WorkspaceContentMetadata(f.db,f.files);
  const asyncMethods = <T extends object>(target: T) => new Proxy(target,{get(object,key) {
    const value: unknown = Reflect.get(object,key);
    return typeof value === 'function' ? async (...args: unknown[]) => {
      await new Promise<void>(resolve => setImmediate(resolve)); return Reflect.apply(value,object,args);
    } : value;
  }});
  // The fake boundary delays every read as a worker would; SQL still runs only
  // in the original journal. This is not a claim of production worker cutover.
  const local = new WorkspaceContentEffects(asyncMethods(journal) as WorkspaceContentMetadataPort<Parameters<typeof f.files.write>[2]['content'],string>,
    asyncMethods(f.files));
  await f.edit(f.a.path,'Async local draft');
  const proposal = (await local.observe('alice',f.a.id))!;
  const claimed = await local.claimPublish('alice',f.a.id,proposal.proposal.mutationId); assert.equal(claimed.claimed,true);
  const receipt = await f.endpoint.propose('board',claimed.local.proposal);
  const settled = await local.settle('alice',f.a.id,proposal.proposal.mutationId,receipt); assert.equal(settled.state,'committed');
  const job = f.claim(); assert.equal((await local.project('alice',f.b.id,job)).state,'saved');
  await f.edit(f.b.path,'Later independent edit');
  assert.equal((await local.projectionReceipt('alice',f.b.id,job)).state,'saved');
  assert.equal((await local.project('alice',f.b.id,job)).state,'saved');
  assert.ok((await readFile(f.b.path,'utf8')).includes('Later independent edit'));
  const view = await local.view('alice',f.a.id); assert.equal(view.proposals[0]!.state,'committed');
});

test('settlement rereads immutable original receipt across separate production compositions',async t => {
  const f = await fixture(t); await f.edit(f.a.path,'Retained conflict');
  const local = (await f.local.observe('alice',f.a.id))!;
  await f.local.claimPublish('alice',f.a.id,local.proposal.mutationId);
  const peer = new WorkspaceContentReplica(f.db,f.files);
  const original = await f.endpoint.propose('board',local.proposal);
  await peer.settle('alice',f.a.id,local.proposal.mutationId,original);
  await assert.rejects(f.local.settle('alice',f.a.id,local.proposal.mutationId,{...original,hash:'a'.repeat(64)}),/immutable-receipt/);
  assert.deepEqual(f.local.proposals('alice',f.a.id)[0]!.receipt,original);
  assert.deepEqual((await peer.settle('alice',f.a.id,local.proposal.mutationId,original)).receipt,original);
});

test('two real session files compose proposal/CAS/projection and do not echo system writes', async t => {
  const f = await fixture(t), { p, result } = await f.publish();
  assert.equal(result.state, 'committed');
  f.hub.acknowledgeProposal('alice', 'board', f.a.id, f.a.generation, p.proposal.mutationId, result.receipt!.hash);
  const job = f.claim(), projected = await f.local.project('alice', f.b.id, job);
  assert.equal(projected.state, 'saved');
  f.hub.acknowledgeProjection('alice', 'board', job.id, projected.hash!);
  assert.equal(JSON.parse(await readFile(f.b.path, 'utf8')).title, 'Changed');
  assert.equal(await f.local.observe('alice', f.a.id), undefined);
  assert.equal(await f.local.observe('alice', f.b.id), undefined);
  assert.deepEqual(await f.local.project('alice', f.b.id, job), projected, 'lost ACK uses original file receipt');
  assert.deepEqual(await f.local.install('alice', f.a.input), f.base, 'install retry does not reset advanced base');
});
test('concurrent local drafts produce a retained three-way conflict and block projections', async t => {
  const f = await fixture(t);
  await f.edit(f.a.path, 'A'); await f.edit(f.b.path, 'B');
  const a = (await f.local.observe('alice', f.a.id))!, b = (await f.local.observe('alice', f.b.id))!;
  await f.local.publish('alice', f.a.id, a.proposal.mutationId, f.endpoint);
  const conflict = await f.local.publish('alice', f.b.id, b.proposal.mutationId, f.endpoint);
  assert.equal(conflict.state, 'conflict'); assert.equal(conflict.baseContent, f.base.content);
  assert.equal(JSON.parse(conflict.proposal.content).title, 'B');
  await assert.rejects(f.local.project('alice', f.b.id, f.claim()), /pending-proposal/);
  assert.equal(JSON.parse(await readFile(f.b.path, 'utf8')).title, 'B');
  assert.equal((await f.local.observe('alice', f.b.id))!.proposal.mutationId, b.proposal.mutationId);
});
async function conflicted(t: TestContext) {
  const f = await fixture(t);
  await f.edit(f.b.path, 'Local');
  const draft = (await f.local.observe('alice', f.b.id))!;
  await f.publish('Remote');
  const conflict = await f.local.publish('alice', f.b.id, draft.proposal.mutationId, f.endpoint);
  const base = f.hub.resource('alice', 'board')!;
  const request = { conflictId: draft.proposal.mutationId, mutationId: randomUUID(), base,
    expectedHash: createHash('sha256').update(draft.proposal.content).digest('hex') };
  return { f, conflict, request };
}
test('explicit conflict resolution retains original evidence and resumes observation after CAS', async t => {
  const { f, conflict, request } = await conflicted(t);
  const before = await readFile(f.b.path, 'utf8');
  const next = await f.local.resolve('alice', f.b.id, request);
  assert.equal(await readFile(f.b.path, 'utf8'), before, 'resolution never writes the file');
  assert.equal(next.baseContent, request.base.content);
  assert.equal(next.proposal.content, conflict.proposal.content);
  assert.deepEqual(f.local.proposals('alice', f.b.id)[0], { ...conflict, resolvedBy: request.mutationId });
  assert.deepEqual(await f.local.observe('alice', f.b.id), next);
  const committed = await f.local.publish('alice', f.b.id, request.mutationId, f.endpoint);
  assert.equal(committed.state, 'committed');
  assert.equal(await f.local.observe('alice', f.b.id), undefined);
  await f.edit(f.b.path, 'Newer local edit');
  await f.reopen();
  assert.deepEqual(await f.local.resolve('alice', f.b.id, request), committed, 'lost ACK returns original, not a new draft');
  assert.equal(JSON.parse((await f.local.observe('alice', f.b.id))!.proposal.content).title, 'Newer local edit');
  assert.equal(f.local.proposals('alice', f.b.id).length, 3);
});
test('resolution fences changed file, wrong base, reused requests and unknown outcomes', async t => {
  const { f, request } = await conflicted(t);
  for (const base of [{ ...request.base, revision: request.base.revision + 1 },
    { ...request.base, epoch: 'other' }, { ...request.base, content: f.base.content }]) {
    await assert.rejects(f.local.resolve('alice', f.b.id, { ...request, base }), /resolution-proof/);
  }
  await f.edit(f.b.path, 'Changed after dialog');
  await assert.rejects(f.local.resolve('alice', f.b.id, request), /resolution-dirty/);
  assert.equal(f.local.proposals('alice', f.b.id).length, 1);
  await f.edit(f.b.path, 'Local');
  await f.local.resolve('alice', f.b.id, request);
  await assert.rejects(f.local.resolve('alice', f.b.id, { ...request, mutationId: randomUUID() }), /pending-proposal/);
  await assert.rejects(f.local.resolve('alice', f.b.id, { ...request, expectedHash: 'a'.repeat(64) }), /resolution-reused/);
  const unknown = await f.local.publish('alice', f.b.id, request.mutationId,
    { ...f.endpoint, propose: async () => { throw Error('transport unknown'); } });
  assert.equal(unknown.state, 'unknown');
  await assert.rejects(f.local.resolve('alice', f.b.id,
    { ...request, conflictId: request.mutationId, mutationId: randomUUID() }), /resolution-proof/);
  assert.equal(f.local.proposals('alice', f.b.id).length, 2);
});
test('resolution uses another CAS, so intervening Hub updates produce a new retained conflict', async t => {
  const { f, request } = await conflicted(t);
  await f.publish('Remote advanced again');
  const next = await f.local.resolve('alice', f.b.id, request);
  const outcome = await f.local.publish('alice', f.b.id, next.proposal.mutationId, f.endpoint);
  assert.equal(outcome.state, 'conflict');
  assert.equal(f.local.proposals('alice', f.b.id).length, 2);
  assert.equal(JSON.parse(await readFile(f.b.path, 'utf8')).title, 'Local');
  assert.deepEqual(await f.local.observe('alice', f.b.id), outcome);
});
test('revocation fences conflict reconciliation without dropping the local file', async t => {
  const { f, request } = await conflicted(t);
  await f.local.revoke('alice', f.b.id);
  await assert.rejects(f.local.resolve('alice', f.b.id, request), /replica-unavailable/);
});
test('lost proposal response is recovered by original identity without a second send', async t => {
  const f = await fixture(t); let sends = 0;
  await f.edit(f.a.path, 'Lost response'); const p = (await f.local.observe('alice', f.a.id))!;
  const endpoint = { ...f.endpoint, propose: async (...args: Parameters<ContentProposalEndpoint['propose']>) => {
    sends++; await f.endpoint.propose(...args); throw Error('lost response');
  } };
  assert.equal((await f.local.publish('alice', f.a.id, p.proposal.mutationId, endpoint)).state, 'unknown');
  await f.reopen();
  const reopened = f.local;
  assert.equal((await reopened.publish('alice', f.a.id, p.proposal.mutationId, endpoint)).state, 'unknown');
  assert.equal((await reopened.recover('alice', f.a.id, p.proposal.mutationId, endpoint)).state, 'committed');
  assert.equal(sends, 1);
});
test('file changes after proposal snapshot stay dirty and become a distinct next proposal', async t => {
  const f = await fixture(t); await f.edit(f.a.path, 'First');
  const p = (await f.local.observe('alice', f.a.id))!; await f.edit(f.a.path, 'Second');
  await f.local.publish('alice', f.a.id, p.proposal.mutationId, f.endpoint);
  const next = (await f.local.observe('alice', f.a.id))!;
  assert.notEqual(next.proposal.mutationId, p.proposal.mutationId);
  assert.equal(next.proposal.baseRevision, 1); assert.equal(JSON.parse(next.proposal.content).title, 'Second');
});
test('unobserved dirty target is never overwritten by a real projection', async t => {
  const f = await fixture(t); await f.publish(); await f.edit(f.b.path, 'Private dirty');
  const result = await f.local.project('alice', f.b.id, f.claim());
  assert.equal(result.state, 'conflict'); assert.equal(result.hash, null);
  assert.equal(JSON.parse(await readFile(f.b.path, 'utf8')).title, 'Private dirty');
});
test('revoked or foreign replicas cannot expose drafts, install again, or project', async t => {
  const f = await fixture(t); await f.publish(); const job = f.claim();
  await assert.rejects(f.local.observe('bob', f.a.id), /unavailable/);
  await f.local.revoke('alice', f.b.id);
  await assert.rejects(f.local.project('alice', f.b.id, job), /unavailable/);
  await assert.rejects(f.local.install('alice', f.b.input), /reused/);
  assert.equal(JSON.parse(await readFile(f.b.path, 'utf8')).title, 'Original');
});
test('malformed original proof stays unknown; missing receipt does not free or retry proposal', async t => {
  const f = await fixture(t); await f.edit(f.a.path, 'Draft'); const p = (await f.local.observe('alice', f.a.id))!;
  const endpoint: ContentProposalEndpoint = { propose: async () => ({ mutationId: p.proposal.mutationId,
    fingerprint: 'wrong', state: 'committed', revision: 1, hash: '0'.repeat(64) }), original: async () => undefined };
  assert.equal((await f.local.publish('alice', f.a.id, p.proposal.mutationId, endpoint)).state, 'unknown');
  assert.equal((await f.local.recover('alice', f.a.id, p.proposal.mutationId, endpoint)).state, 'unknown');
  assert.equal(f.hub.resource('alice', 'board')!.revision, 0);
});
test('existing legacy files cannot be adopted as v2 replicas', async t => {
  const f = await fixture(t), id = randomUUID(), sessionKey = `codex:${randomUUID()}`;
  await f.files.install('alice', { id, sessionKey, content: { title: 'Legacy', tasks: [] } });
  await assert.rejects(f.local.install('alice', { ...f.a.input, id, sessionKey }), /legacy-binding/);
  assert.equal(JSON.parse(await readFile(f.files.get('alice', id).path, 'utf8')).title, 'Legacy');
});
test('physical reopen recovers projection original receipt without rewriting later edits', async t => {
  const f = await fixture(t); await f.publish(); const job = f.claim();
  const result = await f.local.project('alice', f.b.id, job);
  await f.edit(f.b.path, 'Newer local work'); await f.reopen();
  assert.deepEqual(await f.local.project('alice', f.b.id, job), result);
  assert.equal(JSON.parse(await readFile(f.b.path, 'utf8')).title, 'Newer local work');
  assert.equal((await f.local.observe('alice', f.b.id))!.proposal.baseRevision, job.revision);
});
test('crash after projection intent but before file write stays uncertain, never replays', async t => {
  const f = await fixture(t); await f.publish(); const job = f.claim();
  f.files.write = async () => { throw Error('crash before file IO'); };
  await assert.rejects(f.local.project('alice', f.b.id, job), /crash/);
  await f.reopen();
  assert.equal((await f.local.project('alice', f.b.id, job)).state, 'uncertain');
  assert.equal(JSON.parse(await readFile(f.b.path, 'utf8')).title, 'Original');
});
test('installation retry ignores JSON property order, but never adopts a different target', async t => {
  const f = await fixture(t), { id, sessionKey, generation, resource, base } = f.a.input;
  assert.deepEqual(await f.local.install('alice', { base: { content: base.content, hash: base.hash, revision: base.revision, epoch: base.epoch }, sessionKey, generation, resource, id }), base);
  await assert.rejects(f.local.install('alice', { ...f.a.input, sessionKey: `codex:${randomUUID()}` }), /reused/);
});

for (const text of ['\\'.repeat(50000), '汉'.repeat(50000)]) {
  test(`full legal notebook survives Hub journal and real Connector file (${text[0]})`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'content-card-replica-'));
    const db = new DatabaseSync(':memory:'), hubDb = new DatabaseSync(':memory:');
    const codec = cardFileCodec('notebook');
    const files = new ConnectorWorkspaceFiles(db, root, owner => owner === 'alice', codec);
    t.after(async () => { await files.close(); db.close(); hubDb.close(); await rm(root, { recursive: true, force: true }); });
    const canonical = (value: string) => {
      const input: unknown = JSON.parse(value);
      if (!codec.valid(input)) throw Error('schema');
      return JSON.stringify(codec.parse(Buffer.from(codec.serialize(input)))!.content);
    };
    const hub = new ContentProposalStore(hubDb, canonical, owner => owner === 'alice');
    const card: WorkspaceFileCard = { kind: 'notebook', content: { title: 'Full notebook', text } };
    const base = hub.initialize('alice', 'notebook', 'epoch', canonical(JSON.stringify(card)));
    const binding = hub.bind('alice', 'notebook', randomUUID(), 'authority');
    const local = new WorkspaceContentReplica(db, files);
    await local.install('alice', { id: binding.id, resource: 'notebook', generation: binding.generation,
      sessionKey: `codex:${randomUUID()}`, base });
    assert.equal(JSON.parse(await readFile(files.get('alice', binding.id).path, 'utf8')).content.text, text);
    assert.equal(await local.observe('alice', binding.id), undefined);
    assert.throws(() => hub.initialize('alice', 'oversized', 'epoch', JSON.stringify({ kind: 'notebook', content: { title: 'Too big', text: text + 'x' } })), /schema/);
    assert.throws(() => hub.initialize('alice', 'overserialized', 'epoch', ' '.repeat(codec.maxBytes + 1)), /capacity/);
    const archived = { ...card, content: { ...card.content, archive: 'Real cold archive' } };
    const archivedHead = hub.initialize('alice', 'with-archive', 'epoch', canonical(JSON.stringify(archived)));
    assert.equal(JSON.parse(archivedHead.content).content.archive, 'Real cold archive');
    assert.throws(() => hub.initialize('alice', 'wrong-field', 'epoch', JSON.stringify({ ...card, content: { ...card.content, archive: 1 } })), /schema/);
    assert.throws(() => hub.initialize('alice', 'oversized-archive', 'epoch', JSON.stringify({ ...card, content: { ...card.content, archive: 'x'.repeat(100_001) } })), /schema/);
  });
}

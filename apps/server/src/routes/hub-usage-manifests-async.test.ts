import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import type { DelegationMember } from '../hub/workspace-delegation-preview.js';
import { asyncVolumeAdmission } from '../storage/async-volume-admission.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubUsageManifests } from './hub-usage-manifests.js';
import { DatabaseSync } from 'node:sqlite';
import { NativeTokenUsageStore } from '../connector/native-token-usage.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-usage-async-http-'));
  const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono(); let storeClosed = false;
  const owner = hub.createUser('Synthetic owner').id;
  hub.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://synthetic.invalid' });
  const nodeId = 'node_' + randomUUID(); hub.pinConnectionNode('dev', owner, hub.connectionAuthority('dev', owner)!, nodeId);
  const member: DelegationMember = { owner, nodeId, connectionId: 'dev', runtime: 'codex', sessionId: encodeHubSessionId('dev', 'codex:synthetic'),
    authorityEpoch: hub.connectionAuthority('dev', owner)!, groupId: null, tags: [], taskBinding: 'unknown' };
  const calls: string[] = []; let principal = owner;
  const routes = registerHubUsageManifests(app, { hubStore: hub, principal: () => ({ userId: principal, admin: false }),
    connectorClient: (() => ({ json: async (_path: string, options: { method?: string }) => { calls.push(options.method ?? 'GET'); throw Error('private offline transport'); } })) as any,
    directory: { fence: () => ({ generation: 1, preferencesRevision: 0 }), enumerate: async () => ({ complete: true, members: [member] }), authorized: () => true } });
  const input = { requestId: randomUUID(), from: 0, to: 60000, bucketMs: 60000, tags: [], tagMode: 'all' as const };
  const closeStore = () => { if (!storeClosed) { storeClosed = true; hub.close(); } };
  t.after(() => { routes.close(); closeStore(); rmSync(root, { recursive: true, force: true }); });
  return { hub, owner, member, input, calls, routes, closeStore, file: join(root, 'hub.sqlite'),
    revoke: () => hub.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Revoked', connectorUrl: 'https://synthetic.invalid', status: 'disabled' }),
    changePrincipal: () => { principal = 'other'; },
    prepare: () => hub.usageManifests.prepareAsync(owner, input, 'synthetic-directory', [member]),
    request: (method: string, path = '', body?: unknown, signal?: AbortSignal) => app.request(new Request('http://localhost/api/hub/v1/usage-manifests' + path,
      { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) })) };
}

test('runtime preview uses asynchronous physical admission and keeps snapshot dispatch separate', async t => {
  const f = fixture(t); let admissions = 0;
  t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => { admissions++; return write(); });
  assert.throws(()=>f.hub.usageManifests.prepare(f.owner,f.input,'synthetic-directory',[f.member]),/async-admission-required/);
  assert.equal(admissions,0);assert.equal(f.hub.usageManifests.read(f.owner,f.input.requestId),undefined);
  const response = await f.request('POST', '', f.input); assert.equal(response.status, 201);
  assert.equal(admissions, 1); assert.deepEqual(f.calls, []);
  assert.equal((await f.request('POST', '', f.input)).status, 200); assert.equal(admissions, 1);
});

for (const reason of ['route-closed', 'store-closed', 'request-aborted', 'principal-changed', 'revoked', 'cancelled'] as const) {
  test(`HTTP preview ${reason} while admission waits cannot create or dispatch`, async t => {
    const f = fixture(t), entered = gate(), release = gate(), controller = new AbortController();
    t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
      entered.release(); await release.promise; return write();
    });
    const pending = f.request('POST', '', f.input, controller.signal); await entered.promise;
    if (reason === 'route-closed') f.routes.close(); if (reason === 'store-closed') f.closeStore();
    if (reason === 'request-aborted') controller.abort(); if (reason === 'principal-changed') f.changePrincipal();
    if (reason === 'revoked') f.revoke(); if (reason === 'cancelled') f.hub.usageManifests.cancel(f.owner, f.input.requestId);
    release.release(); assert.ok((await pending).status >= 400); assert.deepEqual(f.calls, []);
    if (reason !== 'store-closed') assert.equal(f.hub.usageManifests.read(f.owner, f.input.requestId), undefined);
  });
}

test('lost preview release ACK returns original receipt on retry without another admission', async t => {
  const f = fixture(t); let admissions = 0;
  t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
    admissions++; await write(); throw Error('private lost release');
  });
  assert.equal((await f.request('POST', '', f.input)).status, 409);
  const original = f.hub.usageManifests.read(f.owner, f.input.requestId)!;
  assert.equal((await f.request('POST', '', f.input)).status, 200); assert.equal(admissions, 1);
  assert.deepEqual(f.hub.usageManifests.read(f.owner, f.input.requestId), original); assert.deepEqual(f.calls, []);
});

test('child lost release ACK never posts; recovery remains GET-only and continuation never reclaims', async t => {
  const f = fixture(t); await f.prepare(); f.hub.usageManifests.confirm(f.owner, f.input.requestId); let admissions = 0;
  const child=f.hub.usageManifests.read(f.owner,f.input.requestId)!.members[0]!.requestId;
  assert.throws(()=>f.hub.usageManifests.claim(f.owner,f.input.requestId,child),/async-admission-required/);
  assert.equal(f.hub.usageManifests.read(f.owner,f.input.requestId)!.members[0]!.state,'prepared');
  const logs: Record<string, unknown>[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
  t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
    admissions++; await write(); throw Error('private lost release');
  });
  assert.equal((await f.request('POST', `/${f.input.requestId}/continue`, {})).status, 409);
  assert.equal(f.hub.usageManifests.read(f.owner, f.input.requestId)!.members[0]!.state, 'unknown'); assert.deepEqual(f.calls, []);
  assert.equal((await f.request('GET', `/${f.input.requestId}`)).status, 200); assert.deepEqual(f.calls, ['GET']);
  assert.equal((await f.request('POST', `/${f.input.requestId}/continue`, {})).status, 200);
  assert.equal(admissions, 1); assert.deepEqual(f.calls, ['GET']);
  assert.equal(logs.find(row => row.operation === 'usage-manifest-admission' && row.category === 'failed')?.unknown, 1);
  assert.equal(logs.find(row => row.operation === 'usage-manifest-collection' && row.category === 'routine')?.unknown, 1);
  for (const secret of [f.input.requestId, f.member.sessionId, 'private', 'synthetic.invalid']) assert.equal(JSON.stringify(logs).includes(secret), false);
});

for (const reason of ['route-closed', 'store-closed', 'request-aborted', 'principal-changed', 'revoked'] as const) {
  test(`HTTP child ${reason} while admission waits never posts a snapshot`, async t => {
    const f = fixture(t); const original = await f.prepare(); f.hub.usageManifests.confirm(f.owner, f.input.requestId);
    const entered = gate(), release = gate(), controller = new AbortController();
    t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
      entered.release(); await release.promise; return write();
    });
    const pending = f.request('POST', `/${f.input.requestId}/continue`, {}, controller.signal); await entered.promise;
    if (reason === 'route-closed') f.routes.close(); if (reason === 'store-closed') f.closeStore();
    if (reason === 'request-aborted') controller.abort(); if (reason === 'principal-changed') f.changePrincipal(); if (reason === 'revoked') f.revoke();
    release.release(); assert.ok((await pending).status >= 400); assert.deepEqual(f.calls, []);
    if (!['revoked', 'store-closed'].includes(reason)) assert.equal(f.hub.usageManifests.read(f.owner, f.input.requestId)!.members[0]!.state, 'prepared');
    assert.ok(original.members[0]!.requestId);
  });
}

test('HTTP child cancellation after write but before release acknowledgment preserves UNKNOWN without POST', async t => {
  const f = fixture(t); await f.prepare(); f.hub.usageManifests.confirm(f.owner, f.input.requestId);
  const controller = new AbortController();
  t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
    const result = await write(); controller.abort(); return result;
  });
  assert.equal((await f.request('POST', `/${f.input.requestId}/continue`, {}, controller.signal)).status, 409);
  assert.equal(f.hub.usageManifests.read(f.owner, f.input.requestId)!.members[0]!.state, 'unknown'); assert.deepEqual(f.calls, []);
  assert.equal((await f.request('GET', `/${f.input.requestId}`)).status, 200); assert.deepEqual(f.calls, ['GET']);
});

for (const operation of ['preview', 'child'] as const) {
  test(`HTTP ${operation} store closed after commit returns failure and retains the original receipt`, async t => {
    const f = fixture(t);
    if (operation === 'child') { await f.prepare(); f.hub.usageManifests.confirm(f.owner, f.input.requestId); }
    const logs: Record<string, unknown>[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
    t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
    let committed: unknown;
    t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
      const result = await write(); committed = f.hub.usageManifests.read(f.owner, f.input.requestId);
      f.closeStore(); return result;
    });
    const response = operation === 'child'
      ? await f.request('POST', `/${f.input.requestId}/continue`, {})
      : await f.request('POST', '', f.input);
    assert.ok(response.status >= 400); assert.deepEqual(f.calls, []);
    assert.equal(logs.find(row => row.operation === 'usage-manifest-admission' && row.category === 'failed')?.unknown, 1);
    const reopened = new HubStore(f.file, 'synthetic');
    try {
      const receipt = reopened.usageManifests.read(f.owner, f.input.requestId)!;
      assert.deepEqual(receipt, committed);
      assert.equal(operation === 'child' ? receipt.members[0]!.state : receipt.state, operation === 'child' ? 'unknown' : 'prepared');
      if (operation === 'child') assert.equal(await reopened.usageManifests.claimAsync(f.owner, f.input.requestId, receipt.members[0]!.requestId), false);
    } finally { reopened.close(); }
  });
}

test('HTTP preview cancelled during release cannot report a prepared preview', async t => {
  const f = fixture(t);
  t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
    const result = await write(); f.hub.usageManifests.cancel(f.owner, f.input.requestId); return result;
  });
  assert.equal((await f.request('POST', '', f.input)).status, 409);
  assert.equal(f.hub.usageManifests.read(f.owner, f.input.requestId)!.state, 'cancelled'); assert.deepEqual(f.calls, []);
  const recovered = await f.request('GET', `/${f.input.requestId}`);
  assert.equal(recovered.status, 200); assert.equal((await recovered.json()).cancelled, true);
});

test('HTTP child completed during release returns the recovered total without a second POST', async t => {
  const f = fixture(t), original = await f.prepare(); f.hub.usageManifests.confirm(f.owner, f.input.requestId);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const child = original.members[0]!.requestId, ledger = new NativeTokenUsageStore(db, () => 1000);
  const snapshot = ledger.snapshot('codex', 'codex:synthetic', child, 0, 60000, 60000);
  t.mock.method(asyncVolumeAdmission, 'run', async (_root: string, _kind: string, _bytes: number, write: () => Promise<unknown>) => {
    const result = await write(); f.hub.usageManifests.record(f.owner, f.input.requestId, child, snapshot); return result;
  });
  const response = await f.request('POST', `/${f.input.requestId}/continue`, {});
  assert.equal(response.status, 200); assert.equal((await response.json()).manifest.state, 'complete');
  assert.deepEqual(f.calls, []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HubStore } from './hub-store.js';
import { delegationDirectory } from './workspace-delegation-directory.js';
import { readDelegationCatalog } from './workspace-delegation-catalog.js';
import { encodeHubSessionId } from './session-id.js';
import type { ConnectorClientResolver } from './connector-client.js';
import { projectSessionDirectory } from '../projection/session-directory.js';
import type { SessionDirectoryQuery } from '@agentopsdeck/shared';

function fixture(t: { after: (fn: () => unknown) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'delegation-directory-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  store.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'https://connector.example' });
  store.pinConnectionNode('dev', 'default', store.connectionAuthority('dev')!, `node_${randomUUID()}`);
  const keys = Array.from({ length: 201 }, (_, i) => `codex:${String(i).padStart(3, '0')}`);
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true }); });
  const source = (read: (query: SessionDirectoryQuery, signal: AbortSignal) => unknown) => delegationDirectory(store,
    (() => ({ sessionDirectory: async (query: SessionDirectoryQuery, signal: AbortSignal) => read(query, signal) })) as unknown as ConnectorClientResolver);
  return { store, keys, source };
}
test('complete bounded pagination joins trusted preferences without asserting binding support', async t => {
  const f = fixture(t), calls: SessionDirectoryQuery[] = [], session = encodeHubSessionId('dev', f.keys[0]!);
  f.store.workspace.save('default', { revision: 0, groups: [], sessions: { [session]: { tags: ['review'] } } });
  const catalog = await readDelegationCatalog('default', f.source(q => { calls.push(q); return projectSessionDirectory(f.keys, q, 'stable'); }));
  assert.equal(catalog.members.length, 201); assert.equal(calls.length, 3);
  assert.deepEqual(catalog.members.find(m => m.sessionId === session)?.tags, ['review']);
  assert.ok(catalog.members.every(m => m.taskBinding === 'unknown'));
});
test('cross-page directory cursor change cannot certify a partial group', async t => {
  const f = fixture(t);
  await assert.rejects(readDelegationCatalog('default', f.source(q => projectSessionDirectory(f.keys, q, q.after ? 'changed' : 'first'))), /source-changed/);
});
test('connection authority revoked while enumerating cannot survive the final fence', async t => {
  const f = fixture(t);
  await assert.rejects(readDelegationCatalog('default', f.source(q => {
    f.store.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'https://replacement.example' });
    return projectSessionDirectory(['codex:a'], q, 'cursor');
  })), /forbidden|changed/);
});
test('OpenClaw entries without a runtime prefix remain discoverable but not grant-capable', async t => {
  const f = fixture(t);
  const catalog = await readDelegationCatalog('default', f.source(q => projectSessionDirectory(['agent:main:main'], q, 'cursor')));
  assert.equal(catalog.members[0]?.runtime, 'openclaw'); assert.equal(catalog.members[0]?.taskBinding, 'unknown');
});
test('unversioned or looping pages fail closed', async t => {
  const f = fixture(t);
  await assert.rejects(readDelegationCatalog('default', f.source(q => projectSessionDirectory([], q, ''))), /source-unavailable/);
  await assert.rejects(readDelegationCatalog('default', f.source(() => ({ sessions: [], nextCursor: 'same', sourceCursor: 'cursor' }))), /cursor-loop/);
});

test('delegation actual async directory and preferences never call main-thread document scans', async t => {
  const f = fixture(t);
  t.mock.method(f.store, 'listConnections', () => { throw Error('sync directory forbidden'); });
  t.mock.method(f.store.workspace, 'get', () => { throw Error('sync preferences forbidden'); });
  const catalog = await readDelegationCatalog('default', f.source(q => projectSessionDirectory(['codex:a'], q, 'cursor')));
  assert.equal(catalog.members.length, 1);
});

for (const phase of ['directory', 'preferences'] as const) for (const mutation of ['credential', 'disable', 'preferences'] as const) {
  test(`delegation rejects ${mutation} during ${phase} snapshot without remote dispatch`, async t => {
    const f = fixture(t); let remoteCalls = 0;
    const method = phase === 'directory' ? 'listConnectionsAsync' : 'workspacePreferencesAsync';
    const original = f.store[method].bind(f.store);
    t.mock.method(f.store, method, async (owner: string) => {
      const result = await original(owner);
      if (mutation === 'preferences') f.store.workspace.save(owner, { revision: 0, groups: [], sessions: {} });
      else f.store.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://connector.example',
        ...(mutation === 'disable' ? { status: 'disabled' as const } : { credentialToken: 'changed' }) });
      return result;
    });
    await assert.rejects(readDelegationCatalog('default', f.source(q => {
      remoteCalls++; return projectSessionDirectory(['codex:a'], q, 'cursor');
    })), /changed/);
    assert.equal(remoteCalls, 0);
  });
}

test('catalog cancellation during async snapshot never emits remote page or partial result', async t => {
  const f = fixture(t), abort = new AbortController(); let remoteCalls = 0;
  const original = f.store.listConnectionsAsync.bind(f.store);
  t.mock.method(f.store, 'listConnectionsAsync', async (owner: string) => {
    const result = await original(owner); abort.abort(); return result;
  });
  await assert.rejects(f.source(q => {
    remoteCalls++; return projectSessionDirectory(['codex:a'], q, 'cursor');
  }).enumerate('default', 5000, abort.signal));
  assert.equal(remoteCalls, 0);
});

test('preference CAS during remote pagination rejects full catalog rather than smaller successful grant', async t => {
  const f = fixture(t);
  await assert.rejects(readDelegationCatalog('default', f.source(q => {
    f.store.workspace.save('default', { revision: 0, groups: [], sessions: {} });
    return projectSessionDirectory(['codex:a'], q, 'cursor');
  })), /changed/);
});

test('constant-sized display fence never grants authority to fabricated members', async t => {
  const f = fixture(t), source = f.source(q => projectSessionDirectory(['codex:a'], q, 'cursor'));
  const catalog = await readDelegationCatalog('default', source), member = catalog.members[0]!;
  assert.equal(source.authorized('default', { ...member, authorityEpoch: member.authorityEpoch + 1 }), false);
  assert.equal(source.authorized('other', member), false);
  assert.equal(source.authorized('default', { ...member, nodeId: 'other' }), false);
  const before = source.fence('default');
  f.store.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'https://connector.example', status: 'disabled' });
  assert.notDeepEqual(source.fence('default'), before);
  assert.equal(source.authorized('default', member), false);
});

for (const change of ['credential', 'disable', 'preferences', 'abort'] as const)
  test(`held async Connector directory ${change} fences before any remote page`, async t => {
    const f = fixture(t), abort = new AbortController(); let pages = 0, release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const source = delegationDirectory(f.store, async (_id, _maintenance, owner, _grant, options, signal) => {
      assert.equal(owner, 'default'); assert.equal(options, undefined); assert.equal(signal, abort.signal); entered(); await hold;
      return { sessionDirectory: async () => { pages++; return projectSessionDirectory(['codex:a'], {}, 'stable'); } } as ReturnType<ConnectorClientResolver>;
    });
    const stopped = assert.rejects(source.enumerate('default', 5000, abort.signal));
    await reached;
    if (change === 'abort') abort.abort();
    else if (change === 'preferences') f.store.workspace.save('default', { revision: 0, groups: [], sessions: {} });
    else f.store.upsertConnection({ id: 'dev', label: 'Changed', connectorUrl: 'https://connector.example',
      ...(change === 'disable' ? { status: 'disabled' as const } : { credentialToken: 'synthetic-changed' }) });
    release(); await stopped; assert.equal(pages, 0);
  });

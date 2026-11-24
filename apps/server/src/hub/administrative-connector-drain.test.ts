import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubConnectorReadServices } from './connector-read-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const unavailable = (error: unknown) => (error as { status?: number })?.status === 503;
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

for (const phase of ['snapshot', 'open', 'check'] as const) {
  test(`production Connector authority ${phase} drains the original ACK and retires retained clients`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-original-drain-'));
    const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-vault');
    const original = new OriginalHubAdministrativeCommands(store, quiet);
    const entered = gate(), release = gate();
    let holding = false, calls = 0, remote = 0;
    const owner: Pick<AsyncHubMemberOwner, 'command'> = {
      command: (async (kind: string, input: { command?: { action?: string } }) => {
        calls++;
        const reply = await original.command(kind as never, input as never);
        if (holding && (phase === 'snapshot' ? kind === 'memberSnapshot'
          : kind === 'connectorAccess' && input.command?.action === phase)) {
          entered.resolve(); await release.promise;
        }
        return reply;
      }) as AsyncHubMemberOwner['command'],
    };
    const services = createHubConnectorReadServices(owner, { connectionId: 'local', token: 'isolated-local-token',
      dispatch: () => { remote++; return Response.json({ ok: true }); } }, quiet);
    try {
      store.upsertConnection({ id: 'local', kind: 'local', label: 'Local', connectorUrl: 'local://aod-connector' });
      const key = store.identities.issueKey('default');
      const request = new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` } });
      const retained = await services.connector(request, 'local');
      holding = true;
      const pending = assert.rejects(phase === 'check' ? retained.json('/health')
        : services.connector(request, 'local'), unavailable);
      await entered.promise;
      let closed = false;
      const closing = services.close(); assert.equal(services.close(), closing);
      void closing.then(() => { closed = true; });
      const before = calls;
      await assert.rejects(services.connector(request, 'local'), unavailable);
      await assert.rejects(retained.json('/health'), unavailable);
      await assert.rejects(services.directory.sessions(request, { ownerUserId: 'default', connectionId: 'local', grantId: 'missing' }), unavailable);
      await tick(); assert.equal(closed, false); assert.equal(calls, before); assert.equal(remote, 0);
      release.resolve(); await pending; await closing;
      assert.equal(closed, true); assert.equal(remote, 0);
      assert.equal(store.createUser('Original writer remains open').label, 'Original writer remains open');
    } finally { release.resolve(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('Connector authority read timeout does not release the original owner or finish close', async () => {
  const entered = gate(), release = gate();
  let calls = 0;
  const owner: Pick<AsyncHubMemberOwner, 'command'> = {
    command: (async () => { calls++; entered.resolve(); await release.promise; return null; }) as AsyncHubMemberOwner['command'],
  };
  const resolve = createAsyncConnectorClientResolver(owner, undefined, quiet, 10);
  try {
    const pending = assert.rejects(resolve(new Request('http://fixture.invalid/'), 'node'), unavailable);
    await entered.promise; await pending;
    let closed = false;
    const closing = resolve.close(); assert.equal(resolve.close(), closing);
    void closing.then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(calls, 1);
    await assert.rejects(resolve(new Request('http://fixture.invalid/'), 'node'), unavailable);
    assert.equal(calls, 1);
    release.resolve(); await closing; assert.equal(closed, true);
  } finally { release.resolve(); await resolve.close(); }
});

for (const phase of ['open', 'remote', 'project'] as const) {
  test(`production shared directory ${phase} retains original work until aggregate close`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'directory-original-drain-'));
    const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-vault');
    const original = new OriginalHubAdministrativeCommands(store, quiet);
    const entered = gate(), release = gate();
    let calls = 0, remote = 0;
    const owner: Pick<AsyncHubMemberOwner, 'command'> = {
      command: (async (kind: string, input: { command?: { action?: string } }) => {
        calls++;
        const reply = await original.command(kind as never, input as never);
        if (kind === 'sharedDirectory' && input.command?.action === phase) {
          entered.resolve(); await release.promise;
        }
        return reply;
      }) as AsyncHubMemberOwner['command'],
    };
    const node = 'node_' + randomUUID();
    const services = createHubConnectorReadServices(owner, { connectionId: 'local', token: 'PRIVATE_LOCAL_TOKEN',
      dispatch: async () => {
        remote++;
        if (phase === 'remote') { entered.resolve(); await release.promise; }
        return Response.json({ sessions: [{ sessionKey: 'codex:visible', runtime: 'codex' }],
          nextCursor: null, sourceCursor: 'fixture' },
        { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node } });
      } }, quiet);
    try {
      store.upsertConnection({ id: 'local', kind: 'local', label: 'Local', connectorUrl: 'local://aod-connector' });
      store.pinConnectionNode('local', 'default', store.connectionAuthority('local', 'default')!, node);
      const member = store.createUser('Recipient'), key = store.identities.issueKey(member.id);
      const grant = store.grants.create({ ownerUserId: 'default', connectionId: 'local', userId: member.id },
        { runtime: 'codex', actions: ['sessions:read'] });
      const target = { ownerUserId: 'default', connectionId: 'local', grantId: grant.id };
      const request = new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` } });
      const pending = assert.rejects(services.directory.sessions(request, target), unavailable);
      await entered.promise;
      let closed = false;
      const closing = services.close(); assert.equal(services.close(), closing);
      void closing.then(() => { closed = true; });
      const before = calls;
      await assert.rejects(services.directory.sessions(request, target), unavailable);
      await assert.rejects(services.connector(request, 'local'), unavailable);
      await tick(); assert.equal(closed, false); assert.equal(calls, before);
      assert.equal(remote, phase === 'open' ? 0 : 1);
      release.resolve(); await pending; await closing;
      assert.equal(closed, true); assert.equal(calls, before);
      assert.equal(store.createUser('Writer still open').label, 'Writer still open');
    } finally { release.resolve(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

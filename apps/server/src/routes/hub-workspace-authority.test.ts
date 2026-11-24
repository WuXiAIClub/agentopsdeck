import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import type { HubMemberCommands, HubMemberKind } from '../hub/member-owner-domain.js';
import { registerHubWorkspaceSync } from './hub-workspace-sync.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import type { ConnectorClientResolver, MessagesPage } from '../hub/connector-client.js';
import type { WorkspaceSyncFrame } from '@agentopsdeck/shared';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: test.TestContext, calibration: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-authority-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-authority-vault');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const original = new OriginalHubAdministrativeCommands(store, diagnostics);
  let intercept = async (_kind: HubMemberKind, work: () => unknown): Promise<unknown> => work();
  const commands: HubMemberKind[] = [];
  const owner = { command: <K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']) => {
    commands.push(kind); return intercept(kind, () => original.command(kind, input)) as Promise<HubMemberCommands[K]['output']>;
  } };
  const services = createHubAdministrativeServices(owner, diagnostics);
  const key = store.identities.issueKey('default');
  let actor = 'default', reads = 0, resolutions = 0;
  let resolveClient = async () => {};
  let read = async (): Promise<MessagesPage> => ({ messages: [{ id: 'secret', role: 'assistant',
    sessionKey: 'codex:one', text: 'PRIVATE history', createdAt: 1 }], totalCount: 1, hiddenCount: 0, updatedAt: 1 });
  let access: Pick<AsyncHubMemberRequests, 'begin'> = services.members;
  const app = new Hono();
  const connection = () => store.upsertConnection({ id: 'test', kind: 'remote', label: 'Fixture',
    connectorUrl: 'http://fixture.invalid', status: 'enabled', capabilities: ['messages'] });
  connection();
  registerHubWorkspaceSync(app, {
    store: new Proxy(store, { get(target, property, receiver) {
      if (property === 'getConnection' || property === 'connectionAuthority') return () => { throw Error('PRIVATE synchronous SQL fallback'); };
      return Reflect.get(target, property, receiver);
    } }),
    access: { begin: request => access.begin(request) },
    owner: () => { if (!actor) throw new HTTPException(401); return actor; },
    client: (() => { throw Error('PRIVATE synchronous client fallback'); }) as ConnectorClientResolver,
    asyncConnectorClient: async () => { resolutions++; await resolveClient(); return { messages: async () => { reads++; return read(); } } as unknown as ReturnType<ConnectorClientResolver>; },
    wrap: (message, sessionKey) => ({ ...message, sessionKey }),
  });
  const sessionKey = encodeHubSessionId('test', 'codex:one');
  const request = (signal?: AbortSignal, items = [{ sessionKey, limit: 200 }]) => app.request('/api/hub/v1/workspace/' + (calibration ? 'check' : 'sync'), {
    method: 'POST', headers: { authorization: 'Bearer ' + key.token, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, items }), ...(signal ? { signal } : {}),
  });
  t.after(async () => { await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, services, key, request, sessionKey, commands, logs, counts: () => ({ reads, resolutions }),
    setRead: (next: typeof read) => { read = next; }, setActor: (next: string) => { actor = next; },
    setAccess: (next: typeof access) => { access = next; }, setIntercept: (next: typeof intercept) => { intercept = next; },
    setResolve: (next: typeof resolveClient) => { resolveClient = next; } };
}
async function frame(response: Response) {
  assert.equal(response.status, 200); return JSON.parse((await response.text()).trim()) as WorkspaceSyncFrame;
}

for (const calibration of [false, true]) {
  test(`workspace ${calibration}: original awaited authority, no sync fallback, canonical etags`, async t => {
    const f = fixture(t, calibration), first = await frame(await f.request());
    assert.equal(first.status, 200); assert.ok(first.headers?.etag);
    assert.ok(f.commands.includes('connectionTarget')); assert.ok(f.commands.filter(kind => kind === 'memberSnapshot').length > 2);
    assert.deepEqual(f.counts(), { reads: 1, resolutions: 1 });
    assert.ok(f.logs.some(line => JSON.parse(line).step === 33), 'original authority lane emits bounded correlated diagnostics');
    assert.doesNotMatch(f.logs.join('\n'), /PRIVATE|hub_key_|authorization|credentialToken/);
    if (calibration) assert.deepEqual(first.body, { changed: true });
    else assert.match(JSON.stringify(first.body), /PRIVATE history/);
  });

  for (const change of ['connection', 'key', 'actor'] as const)
    test(`workspace ${calibration}: ${change} revocation during client resolution prevents history dispatch`, async t => {
      const f = fixture(t, calibration);
      f.setResolve(async () => {
        if (change === 'connection') f.store.upsertConnection({ id: 'test', label: 'Fixture', connectorUrl: 'http://fixture.invalid', status: 'disabled' });
        if (change === 'key') f.store.identities.revokeKey('default', f.key.id);
        if (change === 'actor') f.setActor('other');
      });
      const result = await frame(await f.request());
      assert.equal(result.status, change === 'connection' ? 403 : 401);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
      assert.deepEqual(f.counts(), { reads: 0, resolutions: 1 });
    });

  for (const change of ['connection', 'deleted', 'key', 'scope', 'actor'] as const)
    test(`workspace ${calibration}: ${change} revocation during history read blocks stale delivery`, async t => {
      const f = fixture(t, calibration), entered = deferred(), release = deferred();
      f.setRead(async () => { entered.resolve(); await release.promise; return { messages: [{ id: 'private', role: 'assistant',
        sessionKey: 'codex:one', text: 'PRIVATE history', createdAt: 1 }], totalCount: 1, hiddenCount: 0, updatedAt: 1 }; });
      const pending = f.request(); await entered.promise;
      if (change === 'connection') f.store.upsertConnection({ id: 'test', label: 'Fixture', connectorUrl: 'http://fixture.invalid', status: 'disabled' });
      if (change === 'deleted') f.store.deleteConnection('test');
      if (change === 'key') f.store.identities.revokeKey('default', f.key.id);
      if (change === 'scope') t.mock.method(f.store.identities, 'recoveryScope', () => 'a'.repeat(64));
      if (change === 'actor') f.setActor('other');
      release.resolve(); const result = await frame(await pending);
      assert.equal(result.status, change === 'connection' || change === 'deleted' ? 403 : 401);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    });

  for (const drift of ['scope', 'account', 'administrator'] as const)
    test(`workspace ${calibration}: ${drift} drift between initial and item pins prevents dispatch`, async t => {
      const f = fixture(t, calibration);
      let begins = 0;
      f.setAccess({ begin: async request => {
        const scope = await f.services.members.begin(request);
        if (++begins === 1) return scope;
        return { ...scope, ...(drift === 'scope' ? { recoveryScope: 'a'.repeat(64) }
          : { principal: { ...scope.principal, ...(drift === 'account' ? { userId: 'other' } : { admin: !scope.principal.admin }) } }) };
      } });
      const result = await frame(await f.request());
      assert.equal(result.status, 401); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
      assert.deepEqual(f.counts(), { reads: 0, resolutions: 0 });
      assert.equal(f.commands.includes('connectionTarget'), false);
    });

  for (const unavailable of ['initial', 'malformed', 'item', 'target', 'closed'] as const)
    test(`workspace ${calibration}: ${unavailable} authority refusal never falls back or dispatches history`, async t => {
      const f = fixture(t, calibration);
      if (unavailable === 'initial') f.setAccess({ begin: async () => { throw Error('PRIVATE owner failure'); } });
      if (unavailable === 'malformed') f.setAccess({ begin: async () => undefined as never });
      if (unavailable === 'item') {
        let begins = 0;
        f.setAccess({ begin: async request => ++begins === 1 ? f.services.members.begin(request) : undefined as never });
      }
      if (unavailable === 'target') f.setIntercept(async (kind, work) => { if (kind === 'connectionTarget') throw Error('PRIVATE SQL failure'); return work(); });
      if (unavailable === 'closed') await f.services.members.close();
      const response = await f.request();
      const result = response.status === 200 ? await frame(response) : { status: response.status, body: await response.json() };
      assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
      assert.deepEqual(f.counts(), { reads: 0, resolutions: 0 });
    });

  test(`workspace ${calibration}: disabled and foreign connections do not dispatch history`, async t => {
    const f = fixture(t, calibration);
    f.store.upsertConnection({ id: 'test', label: 'Fixture', connectorUrl: 'http://fixture.invalid', status: 'disabled' });
    assert.equal((await frame(await f.request())).status, 404);
    assert.equal((await frame(await f.request(undefined, [{ sessionKey: encodeHubSessionId('foreign', 'codex:one'), limit: 200 }]))).status, 404);
    assert.deepEqual(f.counts(), { reads: 0, resolutions: 0 });
  });

  test(`workspace ${calibration}: one failed authority target does not suppress a healthy item`, async t => {
    const f = fixture(t, calibration); let targets = 0;
    f.setIntercept(async (kind, work) => {
      if (kind === 'connectionTarget' && ++targets === 1) throw new HubMemberRequestError(503);
      return work();
    });
    const response = await f.request(undefined, [{ sessionKey: f.sessionKey, limit: 200 },
      { sessionKey: encodeHubSessionId('test', 'codex:two'), limit: 200 }]);
    assert.equal(response.status, 200);
    const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as WorkspaceSyncFrame);
    assert.deepEqual(frames.map(item => item.status).sort(), [200, 503]);
    assert.deepEqual(f.counts(), { reads: 1, resolutions: 1 });
  });

  test(`workspace ${calibration}: cancellation during target lookup cannot dispatch a late grant`, async t => {
    const f = fixture(t, calibration), entered = deferred(), release = deferred(), controller = new AbortController();
    f.setIntercept(async (kind, work) => { if (kind === 'connectionTarget') { entered.resolve(); await release.promise; } return work(); });
    const pending = f.request(controller.signal); await entered.promise; controller.abort(); release.resolve();
    const response = await pending; assert.doesNotMatch(await response.text().catch(() => ''), /PRIVATE/);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(f.counts(), { reads: 0, resolutions: 0 });
  });

  test(`workspace ${calibration}: final buffered delivery rechecks authority and abort after awaited proof`, async t => {
    const f = fixture(t, calibration), entered = deferred(), release = deferred(), controller = new AbortController();
    const actual = f.services.members;
    let checks = 0;
    f.setAccess({ begin: async request => {
      const scope = await actual.begin(request);
      return { ...scope, connection: async id => {
        const target = await scope.connection(id);
        return { ...target, check: async () => {
          await target.check();
          if (++checks === 5) { entered.resolve(); await release.promise; }
        } };
      } };
    } });
    const pending = f.request(controller.signal); await entered.promise; controller.abort(); release.resolve();
    const response = await pending; assert.doesNotMatch(await response.text().catch(() => ''), /PRIVATE/);
    assert.deepEqual(f.counts(), { reads: 1, resolutions: 1 }); assert.equal(checks, 5);
  });

  test(`workspace ${calibration}: buffered successful frame is replaced after final authority revocation`, async t => {
    const f = fixture(t, calibration), entered = deferred(), release = deferred();
    let checks = 0;
    f.setAccess({ begin: async request => {
      const scope = await f.services.members.begin(request);
      return { ...scope, connection: async id => {
        const target = await scope.connection(id);
        return { ...target, check: async () => {
          if (++checks === 5) { entered.resolve(); await release.promise; }
          await target.check();
        } };
      } };
    } });
    const pending = f.request(); await entered.promise;
    f.store.identities.revokeKey('default', f.key.id); release.resolve();
    const result = await frame(await pending);
    assert.equal(result.status, 401); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.deepEqual(f.counts(), { reads: 1, resolutions: 1 }); assert.equal(checks, 5);
  });
}

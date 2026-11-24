import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import type { HubMemberKind, HubMemberCommands } from '../hub/member-owner-domain.js';
import type { AsyncHubMemberRequests } from '../hub/async-member-request.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { proxyHubConnectorUserMutation } from './hub-connector-user-mutation.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: test.TestContext, method: 'POST' | 'PATCH', member = false) {
  const root = mkdtempSync(join(tmpdir(), 'connector-user-authority-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-authority-vault', [], 'isolated-administrator-key');
  const userId = member ? store.createUser('Member').id : 'default', key = store.identities.issueKey(userId);
  if (!member) (store as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(userId);
  store.upsertConnection({ id: 'target', ownerUserId: userId, kind: 'remote', label: 'Fixture', connectorUrl: 'http://fixture.invalid', status: 'enabled' });
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const original = new OriginalHubAdministrativeCommands(store, diagnostics), commands: HubMemberKind[] = [];
  let intercept = async (_kind: HubMemberKind, work: () => unknown): Promise<unknown> => work();
  const services = createHubAdministrativeServices({ command: <K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']) => {
    commands.push(kind); return intercept(kind, () => original.command(kind, input)) as Promise<HubMemberCommands[K]['output']>;
  } }, diagnostics);
  let actor = userId, resolutions = 0, effects = 0, access: Pick<AsyncHubMemberRequests, 'begin'> = services.members;
  let onResolve = async () => {}, onEffect = async () => {}, onPresent = () => {};
  const app = new Hono();
  app.onError((error, c) => error instanceof HTTPException ? error.getResponse() : c.json({ error: 'unexpected' }, 500));
  app.on(method, '/connections/:connectionId/connector-users' + (method === 'PATCH' ? '/:userId' : ''), c => proxyHubConnectorUserMutation(c, {
    store: { getConnection: () => { throw Error('PRIVATE synchronous connection fallback'); },
      connectionAuthority: () => { throw Error('PRIVATE synchronous epoch fallback'); },
      listUsersAsync: async () => { throw Error('PRIVATE legacy display fallback'); } },
    principal: () => ({ userId: actor, admin: !member }),
    connectorClient: (() => { throw Error('PRIVATE synchronous client fallback'); }) as ConnectorClientResolver,
    asyncConnectorClient: async () => {
      resolutions++; await onResolve();
      return { jsonResponse: async (path: string, input: RequestInit) => {
        assert.equal(path, method === 'PATCH' ? '/users/existing' : '/users'); assert.equal(input.method, method);
        effects++; await onEffect();
        return { status: method === 'POST' ? 201 : 200,
          body: { user: { id: 'remote', label: 'PRIVATE response', createdAt: 1, updatedAt: 2 }, updatedAt: 2 } };
      } } as unknown as ReturnType<ConnectorClientResolver>;
    },
    access, diagnostics,
    present: (connection, users, user) => { onPresent(); return { id: connection.id, users, user }; },
    readError: context => context.json({ error: 'Connector unavailable' }, 502),
  }, method, c.req.param('userId')));
  const request = (signal?: AbortSignal, id = 'target', body: unknown = { label: 'PRIVATE request' }) => app.request(
    '/connections/' + id + '/connector-users' + (method === 'PATCH' ? '/existing' : ''), {
      method, headers: { authorization: 'Bearer ' + key.token, 'content-type': 'application/json' },
      body: JSON.stringify(body), ...(signal ? { signal } : {}),
    });
  const requestBody = (body: ReadableStream<Uint8Array>, signal: AbortSignal) => app.fetch(new Request(
    'http://fixture.invalid/connections/target/connector-users' + (method === 'PATCH' ? '/existing' : ''), {
      method, signal, headers: { authorization: 'Bearer ' + key.token, 'content-type': 'application/json' }, body, duplex: 'half',
    } as RequestInit));
  t.after(async () => { await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, services, key, userId, logs, commands, request, requestBody,
    counts: () => ({ resolutions, effects }), setActor: (next: string) => { actor = next; },
    setAccess: (next: typeof access) => { access = next; },
    setIntercept: (next: typeof intercept) => { intercept = next; },
    onResolve: (next: typeof onResolve) => { onResolve = next; },
    onEffect: (next: typeof onEffect) => { onEffect = next; },
    onPresent: (next: typeof onPresent) => { onPresent = next; } };
}

for (const method of ['POST', 'PATCH'] as const) {
  test(`connector user ${method}: oversized and cancelled partial bodies never admit a remote write`, async t => {
    const f = fixture(t, method);
    assert.equal((await f.request(undefined, 'target', { label: 'x'.repeat(64 * 1024) })).status, 413);
    const abort = new AbortController(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"label":'));
    }, cancel() { cancelled = true; } });
    const pending = f.requestBody(body, abort.signal);
    await new Promise(resolve => setImmediate(resolve)); abort.abort();
    assert.equal((await pending).status, 503); assert.equal(cancelled, true);
    assert.deepEqual(f.counts(), { resolutions: 0, effects: 0 });
  });
  for (const member of [false, true]) test(`connector user ${method}/${member}: original async authority and projection, exactly one effect`, async t => {
    const f = fixture(t, method, member), response = await f.request();
    assert.equal(response.status, method === 'POST' ? 201 : 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert.equal(body.user.id, 'remote'); assert.equal(body.connection.id, 'target');
    assert.equal(body.updatedAt, 2); assert.deepEqual(f.counts(), { resolutions: 1, effects: 1 });
    assert.ok(f.commands.includes('connectionSnapshot')); assert.ok(f.commands.filter(k => k === 'connectionTarget').length >= 4);
    assert.doesNotMatch(f.logs.join('\n'), /PRIVATE|fixture.invalid|hub_key_|authorization|credentialToken/);
  });

  for (const stage of ['resolve', 'effect', 'projection', 'present'] as const)
    for (const change of ['key', 'connection', 'actor'] as const)
      test(`connector user ${method}: ${change} during ${stage} blocks stale effect/delivery`, async t => {
        const f = fixture(t, method);
        const revoke = () => {
          if (change === 'key') f.store.identities.revokeKey(f.userId, f.key.id);
          if (change === 'connection') f.store.upsertConnection({ id: 'target', ownerUserId: f.userId, label: 'Changed', connectorUrl: 'http://fixture.invalid', status: 'disabled' });
          if (change === 'actor') f.setActor('other');
        };
        if (stage === 'resolve') f.onResolve(async () => { revoke(); });
        if (stage === 'effect') f.onEffect(async () => { revoke(); });
        if (stage === 'projection') f.setIntercept(async (kind, work) => { const result = await work(); if (kind === 'connectionSnapshot') revoke(); return result; });
        if (stage === 'present') f.onPresent(revoke);
        const response = await f.request(); assert.equal(response.status, change === 'connection' ? 503 : 401);
        assert.doesNotMatch(await response.text(), /PRIVATE|fixture.invalid/);
        assert.equal(f.counts().effects, stage === 'resolve' ? 0 : 1, 'unknown original write is never replayed');
      });

  for (const stage of ['resolve', 'effect', 'projection', 'final-proof'] as const)
    test(`connector user ${method}: cancellation at ${stage} never leaks or replays`, async t => {
      const f = fixture(t, method), abort = new AbortController();
      if (stage === 'resolve') f.onResolve(async () => { abort.abort(); });
      if (stage === 'effect') f.onEffect(async () => { abort.abort(); });
      if (stage === 'projection') f.setIntercept(async (kind, work) => { const result = await work(); if (kind === 'connectionSnapshot') abort.abort(); return result; });
      if (stage === 'final-proof') {
        let buffered = false;
        f.onPresent(() => { buffered = true; });
        f.setIntercept(async (kind, work) => { const result = await work(); if (buffered && kind === 'connectionTarget') abort.abort(); return result; });
      }
      const response = await f.request(abort.signal); assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /PRIVATE/); assert.equal(f.counts().effects, stage === 'resolve' ? 0 : 1);
    });

  for (const kind of ['memberSnapshot', 'connectionTarget', 'connectionSnapshot'] as const)
    test(`connector user ${method}: ${kind} unavailable refuses without fallback or replay`, async t => {
      const f = fixture(t, method);
      f.setIntercept(async (command, work) => { if (command === kind) throw Error('PRIVATE SQL failure'); return work(); });
      const response = await f.request(); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE/);
      assert.equal(f.counts().effects, kind === 'connectionSnapshot' ? 1 : 0);
    });

  test(`connector user ${method}: missing/foreign/disabled targets never dispatch`, async t => {
    const f = fixture(t, method), other = f.store.createUser('Other').id;
    f.store.upsertConnection({ id: 'foreign', ownerUserId: other, label: 'Private', connectorUrl: 'http://private.invalid' });
    f.store.upsertConnection({ id: 'disabled', ownerUserId: f.userId, label: 'Private', connectorUrl: 'http://private.invalid', status: 'disabled' });
    for (const id of ['missing', 'foreign', 'disabled']) assert.equal((await f.request(undefined, id)).status, 404);
    assert.deepEqual(f.counts(), { resolutions: 0, effects: 0 });
  });

  test(`connector user ${method}: undefined configured port refuses and invalid input preserves 400`, async t => {
    const f = fixture(t, method);
    assert.equal((await f.request(undefined, 'target', { label: '  ' })).status, 400);
    f.setAccess({ begin: async () => undefined } as unknown as Pick<AsyncHubMemberRequests, 'begin'>);
    assert.equal((await f.request()).status, 503); assert.deepEqual(f.counts(), { resolutions: 0, effects: 0 });
  });

  test(`connector user ${method}: unknown remote outcome is logged once and never retried`, async t => {
    const f = fixture(t, method); f.onEffect(async () => { throw Error('PRIVATE remote ACK failure'); });
    const response = await f.request(); assert.equal(response.status, 502); assert.equal(f.counts().effects, 1);
    const events = f.logs.map(line => JSON.parse(line)).filter(row => row.operation === 'hub-connector-user-change' && row.phase === 'finished');
    assert.equal(events.length, 1); assert.equal(events[0].unknown, 1); assert.equal(events[0].admitted, 1); assert.equal(events[0].settled, undefined);
    assert.doesNotMatch(f.logs.join('\n'), /PRIVATE|fixture.invalid/);
  });

  test(`connector user ${method}: close drains real owner command after HTTP cancellation`, async t => {
    const f = fixture(t, method), entered = deferred(), release = deferred(), abort = new AbortController();
    f.setIntercept(async (kind, work) => { if (kind === 'connectionTarget') { entered.resolve(); await release.promise; } return work(); });
    const pending = f.request(abort.signal); await entered.promise; abort.abort();
    assert.equal((await pending).status, 503);
    let closed = false; const closing = f.services.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release.resolve(); await closing; assert.equal(closed, true); assert.equal(f.counts().effects, 0);
  });
}

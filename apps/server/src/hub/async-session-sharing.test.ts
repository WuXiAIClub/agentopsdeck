import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { encodeHubSessionId } from './session-id.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubSessionSharing } from './async-session-sharing.js';
import { executeHubMemberCommand, type HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { registerHubSessionSharingRoutes } from '../routes/hub-session-sharing.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Port = Pick<AsyncHubMemberOwner, 'command'>;
const port = (call: (kind: HubMemberKind, input: unknown) => unknown): Port => ({
  command: (async (kind: HubMemberKind, input: unknown) => call(kind, input)) as Port['command'],
});
const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(r => { resolve = r; }); return { promise, resolve }; };
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), creator = store.createUser('Creator'), recipient = store.createUser('Recipient');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Environment', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const target = (userId: string) => ({ ownerUserId: owner.id, connectionId: 'node', userId });
  for (const user of [creator, recipient]) {
    const t = target(user.id);
    store.roles.save(LEGACY_HUB_PRINCIPAL, t, { ...store.roles.membership(t), role: 'developer', migrateLegacy: true,
      nodeVersion: store.connectionAuthority('node', owner.id)!, environments: { codex: 'developer', openclaw: 'disabled' } });
  }
  const sessionKey = 'codex:' + randomUUID(), creation = store.grants.authorize(target(creator.id), 'sessions:create', { runtime: 'codex' })!;
  store.grants.acceptCreatedSession(creation, sessionKey, randomUUID(), randomUUID(), () => {});
  const share = store.grants.authorize(target(creator.id), 'sessions:share', { runtime: 'codex', sessionKey })!;
  const key = store.identities.issueKey(creator.id), token = store.identities.createSession(key.token)!;
  const sessionId = encodeHubSessionId('node', sessionKey), url = 'http://fixture.invalid/api/hub/v1/shared/' + owner.id + '/sessions/' + sessionId + '/collaborators';
  const request = (signal?: AbortSignal) => new Request(url, { headers: { cookie: 'agentopsdeck_session=' + token }, ...(signal ? { signal } : {}) });
  const calls: Array<{ kind: HubMemberKind; input: unknown }> = [];
  const call = (kind: HubMemberKind, input: unknown) => { calls.push({ kind, input }); return executeHubMemberCommand(store, kind, input as never); };
  const original = port(call), caller = new AsyncHubSessionSharing(original, quiet);
  const route = (asyncSharing?: Pick<AsyncHubSessionSharing, 'begin'>) => {
    const app = new Hono(); registerHubSessionSharingRoutes(app, { hubStore: store, ...(asyncSharing ? { asyncSharing } : {}), principal: c => {
      const actor = store.identities.requestPrincipal(c.req.raw, () => false); if (!actor) throw new HTTPException(401); return actor;
    } }); return app;
  };
  const http = (app: Hono, method: string, body: unknown, suffix = '') => app.request(url + suffix,
    { method, headers: { cookie: 'agentopsdeck_session=' + token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const effects = () => ['hub_session_owners','command_receipts','hub_execution_leases']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  return { db, store, owner, creator, recipient, target, share, sessionId, key, token, request, calls, call, original, caller, route, http, effects };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-sharing-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
for (const awaited of [false, true]) test(`${awaited ? 'awaited' : 'synchronous'} sharing HTTP preserves create/update/delete wire, definite conflicts and unrelated session state`, () => fixture(async f => {
  const app = f.route(awaited ? f.caller : undefined), before = f.effects();
  const created = await f.http(app, 'POST', { userId: f.recipient.id, role: 'collaborator', media: true });
  assert.equal(created.status, 201); const payload = await created.json(); assert.deepEqual(Object.keys(payload), ['grant']);
  const updated = await f.http(app, 'PUT', { version: payload.grant.version, role: 'observer', live: false }, '/' + payload.grant.id);
  assert.equal(updated.status, 200); const current = await updated.json(); assert.deepEqual(Object.keys(current), ['grant']);
  const stale = await f.http(app, 'PUT', { version: payload.grant.version, role: 'observer' }, '/' + payload.grant.id);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error, 'Session permissions changed or exceed the member environment role. Refresh before retrying.');
  const removed = await f.http(app, 'DELETE', { version: current.grant.version }, '/' + current.grant.id);
  assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), {
    ok: true, revocation: { state: 'confirmed', pending: 0, confirmed: 0 },
  });
  const statusPath = '/' + current.grant.id + '/revocation?version=';
  const status = await f.http(app, 'GET', undefined, statusPath + current.grant.version);
  assert.equal(status.status, 200); assert.deepEqual(await status.json(), {
    revocation: { state: 'confirmed', pending: 0, confirmed: 0 },
  });
  for (const invalid of ['0', '-1', '1.5', '01', '9007199254740992']) {
    assert.equal((await f.http(app, 'GET', undefined, statusPath + invalid)).status, 400);
  }
  assert.equal((await f.http(app, 'GET', undefined, statusPath + (current.grant.version + 1))).status, 404);
  const duplicate = await f.http(app, 'DELETE', { version: current.grant.version }, '/' + current.grant.id);
  assert.equal(duplicate.status, 409); assert.deepEqual(await duplicate.json(), { ok: false });
  assert.deepEqual(f.effects(), before);
  for (const secret of [f.token, f.key.token, 'private.invalid']) assert.equal(JSON.stringify(payload).includes(secret), false);
}));
test('mutation authorization never loads collaborator or candidate lists', () => fixture(async f => {
  const collaborators = f.store.grants.collaborators;
  f.store.roles.sessionCandidates = () => { throw new Error('list must not be read'); };
  f.store.grants.collaborators = () => { throw new Error('list must not be read'); };
  const session = await f.caller.begin(f.request(), f.owner.id, f.sessionId);
  await session.check();
  // The original mutation still performs its own bounded duplicate/CAS reads.
  // Only authorization must be independent of the displayed list.
  f.store.grants.collaborators = collaborators;
  const value = await session.create(f.recipient.id, 'observer', {}); assert.ok(value.grant);
  assert.equal(f.calls.some(x => x.kind === 'sessionCollaborators' && (x.input as { command: { action: string } }).command.action === 'list'), false);
}));
for (const item of [
  ['POST', {}, '', 'Invalid recipient or role'],
  ['POST', { userId: 'missing', role: 'observer' }, '', 'Invalid recipient or role'],
  ['POST', { userId: 'missing', role: 'owner' }, '', 'Invalid recipient or role'],
  ['POST', { userId: 'missing', role: 'observer', sql: 'private' }, '', 'Invalid collaboration request'],
  ['PUT', { version: 0, role: 'observer' }, '/missing', 'Invalid session permissions'],
  ['DELETE', { version: 0 }, '/missing', 'Current grant version required'],
] as const) test('old and async sharing body validation agree: ' + JSON.stringify(item), () => fixture(async f => {
  const old = await f.http(f.route(), item[0], item[1], item[2]), next = await f.http(f.route(f.caller), item[0], item[1], item[2]);
  assert.equal(next.status, old.status); assert.equal(next.status, 400); assert.deepEqual(await next.json(), await old.json());
}));
for (const fault of ['revoked','replaced','nodeChanged','creatorChanged','credentialRevoked'] as const) {
  test('body-IO authority change blocks sharing without dispatch: ' + fault, () => fixture(async f => {
    const session = await f.caller.begin(f.request(), f.owner.id, f.sessionId);
    if (fault === 'revoked' || fault === 'replaced') {
      f.store.grants.revoke(f.target(f.creator.id), f.share.grantId, f.share.version);
      if (fault === 'replaced') f.store.grants.create(f.target(f.creator.id), { runtime: 'codex', sessionKey: f.share.resource.sessionKey!, actions: ['messages:read','sessions:share'] });
    }
    if (fault === 'nodeChanged') f.store.upsertConnection({ id: 'node', ownerUserId: f.owner.id, kind: 'remote', label: 'Changed', connectorUrl: 'http://other.invalid' });
    if (fault === 'creatorChanged') f.db.prepare('UPDATE hub_session_owners SET user_id=?').run(f.recipient.id);
    if (fault === 'credentialRevoked') f.store.identities.revokeKey(f.creator.id, f.key.id);
    await assert.rejects(session.create(f.recipient.id, 'observer', {}), HubMemberRequestError);
    assert.equal(f.calls.filter(x => x.kind === 'sessionSharing').length, 0);
  }));
}
test('options are captured before the first permission await', () => fixture(async f => {
  const session = await f.caller.begin(f.request(), f.owner.id, f.sessionId), options = { media: false };
  const work = session.create(f.recipient.id, 'collaborator', options); options.media = true;
  const value = await work; assert.equal(value.grant.policy.actions.includes('media:read'), false);
  const sent = f.calls.find(x => x.kind === 'sessionSharing')!.input as { command: { options: { media: boolean } } };
  assert.equal(sent.command.options.media, false);
}));
for (const fault of ['lostAck','wrongAck','credentialRevoked','shareRevoked'] as const) {
  test('committed sharing never replays or compensates after ' + fault, () => fixture(async f => {
    const caller = new AsyncHubSessionSharing(port((kind, input) => {
      const value = f.call(kind, input);
      if (kind === 'sessionSharing') {
        if (fault === 'lostAck') throw new Error('private acknowledgment missing');
        if (fault === 'wrongAck') return { ...(value as object), recipientId: randomUUID() };
        if (fault === 'credentialRevoked') f.store.identities.revokeKey(f.creator.id, f.key.id);
        if (fault === 'shareRevoked') f.store.grants.revoke(f.target(f.creator.id), f.share.grantId, f.share.version);
      }
      return value;
    }), quiet);
    const session = await caller.begin(f.request(), f.owner.id, f.sessionId);
    await assert.rejects(session.create(f.recipient.id, 'observer', {}), (error: unknown) => error instanceof HubMemberRequestError
      && error.status === (fault === 'credentialRevoked' ? 401 : fault === 'shareRevoked' ? 403 : 503));
    assert.equal(f.calls.filter(x => x.kind === 'sessionSharing').length, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants g JOIN node_grant_dependencies d ON d.child_id=g.id WHERE g.user_id=?').get(f.recipient.id)!.n, 1);
  }));
}
test('pending sharing warning is logged without timeout release, secrets or mutation replay', () => fixture(async f => {
  const wait = deferred(), logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const caller = new AsyncHubSessionSharing(port((kind, input) => kind === 'sessionSharing' ? (f.calls.push({ kind, input }), wait.promise) : f.call(kind, input)), diagnostics, 1, 5);
  const session = await caller.begin(f.request(), f.owner.id, f.sessionId);
  const work = session.create(f.recipient.id, 'observer', {}); let settled = false; void work.finally(() => { settled = true; });
  for (let i = 0; i < 100 && !f.calls.some(x => x.kind === 'sessionSharing'); i++) await tick();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false); assert.equal(caller.pending, 1);
  const sent = f.calls.find(x => x.kind === 'sessionSharing')!;
  wait.resolve(executeHubMemberCommand(f.store, 'sessionSharing', sent.input as never)); await work;
  assert.equal(caller.pending, 0); assert.equal(f.calls.filter(x => x.kind === 'sessionSharing').length, 1);
  const events = logs.map(line => JSON.parse(line));
  assert.ok(events.some(e => e.operation === 'auth-route-persistence' && e.step === 45 && e.phase === 'pending'));
  for (const secret of [f.token, f.key.token, f.sessionId, f.recipient.id]) assert.equal(logs.join('').includes(secret), false);
}));
test('cancelled request cannot dispatch a new sharing mutation', () => fixture(async f => {
  const controller = new AbortController(), session = await f.caller.begin(f.request(controller.signal), f.owner.id, f.sessionId);
  controller.abort();
  await assert.rejects(session.create(f.recipient.id, 'observer', {}), (error: unknown) => error instanceof HubMemberRequestError && error.status === 499);
  assert.equal(f.calls.filter(x => x.kind === 'sessionSharing').length, 0);
}));
test('request cancellation during an accepted mutation does not release or replay it', () => fixture(async f => {
  const wait = deferred(), controller = new AbortController();
  const caller = new AsyncHubSessionSharing(port((kind, input) => kind === 'sessionSharing' ? (f.calls.push({ kind, input }), wait.promise) : f.call(kind, input)), quiet);
  const session = await caller.begin(f.request(controller.signal), f.owner.id, f.sessionId);
  const work = session.create(f.recipient.id, 'observer', {}); void work.catch(() => {});
  for (let i = 0; i < 100 && !f.calls.some(x => x.kind === 'sessionSharing'); i++) await tick();
  controller.abort(); await tick(); assert.equal(caller.pending, 1);
  const sent = f.calls.find(x => x.kind === 'sessionSharing')!;
  wait.resolve(executeHubMemberCommand(f.store, 'sessionSharing', sent.input as never));
  await assert.rejects(work, (error: unknown) => error instanceof HubMemberRequestError && error.status === 499);
  assert.equal(caller.pending, 0); assert.equal(f.calls.filter(x => x.kind === 'sessionSharing').length, 1);
  assert.equal(f.store.grants.collaborators(f.share).length, 1);
}));
test('lost mutation acknowledgement logs an unknown phase45 result without private error data', () => fixture(async f => {
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const caller = new AsyncHubSessionSharing(port((kind, input) => {
    const value = f.call(kind, input); if (kind === 'sessionSharing') throw new Error(f.token + f.key.token); return value;
  }), diagnostics);
  const response = await f.http(f.route(caller), 'POST', { userId: f.recipient.id, role: 'observer' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store', 'unknown writes must never become cached recovery state');
  assert.ok((await response.json()).error);
  assert.ok(logs.map(line => JSON.parse(line)).some(e => e.operation === 'auth-route-persistence' && e.step === 45 && e.unknown === 1 && e.category === 'failed'));
  for (const secret of [f.token, f.key.token, f.sessionId, f.recipient.id]) assert.equal(logs.join('').includes(secret), false);
  assert.equal(f.calls.filter(x => x.kind === 'sessionSharing').length, 1);
}));

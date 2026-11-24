import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {AGENT_RUNTIME_IDS, workspaceFileCardResource} from '@agentopsdeck/shared';
import {notebookHash} from './notebook-operations.js';
import {sessionNotebookWriteRoute} from '../routes/hub-session-notebook-scope.js';
import {loadConfig} from '../config.js';
import {registerHubRoutes} from '../routes/hub.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {HubStore} from './hub-store.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import type {AsyncHubMemberOwner} from './async-member-owner.js';
import {AsyncHubSessionNotebooks} from './async-session-notebooks.js';
import {asyncNativeFileFixture, deferredNative} from './async-native-file-fixture.js';
import {decodeHubSessionId, encodeHubSessionId} from './session-id.js';
import {sessionRef} from './session-ref.js';
import {hubMemberEvidence, type HubMemberCommands, type HubMemberKind} from './member-owner-domain.js';
import type {HubGrantCommand} from './member-grant-domain.js';
import {hubNotebookReplyExpectation, validHubNotebookCommand, validHubNotebookReply,
  type SessionNotebookRead} from './member-notebook-domain.js';

const status = (expected: number) => (error: unknown) => (error as {status?: number}).status === expected;
const saveInput = (document: {resourceId: string; revision: number}, text: string) =>
  ({resourceId: document.resourceId, revision: document.revision, text});
async function fixture(t: TestContext, mode: 'original' | 'worker') {
  const seed = (store: HubStore, sessionId: string) => {
    const decoded = decodeHubSessionId(sessionId)!, connection = store.getConnection('local', 'default')!;
    const ref = sessionRef(connection.nodeId, decoded.remoteSessionKey)!;
    const resourceId = JSON.stringify(['default', ref.nodeId, ref.runtimeId, ref.nativeSessionKey]);
    const recipient = store.createUser('Reader'), recipientKey = store.identities.issueKey(recipient.id);
    const cookie = store.identities.createSession(recipientKey.token)!;
    const target = {ownerUserId: 'default', connectionId: 'local'};
    const resource = {runtime: ref.runtimeId, sessionKey: decoded.remoteSessionKey};
    const grant = store.grants.create({...target, userId: recipient.id}, {...resource, actions: ['messages:read']});
    for (const [user, label] of [['default', 'OWNER_NOTE'], [recipient.id, 'READER_NOTE']]) {
      store.notebooks.save(user!, {resourceId, revision: 0, text: label! + ' hot needle'});
      store.notebooks.saveArchive(user!, {resourceId, revision: 0, text: label! + ' cold needle'});
    }
    return {resourceId, recipient, recipientKey, cookie, target, resource,
      grant: {...grant, id: String(grant.id), nodeVersion: store.connectionAuthority('local', 'default')!}, nodeId: ref.nodeId};
  };
  let seeded!: ReturnType<typeof seed>;
  const f = await asyncNativeFileFixture(t, mode, 'card', undefined, (store, sessionId) => {seeded = seed(store, sessionId);});
  // Runtime mutations use the same sole owner as production. Never open a
  // second HubStore while the worker holds its exclusive database lane.
  const mutate = async <K extends HubMemberKind>(kind: K, input: Omit<HubMemberCommands[K]['input'], 'evidence' | 'expectedScope'>) => {
    const evidence = hubMemberEvidence(f.request()), snapshot = await f.current().owner.command('memberSnapshot', evidence);
    assert.ok(snapshot);
    return f.current().owner.command(kind, {...input, evidence, expectedScope: snapshot.recoveryScope} as HubMemberCommands[K]['input']);
  };
  const grantChange = async (command: Extract<HubGrantCommand, {action: 'create' | 'revoke'}>) => {
    const result = await mutate('grantChange', {command});
    assert.ok(result && !('error' in result) && 'grant' in result, JSON.stringify(result)); return result.grant;
  };
  const createGrant = () => grantChange({action: 'create', target: seeded.target, userId: seeded.recipient.id,
    nodeVersion: seeded.grant.nodeVersion, policy: {...seeded.resource, actions: ['messages:read']}});
  const revokeGrant = (grant: typeof seeded.grant) => grantChange({action: 'revoke', target: seeded.target,
    id: grant.id, version: grant.version, nodeVersion: grant.nodeVersion});
  const toggleConnection = async () => {
    for (const enabled of [false, true]) {
      const target = await mutate('connectionTarget', {id: 'local'});
      assert.ok(target && 'connection' in target);
      const result = await mutate('connectionChange', {change: {action: 'patch', id: 'local', expectedEpoch: target.epoch, configuration: {enabled}}});
      assert.ok(result && !('error' in result));
    }
  };
  const hooks: {after?: (kind: string, input: unknown, result: unknown) => unknown | Promise<unknown>} = {};
  const owner = {weixinBackground: () => f.current().owner.weixinBackground(),
    weixinBindingEffect: () => f.current().owner.weixinBindingEffect(),
    connectionControlSettlement: () => f.current().owner.connectionControlSettlement(),
    nativeFileBackground: () => f.current().owner.nativeFileBackground(),
    contentBackground: () => f.current().owner.contentBackground(), command: async (kind, input) => {
      const result = await f.current().owner.command(kind, input);
      return hooks.after ? await hooks.after(kind, input, result) : result;
    }} as Pick<AsyncHubMemberOwner, 'command' | 'nativeFileBackground' | 'contentBackground'
      | 'weixinBackground' | 'weixinBindingEffect' | 'connectionControlSettlement'>;
  const services = createHubAdministrativeServices(owner);
  const metadata = f.current().metadata ?? new HubStore(':memory:', 'fixture');
  let guarded = false, synchronous = 0;
  const forbidden = () => {synchronous++; return assert.fail('Session read touched synchronous dependency');};
  const store = new Proxy(metadata, {get(target, property, receiver) {return guarded ? forbidden() : Reflect.get(target, property, receiver);}});
  const app = new Hono(), routes = registerHubRoutes(app, {config: {...loadConfig({HOME: f.root, AOD_SERVER_ROLE: 'hub'}), boardFilesEnabled: true},
    hubStore: store, administrative: services, asyncConnectorClient: f.current().resolver,
    principal: forbidden, connectorClient: forbidden, fileCardClient: forbidden, normalizeError: () => 'safe'});
  assert.ok(routes); guarded = true;
  t.after(async () => {guarded = false; delete hooks.after; await routes.close(); await services.close(); if (!f.current().metadata) await metadata.close();});
  const read = (shared = false): SessionNotebookRead => ({sessionId: f.sessionId, ownerUserId: shared ? 'default' : null,
    mode: 'hot', query: null, includeArchive: false});
  const path = (shared = false) => (shared ? 'shared/default/' : '') + `sessions/${encodeURIComponent(f.sessionId)}/notebook`;
  const headers = {'x-agentopsdeck-key': seeded.recipientKey.token};
  const request = (suffix = '', shared = false, auth: HeadersInit = shared ? headers : f.request().headers, method = 'GET', body?: unknown) =>
    app.request('/api/hub/v1/' + path(shared) + suffix, {method, headers: auth,
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {...f, ...seeded, createGrant, revokeGrant, toggleConnection, nativeHooks: f.hooks, hooks, owner, services, read, path, request,
    fetch: (request: Request) => app.fetch(request), originalRequest: f.request,
    sharedRequest: () => f.request(undefined, headers), synchronous: () => synchronous};
}

async function bindSession(f: Awaited<ReturnType<typeof fixture>>) {
  const bindingId = randomUUID();
  await f.services.privateNotebooks.withSession(f.originalRequest(), {sessionId: f.sessionId, ownerUserId: null}, async scope => {
    const port = await f.current().service.begin(scope.request, {domain: 'card',
      resourceId: workspaceFileCardResource('notebook', `session:${f.sessionId}`),
      sessionProof: {authority: scope.authority, resourceId: scope.resourceId}});
    assert.equal((await port.bind({requestId: bindingId, sessionId: f.sessionId, revision: 2})).state, 'active');
  });
  return bindingId;
}

test('session snapshot commands are fixed target/proof DTOs and replies cannot change original scope', () => {
  const read: SessionNotebookRead = {sessionId: encodeHubSessionId('local', 'codex:test'), ownerUserId: null,
    mode: 'hot', query: null, includeArchive: false};
  const command = {action: 'snapshotSession' as const, read};
  assert.equal(validHubNotebookCommand(command), true);
  for (const patch of [{owner: 'other'}, {resourceId: 'arbitrary'}, {authority: true}, {mode: 'layouts'}, {sessionId: 'bad'},
    {ownerUserId: ''}, {query: 'unexpected'}, {includeArchive: true}])
    assert.equal(validHubNotebookCommand({...command, read: {...read, ...patch}}), false);
  const expected = hubNotebookReplyExpectation(command);
  const result = {...command, authority: null, resourceId: null, snapshot: null};
  assert.equal(validHubNotebookReply(expected, result), true);
  assert.equal(validHubNotebookReply(expected, {...result, read: {...read, ownerUserId: 'other'}}), false);
  assert.equal(validHubNotebookReply(expected, {...result, resourceId: 'leak'}), false);
});

test('session async write middleware is exact and never opens shared capabilities or unknown suffixes', () => {
  const owner = '/api/hub/v1/sessions/session/notebook', shared = '/api/hub/v1/shared/owner/sessions/session/notebook';
  for (const root of [owner, shared]) {
    for (const suffix of ['', '/archive']) assert.equal(sessionNotebookWriteRoute('PUT', root + suffix), true);
    assert.equal(sessionNotebookWriteRoute('POST', root + '/moves'), true);
    for (const method of ['GET', 'HEAD']) assert.equal(sessionNotebookWriteRoute(method, root + '/moves/id'), true);
    for (const suffix of ['/unknown', '/archive/moves', '/moves/id/extra', '/capabilities/id/extra'])
      for (const method of ['GET', 'HEAD', 'PUT', 'POST', 'DELETE']) assert.equal(sessionNotebookWriteRoute(method, root + suffix), false);
  }
  for (const method of ['GET', 'HEAD', 'POST']) {
    assert.equal(sessionNotebookWriteRoute(method, owner + '/capabilities'), true);
    assert.equal(sessionNotebookWriteRoute(method, shared + '/capabilities'), false);
  }
  assert.equal(sessionNotebookWriteRoute('DELETE', owner + '/capabilities/id'), true);
  assert.equal(sessionNotebookWriteRoute('DELETE', shared + '/capabilities/id'), false);
});

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: real session writes, capabilities and dual-CAS moves retain wire shape with no synchronous access`, async t => {
    const f = await fixture(t, mode);
    for (const shared of [false, true]) {
      for (const auth of shared ? [{'x-agentopsdeck-key': f.recipientKey.token}, {Authorization: 'Bearer ' + f.recipientKey.token},
        {Cookie: 'agentopsdeck_session=' + f.cookie}] : [Object.fromEntries(f.originalRequest().headers)]) {
        for (const suffix of ['', '/archive']) {
          const current = await (await f.request(suffix, shared, auth)).json() as {resourceId: string; revision: number; text: string};
          const text = current.text + ' saved';
          const response = await f.request(suffix, shared, auth, 'PUT', saveInput(current, text));
          assert.equal(response.status, 200, await response.clone().text());
          const saved = await response.json() as typeof current;
          assert.deepEqual(saveInput(saved, saved.text), {...saveInput(current, text), revision: current.revision + 1});
          assert.equal((await f.request(suffix, shared, auth, 'PUT', saveInput(current, 'stale'))).status, 409);
        }
      }
      const hot = await (await f.request('', shared)).json() as {text: string; revision: number};
      const cold = await (await f.request('/archive', shared)).json() as {revision: number};
      const input = {requestId: randomUUID(), hotRevision: hot.revision, coldRevision: cold.revision, direction: 'archive',
        ranges: [{start: 0, end: 5, sha256: notebookHash(hot.text.slice(0, 5))}]};
      const moved = await f.request('/moves', shared, undefined, 'POST', input);
      assert.equal(moved.status, 200, await moved.clone().text());
      const result = await moved.json();
      assert.deepEqual(await (await f.request('/moves/' + input.requestId, shared)).json(), result);
      assert.deepEqual(await (await f.request('/moves', shared, undefined, 'POST', input)).json(), result);
      assert.equal((await f.request('/moves', shared, undefined, 'POST', {...input, hotRevision: 0})).status, 409);
    }
    const issued = await f.request('/capabilities', false, undefined, 'POST', {facets: ['hot:read'], expiresAt: Date.now() + 60_000});
    assert.equal(issued.status, 201, await issued.clone().text());
    const issuedBody = await issued.json() as {capability: {id: string}; token: string};
    const capability = issuedBody.capability;
    assert.ok(capability.id); assert.ok(issuedBody.token);
    const listed = await (await f.request('/capabilities')).json() as {capabilities: {id: string}[]};
    assert.ok(listed.capabilities.some(v => v.id === capability.id));
    assert.equal(JSON.stringify(listed).includes(issuedBody.token), false);
    assert.equal((await f.request('/capabilities/' + capability.id, false, undefined, 'DELETE')).status, 200);
    assert.equal(f.synchronous(), 0); assert.equal(f.calls.write, 0); assert.equal(f.calls.install, 0);
  });

  test(`${mode}: session bound file autosave and move settle original receipts without changing shared actor data`, async t => {
    const f = await fixture(t, mode); await bindSession(f);
    const hot = await (await f.request()).json() as {resourceId: string; revision: number; text: string};
    const saved = await f.request('', false, undefined, 'PUT', saveInput(hot, 'NATIVE saved text'));
    assert.equal(saved.status, 200, await saved.clone().text());
    const next = await saved.json() as {revision: number};
    const cold = await (await f.request('/archive')).json() as {revision: number};
    const input = {requestId: randomUUID(), hotRevision: next.revision, coldRevision: cold.revision, direction: 'archive',
      ranges: [{start: 0, end: 6, sha256: notebookHash('NATIVE')}]};
    const moved = await f.request('/moves', false, undefined, 'POST', input);
    assert.equal(moved.status, 200, await moved.clone().text());
    const writes = f.calls.write;
    assert.deepEqual(await (await f.request('/moves/' + input.requestId)).json(), await moved.json());
    assert.equal(f.calls.write, writes);
    assert.ok((await (await f.request('', true)).json() as {text: string}).text.startsWith('READER_NOTE'));
    assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: malformed resolution and substituted proof replies cannot enter session effects`, async t => {
    const f = await fixture(t, mode);
    for (const failure of ['target', 'resource', 'authority']) {
      let effects = 0;
      f.hooks.after = (kind, input, result) => {
        if (kind !== 'personalNotebook' || (input as {command: {action: string}}).command.action !== 'resolveSession') return result;
        const reply = structuredClone(result) as Record<string, unknown>;
        if (failure === 'target') reply.target = {...reply.target as object, sessionId: encodeHubSessionId('other', 'codex:other')};
        if (failure === 'resource') reply.resourceId = JSON.stringify(['other', f.nodeId, 'codex', 'other']);
        if (failure === 'authority') reply.authority = {...reply.authority as object, sessionId: encodeHubSessionId('local', 'codex:other')};
        return reply;
      };
      await assert.rejects(f.services.privateNotebooks.withSession(f.originalRequest(),
        {sessionId: f.sessionId, ownerUserId: null}, async () => {effects++;}), status(503));
      assert.equal(effects, 0);
    }
    delete f.hooks.after;
    assert.equal(f.calls.write, 0); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: body wait preserves original shared grant and refuses replacement before saving`, async t => {
    const f = await fixture(t, mode), entered = deferredNative(), release = deferredNative();
    const hot = await (await f.request('', true)).json() as {resourceId: string; revision: number; text: string};
    const body = new ReadableStream<Uint8Array>({async pull(controller) {
      entered.resolve(); await release.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(saveInput(hot, 'must not save')))); controller.close();
    }}, {highWaterMark: 0});
    const request = new Request('http://fixture/api/hub/v1/' + f.path(true), {method: 'PUT', headers: f.sharedRequest().headers,
      body, duplex: 'half'} as RequestInit);
    const pending = f.fetch(request);
    try {
      await entered.promise; await f.revokeGrant(f.grant); await f.createGrant(); release.resolve();
      assert.equal((await pending).status, 403);
      assert.deepEqual(await (await f.request('', true)).json(), hot);
      assert.equal(f.calls.write, 0); assert.equal(f.synchronous(), 0);
    } finally {release.resolve(); await pending;}
  });

  test(`${mode}: styled session data rejects stale editors and Hermes retains local notebook saves`, async t => {
    const f = await fixture(t, mode);
    for (const shared of [false, true]) {
      const hot = await (await f.request('', shared)).json() as {resourceId: string; revision: number; text: string};
      const auth = new Headers(shared ? f.sharedRequest().headers : f.originalRequest().headers);
      auth.set('x-agentopsdeck-notebook-format', 'styled-markdown-v1');
      const response = await f.request('', shared, auth, 'PUT', saveInput(hot, '<span data-agentopsdeck-note="v1">Styled</span>'));
      assert.equal(response.status, 200, await response.clone().text());
      const saved = await response.json() as typeof hot;
      assert.equal((await f.request('', shared, undefined, 'PUT', saveInput(saved, 'flattened'))).status, 409);
      assert.deepEqual(await (await f.request('', shared)).json(), saved);
    }
    const sessionId = encodeHubSessionId('local', 'hermes:local-notebook');
    const url = 'http://fixture/api/hub/v1/sessions/' + encodeURIComponent(sessionId) + '/notebook';
    const current = await (await f.fetch(new Request(url, {headers: f.originalRequest().headers}))).json() as {resourceId: string; revision: number};
    const saved = await f.fetch(new Request(url, {method: 'PUT', headers: f.originalRequest().headers,
      body: JSON.stringify(saveInput(current, 'Hermes local save'))}));
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await saved.json() as {text: string}).text, 'Hermes local save');
    assert.equal(f.calls.write, 0); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: shared save and move never write an owner session native binding`, async t => {
    const f = await fixture(t, mode); await bindSession(f);
    const ownerBefore = await (await f.request()).json();
    const hot = await (await f.request('', true)).json() as {resourceId: string; revision: number; text: string};
    const saved = await f.request('', true, undefined, 'PUT', saveInput(hot, 'Reader private saved'));
    assert.equal(saved.status, 200, await saved.clone().text());
    const cold = await (await f.request('/archive', true)).json() as {revision: number};
    const input = {requestId: randomUUID(), hotRevision: hot.revision + 1, coldRevision: cold.revision, direction: 'archive',
      ranges: [{start: 0, end: 6, sha256: notebookHash('Reader')}]};
    const moved = await f.request('/moves', true, undefined, 'POST', input);
    assert.equal(moved.status, 200, await moved.clone().text());
    assert.deepEqual(await (await f.request('/moves/' + input.requestId, true)).json(), await moved.json());
    assert.deepEqual(await (await f.request()).json(), ownerBefore);
    assert.equal(f.calls.write, 0); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: session native admission epoch change prevents dispatch without a local fallback`, async t => {
    const f = await fixture(t, mode); await bindSession(f);
    const hot = await (await f.request()).json() as {resourceId: string; revision: number; text: string};
    f.hooks.after = async (kind, input, result) => {
      if (kind === 'nativeFile' && (input as {command: {action: string}}).command.action === 'write-admit') {
        delete f.hooks.after; await f.toggleConnection();
      }
      return result;
    };
    const result = await f.request('', false, undefined, 'PUT', saveInput(hot, 'not dispatched'));
    assert.equal(result.status, 403, await result.clone().text());
    assert.deepEqual(await (await f.request()).json(), hot);
    assert.equal(f.calls.write, 0); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: lost session native response recovers the same autosave receipt without resending`, async t => {
    const f = await fixture(t, mode); await bindSession(f);
    const hot = await (await f.request()).json() as {resourceId: string; revision: number; text: string};
    const input = saveInput(hot, 'Saved once with lost response');
    f.nativeHooks.after = async (request, response) => {
      if (request.method === 'POST' && !new URL(request.url).pathname.endsWith('/subscribe')) {
        f.nativeHooks.after = undefined; await response.text(); throw Error('lost_native_response');
      }
      return response;
    };
    assert.equal((await f.request('', false, undefined, 'PUT', input)).status, 503);
    const recovered = await f.request('', false, undefined, 'PUT', input);
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal((await recovered.json() as {text: string}).text, input.text);
    assert.equal(f.calls.write, 1); assert.ok(f.calls.receipt > 0); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: native settlement survives a later epoch change but cannot deliver the old session response`, async t => {
    const f = await fixture(t, mode); await bindSession(f);
    const hot = await (await f.request()).json() as {resourceId: string; revision: number};
    let settled = false;
    f.hooks.after = async (kind, input, result) => {
      if (kind === 'nativeFile' && (input as {command: {action: string}}).command.action === 'write-settle') {
        delete f.hooks.after; settled = true; await f.toggleConnection();
      }
      return result;
    };
    const response = await f.request('', false, undefined, 'PUT', saveInput(hot, 'Settled before epoch change'));
    assert.equal(response.status, 403, await response.clone().text());
    assert.equal(settled, true); assert.equal(f.calls.write, 1);
    const fresh = await f.request(); assert.equal(fresh.status, 200);
    assert.equal((await fresh.json() as {text: string}).text, 'Settled before epoch change');
    assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: cancellation after native admission retains the original write and settlement`, async t => {
    const f = await fixture(t, mode); await bindSession(f);
    const hot = await (await f.request()).json() as {resourceId: string; revision: number};
    const controller = new AbortController(); let admitted = false;
    f.hooks.after = (kind, input, result) => {
      if (kind === 'nativeFile' && (input as {command: {action: string}}).command.action === 'write-admit') {
        delete f.hooks.after; admitted = true; controller.abort();
      }
      return result;
    };
    const response = await f.fetch(new Request('http://fixture/api/hub/v1/' + f.path(), {method: 'PUT',
      headers: f.originalRequest().headers, signal: controller.signal, body: JSON.stringify(saveInput(hot, 'Cancelled delivery only'))}));
    assert.equal(response.status, 499, await response.clone().text());
    assert.equal(admitted, true); assert.equal(f.calls.write, 1);
    assert.equal((await (await f.request()).json() as {text: string}).text, 'Cancelled delivery only');
    assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: lost native admission ACK keeps the durable intent and retries inspect only`, async t => {
    const f = await fixture(t, mode); await bindSession(f);
    const hot = await (await f.request()).json() as {resourceId: string; revision: number};
    f.hooks.after = (kind, input, result) => {
      if (kind === 'nativeFile' && (input as {command: {action: string}}).command.action === 'write-admit') {
        delete f.hooks.after; throw Error('lost_admission_ack');
      }
      return result;
    };
    const input = saveInput(hot, 'Unknown admission must not resend');
    assert.equal((await f.request('', false, undefined, 'PUT', input)).status, 503);
    assert.equal((await f.request('', false, undefined, 'PUT', input)).status, 503);
    assert.ok(f.calls.receipt > 0); assert.equal(f.calls.write, 0);
    assert.deepEqual(await (await f.request()).json(), hot); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: substituted native session proof reply rejects delivery without a local save`, async t => {
    const f = await fixture(t, mode); await bindSession(f);
    const hot = await (await f.request()).json() as {resourceId: string; revision: number};
    f.hooks.after = (kind, _input, result) => {
      if (kind === 'nativeFile') {delete f.hooks.after; return {...result as object, sessionHash: '0'.repeat(64)};}
      return result;
    };
    assert.equal((await f.request('', false, undefined, 'PUT', saveInput(hot, 'Rejected proof'))).status, 503);
    assert.equal(f.calls.write, 0); assert.deepEqual(await (await f.request()).json(), hot);
    assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: revoked original session proof rejects save/control without selecting replacement grant`, async t => {
    const f = await fixture(t, mode);
    const hot = await (await f.request('', true)).json();
    f.hooks.after = async (kind, input, result) => {
      if (kind === 'personalNotebook' && (input as {command: {action: string}}).command.action === 'resolveSession') {
        delete f.hooks.after; await f.revokeGrant(f.grant); await f.createGrant();
      }
      return result;
    };
    assert.equal((await f.request('', true, undefined, 'PUT', {...hot, text: 'not allowed'})).status, 403);
    assert.deepEqual(await (await f.request('', true)).json(), hot);
    assert.equal(f.synchronous(), 0); assert.equal(f.calls.write, 0);
  });

  test(`${mode}: session lifecycle drains effect and final proof checks before closing`, async t => {
    const f = await fixture(t, mode), entered = deferredNative(), release = deferredNative();
    const facade = new AsyncHubSessionNotebooks(f.owner, new PerformanceDiagnostics(() => {}));
    const pending = assert.rejects(facade.withSession(f.originalRequest(), {sessionId: f.sessionId, ownerUserId: null}, async () => {
      entered.resolve(); await release.promise; return 'finished';
    }), status(503));
    try {
      await entered.promise; let closed = false;
      const closing = facade.close(); void closing.then(() => {closed = true;});
      await new Promise<void>(yes => setImmediate(yes)); assert.equal(closed, false);
      release.resolve(); await pending; await closing;
      await assert.rejects(facade.withSession(f.originalRequest(), f.read(), async () => 'late'));
    } finally {release.resolve(); await pending; await facade.close();}
  });

  test(`${mode}: six real HTTP read routes preserve actor data, DTOs, credentials and owner runtimes without sync access`, async t => {
    const f = await fixture(t, mode);
    for (const shared of [false, true]) {
      for (const auth of shared ? [{'x-agentopsdeck-key': f.recipientKey.token}, {Authorization: 'Bearer ' + f.recipientKey.token},
        {Cookie: 'agentopsdeck_session=' + f.cookie}] : [Object.fromEntries(f.originalRequest().headers)]) {
        for (const suffix of ['', '/archive', '/search?q=needle&archive=1']) {
          const response = await f.request(suffix, shared, auth); assert.equal(response.status, 200, suffix);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          const body = await response.json() as {resourceId: string; text: string; results: {area: string; text: string}[]};
          const expected = shared ? 'READER_NOTE' : 'OWNER_NOTE';
          if (suffix.startsWith('/search')) {
            assert.deepEqual(body.results.map(v => v.area), ['hot', 'cold']);
            assert.ok(body.results.every(v => v.text.includes(expected)));
          } else {assert.equal(body.resourceId, f.resourceId); assert.ok(body.text.includes(expected));}
          assert.equal(JSON.stringify(body).includes(shared ? 'OWNER_NOTE' : 'READER_NOTE'), false);
        }
      }
    }
    for (const runtime of AGENT_RUNTIME_IDS) {
      const key = runtime === 'openclaw' ? 'agent:legacy:session' : runtime + ':read';
      const result = await f.services.privateNotebooks.snapshotSession(f.originalRequest(), {...f.read(), sessionId: encodeHubSessionId('local', key)});
      const ref = sessionRef(f.nodeId, key)!;
      assert.equal(result.documents[0]!.resourceId, JSON.stringify(['default', f.nodeId, ref.runtimeId, ref.nativeSessionKey]));
    }
    assert.equal((await f.request('', false, undefined, 'HEAD')).status, 200);
    assert.equal(f.synchronous(), 0); assert.equal(f.calls.write, 0); assert.equal(f.calls.install, 0);
  });

  test(`${mode}: absent initial grant/target is 404 and replacement grant cannot revive an ACKed proof`, async t => {
    const f = await fixture(t, mode);
    await f.revokeGrant(f.grant);
    assert.equal((await f.request('', true)).status, 404);
    const replacement = await f.createGrant();
    f.hooks.after = async (kind, input, result) => {
      if (kind === 'personalNotebook' && (input as {command: {action: string}}).command.action === 'snapshotSession') {
        delete f.hooks.after;
        await f.revokeGrant(replacement); await f.createGrant();
      }
      return result;
    };
    const response = await f.request('', true); assert.equal(response.status, 403);
    assert.equal((await response.text()).includes('READER_NOTE'), false);
    assert.equal((await f.request('', true)).status, 200); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: connection disable/re-enable after snapshot cannot revive original owner epoch`, async t => {
    const f = await fixture(t, mode);
    f.hooks.after = async (kind, input, result) => {
      if (kind === 'personalNotebook' && (input as {command: {action: string}}).command.action === 'snapshotSession') {
        delete f.hooks.after;
        await f.toggleConnection();
      }
      return result;
    };
    const response = await f.request(); assert.equal(response.status, 403);
    assert.equal((await response.text()).includes('OWNER_NOTE'), false); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: lost ACK, retargeted read and altered original proof fail closed without fallback`, async t => {
    const f = await fixture(t, mode);
    for (const failure of ['lost', 'scope', 'proof', 'snapshot']) {
      f.hooks.after = (kind, input, result) => {
        if (kind !== 'personalNotebook') return result;
        const action = (input as {command: {action: string}}).command.action;
        if (failure === 'lost') throw Error('lost_ack');
        const value = structuredClone(result) as Record<string, unknown>;
        if (failure === 'scope' && action === 'snapshotSession') value.read = {...f.read(), ownerUserId: 'other'};
        if (failure === 'proof' && action === 'checkSession') value.authority = {...value.authority as object, connectionVersion: 999};
        if (failure === 'snapshot' && action === 'snapshotSession') value.snapshot = {};
        return value;
      };
      const response = await f.request(); assert.equal(response.status, 503, failure);
      assert.equal((await response.text()).includes('OWNER_NOTE'), false);
    }
    delete f.hooks.after;
    assert.equal((await f.request()).status, 200); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: identity revocation after ACK returns 401, never delivers old data`, async t => {
    const f = await fixture(t, mode);
    f.hooks.after = async (kind, input, result) => {
      if (kind === 'personalNotebook' && (input as {command: {action: string}}).command.action === 'snapshotSession') {
        delete f.hooks.after; await f.revokeKey();
      }
      return result;
    };
    const response = await f.request(); assert.equal(response.status, 401);
    assert.equal((await response.text()).includes('OWNER_NOTE'), false); assert.equal(f.synchronous(), 0);
  });

  test(`${mode}: initial identity wait cannot retarget the captured session or credentials`, async t => {
    const f = await fixture(t, mode), entered = deferredNative(), release = deferredNative();
    let paused = false;
    f.hooks.after = async (kind, _input, result) => {
      if (kind === 'memberSnapshot' && !paused) {paused = true; entered.resolve(); await release.promise;} return result;
    };
    const target = f.read(), request = f.originalRequest();
    const pending = f.services.privateNotebooks.snapshotSession(request, target);
    try {
      await entered.promise; target.sessionId = encodeHubSessionId('other', 'hermes:other'); target.ownerUserId = 'other';
      request.headers.set('x-agentopsdeck-key', f.recipientKey.token); release.resolve();
      const value = await pending; assert.equal(value.documents[0]!.text, 'OWNER_NOTE hot needle');
    } finally {release.resolve(); await pending;}
  });

  test(`${mode}: closing rejects admission and waits for the original snapshot ACK`, async t => {
    const f = await fixture(t, mode), entered = deferredNative(), release = deferredNative();
    f.hooks.after = async (kind, _input, result) => {if (kind === 'personalNotebook') {entered.resolve(); await release.promise;} return result;};
    const pending = assert.rejects(f.services.privateNotebooks.snapshotSession(f.originalRequest(), f.read()), status(503));
    try {
      await entered.promise; let settled = false;
      const closing = f.services.privateNotebooks.close(); void closing.then(() => {settled = true;});
      await new Promise<void>(yes => setImmediate(yes)); assert.equal(settled, false);
      await assert.rejects(f.services.privateNotebooks.snapshotSession(f.originalRequest(), f.read()), status(503));
      release.resolve(); await pending; await closing; assert.equal(settled, true);
    } finally {release.resolve(); await pending;}
  });

  test(`${mode}: cancelled delivery retains snapshot ACK for drain and never retries`, async t => {
    const f = await fixture(t, mode), entered = deferredNative(), release = deferredNative(), controller = new AbortController();
    let calls = 0;
    f.hooks.after = async (kind, _input, result) => {if (kind === 'personalNotebook') {calls++; entered.resolve(); await release.promise;} return result;};
    const facade = new AsyncHubSessionNotebooks(f.owner, new PerformanceDiagnostics(() => {}));
    const pending = assert.rejects(facade.snapshotSession(f.originalRequest(controller.signal), f.read()), status(499));
    try {
      await entered.promise; controller.abort(); await pending;
      assert.ok(facade.pending > 0); let closed = false;
      const closing = facade.close(); void closing.then(() => {closed = true;});
      await new Promise<void>(yes => setImmediate(yes)); assert.equal(closed, false);
      release.resolve(); await closing; assert.equal(calls, 1);
    } finally {release.resolve(); await pending; await facade.close();}
  });
}

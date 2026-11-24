import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { QuickChatService } from './quick-chat-service.js';
import { hubMemberEvidence, validHubMemberInput, hubMemberCommandSteps, hubMemberFailureSteps,
  type HubMemberKind } from './member-owner-domain.js';
import { validHubQuickChatExecutionReply, validHubQuickChatEffectReply,
  type HubQuickChatExecutionCommand } from './member-quick-chat-execution-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubQuickChat } from '../routes/hub-quick-chat.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';

const base = '/api/hub/v1/quick-chat', tick = () => new Promise<void>(r => setImmediate(r));
const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: 2000, epoch: 'fixture' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}
const done = () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: 'PRIVATE_OUTPUT' }] }] });
async function fixture(t: TestContext, mode: 'original' | 'worker', throwingSink = false) {
  const root = mkdtempSync(join(tmpdir(), 'chat-execution-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const key = seed.identities.issueKey('default'), observer = seed.identities.issueKey('default');
  const other = seed.createUser('Other'), otherKey = seed.identities.issueKey(other.id);
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => {
    logs.push(line); if (throwingSink) throw Error('diagnostics unavailable');
  });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const behavior: { posts: number; catalogs: number; provider?: () => Promise<Response>;
    after?: (kind: HubMemberKind, input: unknown, value: unknown) => void | Promise<void> } = { posts: 0, catalogs: 0 };
  const port = { command: async (kind: HubMemberKind, input: never) => {
    const value = await owner.command(kind, input); await behavior.after?.(kind, input, value); return value;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics), persistence = group.createQuickChatExecution();
  const configuration = { url: 'https://provider.invalid/v1/responses', model: 'fixture',
    token: 'PRIVATE_PROVIDER_TOKEN', users: ['default', other.id] };
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') { behavior.catalogs++; return Response.json({ data: [{ id: 'fixture' }] }); }
    behavior.posts++; return behavior.provider ? behavior.provider() : done();
  };
  const service = new QuickChatService(undefined, configuration, transport, 60_000, { persistence, diagnostics, discoverModels: true });
  const forbidden = () => { throw new Error('SYNC_PRINCIPAL_OR_STORE_FALLBACK'); };
  Object.defineProperty(service, 'store', { get: forbidden });
  const app = new Hono(); registerHubQuickChat(app, { mode: 'async', service, diagnostics });
  const request = (path = '', method = 'GET', body?: unknown, token = key.token, signal?: AbortSignal) => new Request('http://hub.invalid' + base + path,
    { method, headers: { 'x-agentopsdeck-key': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  const proof = async (token = key.token) => {
    const evidence = hubMemberEvidence(request('', 'GET', undefined, token)), snapshot = await owner.command('memberSnapshot', evidence);
    assert.ok(snapshot); return { evidence, expectedScope: snapshot.recoveryScope };
  };
  const command = async (command: HubQuickChatExecutionCommand, token = key.token) =>
    owner.command('quickChatExecution', { ...await proof(token), command });
  const profileId = randomUUID();
  const save = (id = profileId) => app.fetch(request('/profiles/' + id, 'PUT',
    { revision: 0, name: 'Profile', target: 'hub-standalone', model: 'fixture', outputLimit: 100 }));
  const send = (requestId: string, id = profileId, token = key.token) => app.fetch(request('/requests', 'POST',
    { requestId, profileId: id, revision: 1, input: 'PRIVATE_PROMPT' }, token));
  t.after(async () => {
    await service.close(); await group.close(); await owner.close(); await original?.close();
    for (const secret of [key.token, otherKey.token, observer.token, 'PRIVATE_PROMPT', 'PRIVATE_OUTPUT', 'PRIVATE_PROVIDER_TOKEN'])
      assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, owner, original, service, persistence, group, behavior, app, request, proof, command, profileId, save, send,
    key, observer, otherKey, file, configuration, transport, diagnostics };
}

test('new fixed commands have strict schemas and unique append-only observation IDs', () => {
  for (const ids of [hubMemberCommandSteps, hubMemberFailureSteps]) assert.equal(new Set(Object.values(ids)).size, Object.keys(ids).length);
  assert.equal(validHubMemberInput('quickChatEffect', { action: 'expire', sql: 'forbidden' }), false);
  assert.equal(validHubMemberInput('quickChatEffect', { action: 'settle', ownerUserId: 'default', requestId: 'r', proof: 'x', output: 'out' }), false);
  assert.equal(validHubMemberInput('quickChatExecution', { evidence: {}, expectedScope: 'a'.repeat(64), command: { action: 'claim',
    requestId: 'r', identityInput: 'in', capability, authorized: true } }), false);
});

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} quick chat malformed body after revocation is rejected by original authority`, async t => {
    const f = await fixture(t, mode);
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      await f.owner.command('memberKeyRevoke', { ...await f.proof(f.observer.token), userId: 'default', keyId: f.key.id });
      controller.enqueue(new TextEncoder().encode('{')); controller.close();
    } }, { highWaterMark: 0 });
    const request = new Request('http://hub.invalid' + base + '/requests', { method: 'POST',
      headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit);
    assert.equal((await f.app.fetch(request)).status, 401);
    assert.equal(f.behavior.posts, 0);
    assert.equal(f.behavior.catalogs, 0);
  });
  if (mode === 'original') test('production Hub middleware and service factory use awaited QuickChat for all six entries', async t => {
    const f = await fixture(t, mode), config = loadConfig({ HOME: f.root, AOD_SERVER_ROLE: 'hub' });
    config.hub.research = { searchUrl: 'https://search.invalid', users: ['default'], synthesis: f.configuration };
    let guarded = false, principals = 0;
    const store = new Proxy(f.original!, { get(target, key, receiver) {
      if (guarded) throw Error('production QuickChat synchronous bypass');
      return Reflect.get(target, key, receiver);
    } });
    t.mock.method(globalThis, 'fetch', f.transport);
    const hub = new Hono(), routes = registerHubRoutes(hub, { config, hubStore: store,
      connectorClient: () => { throw Error('unexpected Connector effect'); }, administrative: f.group,
      principal: () => { principals++; return undefined; }, normalizeError: () => 'safe' });
    const id = randomUUID(), cancelled = randomUUID();
    try {
      guarded = true;
      for (const path of ['', '/requests/' + id]) {
        assert.equal((await hub.fetch(f.request(path, 'GET', undefined, 'aod_board_synthetic'))).status, 401);
        assert.equal((await hub.fetch(f.request(path, 'GET', undefined, 'aod_note_synthetic'))).status, 401);
      }
      assert.equal((await hub.fetch(f.request('', 'HEAD'))).status, 200);
      assert.equal((await hub.fetch(f.request('/profiles/' + f.profileId, 'PUT',
        { revision: 0, name: 'Profile', target: 'hub-standalone', model: 'fixture', outputLimit: 100 }))).status, 200);
      assert.equal((await hub.fetch(f.request('/requests', 'POST',
        { requestId: id, profileId: f.profileId, revision: 1, input: 'PRIVATE_PROMPT' }))).status, 200);
      const read = await hub.fetch(f.request('/requests/' + id)); assert.equal(read.status, 200);
      assert.equal((await read.json()).output, 'PRIVATE_OUTPUT'); assert.equal(read.headers.get('cache-control'), 'no-store');
      assert.equal((await hub.fetch(f.request('/requests/' + id, 'HEAD'))).status, 200);
      const completed = await f.command({ action: 'lookup', requestId: id, profileId: f.profileId });
      assert.ok(completed?.receipt);
      await f.command({ action: 'admit', requestId: cancelled, profileId: f.profileId, revision: 1,
        identityInput: 'PRIVATE_PROMPT', capability: { ...capability, epoch: completed.receipt.capabilityEpoch } });
      assert.equal((await hub.fetch(f.request('/requests/' + cancelled + '/cancel', 'POST'))).status, 200);
      assert.equal((await hub.fetch(f.request('/requests/' + id + '/result', 'DELETE'))).status, 200);
      assert.equal((await hub.fetch(f.request())).status, 200); assert.equal(f.behavior.posts, 1); assert.equal(principals, 0);
      assert.equal((await hub.fetch(f.request('', 'POST'))).status, 401); assert.equal(principals, 1);
    } finally { guarded = false; await routes?.close(); }
  });

  if (mode === 'original') test('awaited execution denies pre-COMMIT key revocation even when rollback restores the key', async t => {
    const f = await fixture(t, mode); assert.equal((await f.save()).status, 200);
    const store = f.original!.quickChat, originalClaim = store.claim.bind(store); let checks = 0;
    store.claim = (user, id, input, cap, authorized) => originalClaim(user, id, input, cap, () => {
      if (++checks === 3) f.original!.identities.revokeKey('default', f.key.id);
      return authorized();
    });
    const id = randomUUID();
    try {
      assert.equal((await f.send(id)).status, 401); assert.equal(checks, 3); assert.equal(f.behavior.posts, 0);
      assert.equal(store.receipt('default', id)?.state, 'admitted');
      assert.ok(await f.proof()); // Rollback restored the key, not this dispatch's authority.
    } finally { store.claim = originalClaim; }
  });

  test(`${mode}: six real HTTP entries use only awaited owner, preserve wire shapes and never leak proofs`, async t => {
    const f = await fixture(t, mode), id = randomUUID(), cancelled = randomUUID();
    assert.equal((await f.save()).status, 200);
    const sent = await f.send(id); assert.equal(sent.status, 200, await sent.clone().text());
    const value = await sent.json(); assert.equal(value.output, 'PRIVATE_OUTPUT'); assert.equal(value.receipt.state, 'completed');
    for (const name of ['fingerprint', 'capabilityEpoch', 'resultRef', 'settlementProof']) assert.equal(name in value.receipt, false);
    assert.equal(JSON.stringify(value).includes('settlementProof'), false);
    const read = await f.app.fetch(f.request('/requests/' + id)); assert.equal(read.status, 200); assert.deepEqual(await read.json(), value);
    const list = await f.app.fetch(f.request()); assert.equal(list.status, 200); assert.equal((await list.json()).receipts.length, 1);
    const cleared = await f.app.fetch(f.request('/requests/' + id + '/result', 'DELETE'));
    assert.equal(cleared.status, 200); assert.equal((await cleared.json()).output, null);
    const context = await f.persistence.begin(f.request());
    // Use the actual configured capability pinned by a previous receipt for a
    // separate admitted-only request; no provider may run on cancel/recovery.
    const previous = await context.lookup(id, f.profileId); assert.ok(previous.receipt);
    await f.command({ action: 'admit', requestId: cancelled, profileId: f.profileId, revision: 1,
      identityInput: 'PRIVATE_PROMPT', capability: { ...capability, epoch: previous.receipt.capabilityEpoch } });
    const cancel = await f.app.fetch(f.request('/requests/' + cancelled + '/cancel', 'POST'));
    assert.equal(cancel.status, 200); assert.equal((await cancel.json()).receipt.state, 'failed');
    const recovered = await f.send(id); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).output, null);
    assert.equal(f.behavior.posts, 1);
    assert.equal((await f.app.fetch(f.request('/requests/' + cancelled + '/result', 'DELETE'))).status, 200);
    assert.equal(read.headers.get('cache-control'), 'no-store');
  });

  test(`${mode}: concurrent identical admission performs exactly one original provider call`, async t => {
    const f = await fixture(t, mode), provider = deferred<Response>(), started = deferred<void>(), id = randomUUID();
    f.behavior.provider = () => { started.resolve(); return provider.promise; };
    assert.equal((await f.save()).status, 200);
    const one = f.send(id), two = f.send(id);
    try {
      await started.promise; provider.resolve(done());
      const responses = await Promise.all([one, two]);
      assert.ok(responses.every(r => r.status === 200)); assert.equal(f.behavior.posts, 1);
    } finally { provider.resolve(done()); await Promise.allSettled([one, two]); }
  });

  test(`${mode}: awaited claim shares the two original provider slots across users`, async t => {
    const f = await fixture(t, mode), provider = deferred<Response>(), started = [deferred<void>(), deferred<void>()];
    assert.equal((await f.save()).status, 200);
    assert.equal((await f.app.fetch(f.request('/profiles/' + f.profileId, 'PUT',
      { revision: 0, name: 'Other profile', target: 'hub-standalone', model: 'fixture', outputLimit: 100 }, f.otherKey.token))).status, 200);
    f.behavior.provider = () => { started[f.behavior.posts - 1]?.resolve(); return provider.promise; };
    const one = f.send(randomUUID()); let two: Promise<Response> | undefined;
    try {
      await started[0]!.promise; two = Promise.resolve(f.send(randomUUID(), f.profileId, f.otherKey.token)); await started[1]!.promise;
      assert.equal((await f.send(randomUUID())).status, 409); assert.equal(f.behavior.posts, 2);
      provider.resolve(done()); assert.equal((await one).status, 200); assert.equal((await two).status, 200);
    } finally { provider.resolve(done()); await Promise.allSettled([one, ...(two ? [two] : [])]); }
  });

  test(`${mode}: ignored provider abort retains UNKNOWN and late response cancellation until real cleanup`, async t => {
    const f = await fixture(t, mode), provider = deferred<Response>(), started = deferred<void>(), cleanup = deferred<void>(), id = randomUUID();
    assert.equal((await f.save()).status, 200);
    f.behavior.provider = () => { started.resolve(); return provider.promise; };
    const work = f.send(id); let closing: Promise<void> | undefined, closed = false, cancellations = 0;
    try {
      await started.promise; closing = f.service.close().then(() => { closed = true; });
      assert.equal((await work).status, 200); await tick(); assert.equal(closed, false);
      provider.resolve(new Response(new ReadableStream({ cancel() { cancellations++; return cleanup.promise; } }),
        { headers: { 'content-type': 'application/json' } }));
      await tick(); assert.equal(cancellations, 1); assert.equal(closed, false);
      cleanup.resolve(); await closing;
      const state = await f.owner.command('quickChatState', { ...await f.proof(), command: { action: 'inspect', requestId: id } });
      assert.equal(state?.receipt?.state, 'unknown'); assert.equal(state?.output, null); assert.equal(f.behavior.posts, 1);
    } finally { provider.resolve(done()); cleanup.resolve(); await work; await closing; }
  });

  test(`${mode}: throwing diagnostics cannot change original admission, proof or durable settlement`, async t => {
    const f = await fixture(t, mode, true), id = randomUUID();
    assert.equal((await f.save()).status, 200); assert.equal((await f.send(id)).status, 200);
    assert.equal((await f.send(id)).status, 200); assert.equal(f.behavior.posts, 1);
    const result = await f.app.fetch(f.request('/requests/' + id));
    assert.equal((await result.json()).output, 'PRIVATE_OUTPUT');
    assert.ok(f.diagnostics.snapshot().totals.sinkFailures > 0);
  });

  test(`${mode}: committed claim with lost ACK stays UNKNOWN and never dispatches or replays`, async t => {
    const f = await fixture(t, mode), id = randomUUID(); assert.equal((await f.save()).status, 200);
    f.behavior.after = (kind, input) => {
      if (kind === 'quickChatExecution' && (input as { command: { action: string } }).command.action === 'claim') throw Error('lost original ACK');
    };
    assert.equal((await f.send(id)).status, 503); assert.equal(f.behavior.posts, 0);
    delete f.behavior.after;
    const recovered = await f.send(id); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).receipt.state, 'unknown');
    assert.equal(f.behavior.posts, 0);
  });

  test(`${mode}: revoked caller cannot receive output but original provider fact still settles`, async t => {
    const f = await fixture(t, mode), provider = deferred<Response>(), started = deferred<void>(), id = randomUUID();
    assert.equal((await f.save()).status, 200);
    f.behavior.provider = () => { started.resolve(); return provider.promise; };
    const work = f.send(id);
    try {
      await started.promise;
      assert.ok(await f.owner.command('memberKeyRevoke', { ...await f.proof(f.observer.token), userId: 'default', keyId: f.key.id, fingerprint: {} }));
      provider.resolve(done()); assert.equal((await work).status, 401);
      const recovered = await f.app.fetch(f.request('/requests/' + id, 'GET', undefined, f.observer.token));
      assert.equal(recovered.status, 200); assert.equal((await recovered.json()).output, 'PRIVATE_OUTPUT');
      assert.equal(f.behavior.posts, 1);
    } finally { provider.resolve(done()); await work; }
  });

  test(`${mode}: administrative close cannot fence original settlement; service close waits its ACK`, async t => {
    const f = await fixture(t, mode), held = deferred<void>(), entered = deferred<void>(), id = randomUUID();
    assert.equal((await f.save()).status, 200);
    f.behavior.after = async (kind, input) => {
      if (kind === 'quickChatEffect' && (input as { action: string }).action === 'settle') { entered.resolve(); await held.promise; }
    };
    const work = f.send(id);
    try {
      await entered.promise; await f.group.close();
      assert.throws(() => f.group.createQuickChatExecution());
      let closed = false; const close = f.service.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      held.resolve(); await work; await close; assert.equal(closed, true); assert.equal(f.behavior.posts, 1);
    } finally { held.resolve(); await work; }
  });

  test(`${mode}: close during awaited admission never starts provider, retains durable admission`, async t => {
    const f = await fixture(t, mode), held = deferred<void>(), entered = deferred<void>(), id = randomUUID();
    assert.equal((await f.save()).status, 200);
    f.behavior.after = async (kind, input) => {
      if (kind === 'quickChatExecution' && (input as { command: { action: string } }).command.action === 'admit') { entered.resolve(); await held.promise; }
    };
    const work = f.send(id);
    try {
      await entered.promise;
      let closed = false; const close = f.service.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false); held.resolve(); await work; await close;
      assert.equal(f.behavior.posts, 0);
      const state = await f.owner.command('quickChatState', { ...await f.proof(), command: { action: 'inspect', requestId: id } });
      assert.equal(state?.receipt?.state, 'admitted');
    } finally { held.resolve(); await work; }
  });

  test(`${mode}: settlement proof rejects forged/cross-user requests and clear cannot resurrect output`, async t => {
    const f = await fixture(t, mode), id = randomUUID();
    const profile = { id: f.profileId, name: 'Profile', target: 'fixed', model: 'fixed', outputLimit: 100 };
    const save = { action: 'save', revision: 0, profile, capability } as const;
    assert.ok(validHubQuickChatExecutionReply(save, await f.command(save)));
    await f.command({ action: 'admit', requestId: id, profileId: f.profileId, revision: 1, identityInput: 'PRIVATE_PROMPT', capability });
    const claim = await f.command({ action: 'claim', requestId: id, identityInput: 'PRIVATE_PROMPT', capability });
    assert.ok(claim?.claimed && claim.settlementProof);
    const repeated = await f.command({ action: 'claim', requestId: id, identityInput: 'PRIVATE_PROMPT', capability });
    assert.equal(repeated?.claimed, false); assert.equal(repeated?.settlementProof, null);
    const settle = { action: 'settle', ownerUserId: 'default', requestId: id, proof: claim.settlementProof, output: 'PRIVATE_OUTPUT' } as const;
    assert.equal((await f.owner.command('quickChatEffect', { ...settle, proof: '0'.repeat(64) })).ok, false);
    assert.equal((await f.owner.command('quickChatEffect', { ...settle, ownerUserId: 'other' })).ok, false);
    const result = await f.owner.command('quickChatEffect', settle); assert.equal(result.ok, true); assert.ok(validHubQuickChatEffectReply(settle, result));
    await f.owner.command('quickChatCleanup', { ...await f.proof(), command: { action: 'clear', requestId: id } });
    assert.equal((await f.owner.command('quickChatEffect', settle)).ok, true);
    const state = await f.owner.command('quickChatState', { ...await f.proof(), command: { action: 'inspect', requestId: id } });
    assert.equal(state?.receipt?.state, 'completed'); assert.equal(state?.output, null);
  });

  test(`${mode}: stale scope, capability epoch and profile revision never grant a dispatch proof`, async t => {
    const f = await fixture(t, mode), id = randomUUID();
    const profile = { id: f.profileId, name: 'Profile', target: 'fixed', model: 'fixed', outputLimit: 100 };
    await f.command({ action: 'save', revision: 0, profile, capability });
    const admit = { action: 'admit', requestId: id, profileId: f.profileId, revision: 1, identityInput: 'PRIVATE_PROMPT', capability } as const;
    assert.equal(await f.owner.command('quickChatExecution', { ...await f.proof(), expectedScope: '0'.repeat(64), command: admit }), null);
    await f.command(admit);
    const changedEpoch = await f.command({ action: 'claim', requestId: id, identityInput: 'PRIVATE_PROMPT', capability: { ...capability, epoch: 'changed' } });
    assert.equal(changedEpoch?.error, 'preflight'); assert.equal(changedEpoch?.settlementProof, null);
    await f.command({ action: 'save', revision: 1, profile, capability });
    const changedProfile = await f.command({ action: 'claim', requestId: id, identityInput: 'PRIVATE_PROMPT', capability });
    assert.equal(changedProfile?.error, 'preflight'); assert.equal(changedProfile?.settlementProof, null);
    const other = await f.command({ action: 'lookup', requestId: id, profileId: f.profileId }, f.otherKey.token);
    assert.equal(other?.receipt, null); assert.equal(other?.profile, null); assert.equal(f.behavior.posts, 0);
  });

  test(`${mode}: reopening sole owner invalidates an old generation settlement proof without releasing UNKNOWN`, async t => {
    const f = await fixture(t, mode), id = randomUUID();
    await f.command({ action: 'save', revision: 0, profile: { id: f.profileId, name: 'P', target: 'fixed', model: 'fixed', outputLimit: 100 }, capability });
    await f.command({ action: 'admit', requestId: id, profileId: f.profileId, revision: 1, identityInput: 'PRIVATE_PROMPT', capability });
    const claim = await f.command({ action: 'claim', requestId: id, identityInput: 'PRIVATE_PROMPT', capability });
    assert.ok(claim?.settlementProof);
    await f.service.close(); await f.group.close(); await f.owner.close(); await f.original?.close();
    const reopened = new HubStore(f.file, 'fixture');
    try {
      const owner = new OriginalHubAdministrativeCommands(reopened, new PerformanceDiagnostics(() => {}));
      assert.equal((await owner.command('quickChatEffect', { action: 'settle', ownerUserId: 'default', requestId: id,
        proof: claim.settlementProof, output: 'PRIVATE_OUTPUT' })).ok, false);
      assert.equal(reopened.quickChat.receipt('default', id)?.state, 'unknown');
      await owner.close();
    } finally { await reopened.close(); }
  });
}

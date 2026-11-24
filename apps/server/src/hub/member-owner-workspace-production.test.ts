import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';

const base = '/api/hub/v1/workspace/';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const preferences = () => ({ revision: 0, groups: [{ id: 'existing', name: 'PRIVATE_GROUP', collapsed: true }],
  sessions: { 'node:existing': { groupId: 'existing', color: '#123456', order: 4, tags: ['old'] } } });
const current = () => ({ revision: 0, content: JSON.stringify({ id: 'current', name: 'Current',
  workspace: { version: 2, panes: [], floating: [], active: null }, collapsedKeys: [] }) });
const saved = () => ({ revision: 0, content: '[]' });
const domains = [
  { path: 'preferences', get: 'workspaceGet', save: 'workspaceSave', value: preferences },
  { path: 'layouts/current', get: 'layoutGet', save: 'layoutSave', value: current },
  { path: 'layouts/saved', get: 'layoutGet', save: 'layoutSave', value: saved },
] as const;
const changed = (domain: typeof domains[number], document: object) => ({ ...document,
  ...(domain.path === 'preferences' ? { ungroupedCollapsed: true }
    : { content: domain.path.endsWith('saved') ? '[ ]' : current().content.replace('"active":null', '"active":"changed"') }) });

async function fixture(t: TestContext, mode: 'original' | 'worker') {
  const root = mkdtempSync(join(tmpdir(), 'workspace-production-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Existing member');
  const key = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const other = seed.createUser('Other member'), otherKey = seed.identities.issueKey(other.id);
  const expected = seed.workspace.save(member.id, preferences())!;
  const expectedCurrent = seed.layouts.save(member.id, 'current', current())!;
  const expectedSaved = seed.layouts.save(member.id, 'saved', saved())!;
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  // Composition metadata is deliberately separate, never a second writer of
  // the worker's database. Every request-time synchronous access is a trap.
  const metadata = original ?? new HubStore(join(root, 'composition.sqlite'), 'metadata');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const behavior: { after?: (kind: HubMemberKind) => void | Promise<void>; commands: HubMemberKind[]; sync: number } = { commands: [], sync: 0 };
  const port = { command: async (kind: HubMemberKind, value: never) => {
    behavior.commands.push(kind); const result = await owner.command(kind, value); await behavior.after?.(kind); return result;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics);
  let guarded = false;
  const store = new Proxy(metadata, { get(target, key, receiver) {
    if (guarded) throw Error('SYNC_WORKSPACE_STORE_FALLBACK'); return Reflect.get(target, key, receiver);
  } });
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' });
  const app = new Hono(), routes = registerHubRoutes(app, { config, hubStore: store, administrative: group,
    principal: () => { behavior.sync++; return undefined; },
    connectorClient: () => { throw Error('UNEXPECTED_CONNECTOR'); }, normalizeError: () => 'safe' });
  guarded = true;
  const request = (path: string, body?: unknown, headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }, method = body === undefined ? 'GET' : 'PUT') =>
    new Request('http://hub.invalid' + base + path, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const revoke = async () => {
    const evidence = hubMemberEvidence(request('preferences', undefined, { 'x-agentopsdeck-key': admin.token }));
    const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    await owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope, userId: member.id, keyId: key.id });
  };
  let closed: Promise<void> | undefined;
  const close = () => closed ??= routes!.close();
  const retire = async () => { await owner.close(); await original?.close(); };
  t.after(async () => { guarded = false; await close(); await group.close(); await owner.close(); await metadata.close();
    rmSync(root, { recursive: true, force: true }); });
  return { root, file, app, owner, key, cookie, otherKey, behavior, request, revoke, close, retire, logs,
    // HTTP and worker serialization intentionally discard SQLite row prototypes.
    expected: JSON.parse(JSON.stringify([expected, expectedCurrent, expectedSaved])) as
      [typeof expected, typeof expectedCurrent, typeof expectedSaved], member };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} production workspace reads and saves retain existing documents, Key/Cookie, HEAD, CAS and isolation`, async t => {
    const f = await fixture(t, mode);
    for (const [index, domain] of domains.entries()) {
      const response = await f.app.fetch(f.request(domain.path)); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), f.expected[index]);
      for (const headers of [{ cookie: 'agentopsdeck_session=' + f.cookie }, { cookie: 'agentopsdeck_access=' + f.key.token }]) {
        const read = await f.app.fetch(f.request(domain.path, undefined, headers)); assert.equal(read.status, 200);
        assert.deepEqual(await read.json(), f.expected[index]);
      }
      const head = await f.app.fetch(f.request(domain.path, undefined, undefined, 'HEAD'));
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
      const own = await (await f.app.fetch(f.request(domain.path, undefined, { 'x-agentopsdeck-key': f.otherKey.token }))).json();
      assert.equal(own.revision, 0);
      const body = changed(domain, f.expected[index]!);
      const written = await f.app.fetch(f.request(domain.path, body)); assert.equal(written.status, 200);
      const document = await written.json(); assert.equal(document.revision, 2);
      const replay = await f.app.fetch(f.request(domain.path, body));
      assert.equal(replay.status, domain.path === 'preferences' ? 409 : 200);
      if (domain.path !== 'preferences') assert.deepEqual(await replay.json(), document, 'original layout lost-response idempotence');
      const conflict = await f.app.fetch(f.request(domain.path, domain.value()));
      assert.equal(conflict.status, 409);
      assert.equal((await (await f.app.fetch(f.request(domain.path))).json()).revision, 2);
    }
    assert.equal(f.behavior.sync, 0);
    for (const secret of [f.key.token, f.cookie, 'PRIVATE_GROUP', 'node:existing']) assert.equal(f.logs.join('').includes(secret), false);
    await f.close(); await f.retire();
    const reopened = new HubStore(f.file, 'fixture');
    try {
      assert.equal(reopened.workspace.get(f.member.id).revision, 2);
      assert.equal(reopened.workspace.get(f.member.id).ungroupedCollapsed, true);
      assert.equal(reopened.layouts.get(f.member.id, 'current').revision, 2);
      assert.equal(reopened.layouts.get(f.member.id, 'saved').revision, 2);
      assert.ok(reopened.identities.requestPrincipal(f.request('preferences', undefined, { cookie: 'agentopsdeck_session=' + f.cookie }), () => false));
    } finally { await reopened.close(); }
  });

  test(`${mode} exact workspace bypass keeps capability, authentication, scope, kind and unknown-method guards`, async t => {
    const f = await fixture(t, mode);
    for (const domain of domains) {
      for (const token of ['aod_board_synthetic', 'aod_note_synthetic', 'invalid']) {
        assert.equal((await f.app.fetch(f.request(domain.path, undefined, { 'x-agentopsdeck-key': token }))).status, 401);
      }
      assert.equal((await f.app.fetch(f.request(domain.path, undefined, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'wrong' }))).status, 409);
      assert.equal((await f.app.fetch(f.request(domain.path, { ...domain.value(), userId: 'other' }))).status, 400);
    }
    assert.equal((await f.app.fetch(f.request('layouts/unknown'))).status, 404);
    assert.equal((await f.app.fetch(f.request('layouts/unknown', undefined, {}))).status, 401);
    assert.equal(f.behavior.sync, 0);
    assert.equal((await f.app.fetch(f.request('preferences', undefined, undefined, 'PATCH'))).status, 401);
    assert.equal(f.behavior.sync, 1);
    assert.equal(f.behavior.commands.filter(kind => kind === 'workspaceSave' || kind === 'layoutSave').length, 0);
  });

  for (const domain of domains) {
    test(`${mode} ${domain.path} revocation after committed CAS refuses delivery without replay`, async t => {
      const f = await fixture(t, mode);
      f.behavior.after = async kind => { if (kind === domain.save) { delete f.behavior.after; await f.revoke(); } };
      const response = await f.app.fetch(f.request(domain.path, changed(domain, f.expected[domains.indexOf(domain)]!)));
      assert.equal(response.status, 401); assert.equal(f.behavior.commands.filter(kind => kind === domain.save).length, 1);
      await f.close(); await f.retire();
      const reopened = new HubStore(f.file, 'fixture');
      try { assert.equal(domain.path === 'preferences' ? reopened.workspace.get(f.member.id).revision
        : reopened.layouts.get(f.member.id, domain.path.endsWith('current') ? 'current' : 'saved').revision, 2); }
      finally { await reopened.close(); }
    });

    test(`${mode} ${domain.path} lost ACK is unavailable, original commit survives and is not retried`, async t => {
      const f = await fixture(t, mode);
      f.behavior.after = kind => { if (kind === domain.save) throw Error('PRIVATE_ACK_FAILURE'); };
      const response = await f.app.fetch(f.request(domain.path, changed(domain, f.expected[domains.indexOf(domain)]!)));
      assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE_ACK_FAILURE|PRIVATE_GROUP/);
      assert.equal(f.behavior.commands.filter(kind => kind === domain.save).length, 1);
      delete f.behavior.after;
      const recovered = await f.app.fetch(f.request(domain.path)); assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).revision, 2);
    });

    test(`${mode} ${domain.path} close retains original ACK and rejects late successful delivery`, async t => {
      const f = await fixture(t, mode), entered = deferred(), release = deferred();
      f.behavior.after = async kind => { if (kind === domain.save) { entered.resolve(); await release.promise; } };
      const pending = f.app.fetch(f.request(domain.path, changed(domain, f.expected[domains.indexOf(domain)]!)));
      await entered.promise; let drained = false; const close = f.close().then(() => { drained = true; });
      try {
        await tick(); assert.equal(drained, false);
        assert.equal((await f.app.fetch(f.request(domain.path))).status, 503);
      } finally { release.resolve(); }
      const response = await pending; assert.equal(response.status, 503); await close;
      assert.equal(f.behavior.commands.filter(kind => kind === domain.save).length, 1);
    });

    test(`${mode} ${domain.path} body wait remains owned through close and cannot late-dispatch CAS`, async t => {
      const f = await fixture(t, mode), authorized = deferred(), release = deferred();
      f.behavior.after = kind => { if (kind === 'memberSnapshot') authorized.resolve(); };
      const body = new ReadableStream<Uint8Array>({ async start(controller) {
        await release.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify(f.expected[domains.indexOf(domain)]))); controller.close();
      } });
      const pending = f.app.fetch(new Request('http://hub.invalid' + base + domain.path,
        { method: 'PUT', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit));
      await authorized.promise; await tick(); let drained = false; const close = f.close().then(() => { drained = true; });
      try { await tick(); assert.equal(drained, false); } finally { release.resolve(); }
      assert.equal((await pending).status, 503); await close;
      assert.equal(f.behavior.commands.filter(kind => kind === domain.save).length, 0);
    });

    test(`${mode} ${domain.path} revocation during body wait is denied before CAS`, async t => {
      const f = await fixture(t, mode), authorized = deferred(), release = deferred();
      f.behavior.after = kind => { if (kind === 'memberSnapshot') authorized.resolve(); };
      const body = new ReadableStream<Uint8Array>({ async start(controller) {
        await release.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify(f.expected[domains.indexOf(domain)]))); controller.close();
      } });
      const pending = f.app.fetch(new Request('http://hub.invalid' + base + domain.path,
        { method: 'PUT', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit));
      try { await authorized.promise; await f.revoke(); } finally { release.resolve(); }
      assert.equal((await pending).status, 401);
      assert.equal(f.behavior.commands.filter(kind => kind === domain.save).length, 0);
    });
  }
}

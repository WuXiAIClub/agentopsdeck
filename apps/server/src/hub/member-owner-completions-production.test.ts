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
import { connectionCompletionTarget } from './completion-unread-store.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';

const base = 'http://hub.invalid/api/hub/v1/completions/';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const actions = [
  { action: 'summary', kind: 'completionSummary' },
  { action: 'observe', kind: 'completionObserve' },
  { action: 'read', kind: 'completionRead' },
] as const;

async function fixture(t: TestContext, mode: 'original' | 'worker', collision = false) {
  const root = mkdtempSync(join(tmpdir(), 'completions-production-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Existing member');
  const key = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const other = seed.createUser('Other member'), otherKey = seed.identities.issueKey(other.id);
  seed.upsertConnection({ id: 'node', ownerUserId: member.id, label: 'Node', connectorUrl: 'http://node.invalid',
    credentialToken: 'PRIVATE_CREDENTIAL', capabilities: ['events'] });
  seed.pinConnectionNode('node', member.id, seed.connectionAuthority('node', member.id)!, 'node_00000000-0000-4000-8000-000000000001');
  const sessionKey = encodeHubSessionId('node', 'codex:PRIVATE_SESSION');
  const target = connectionCompletionTarget(seed.getConnection('node', member.id)!.nodeId!, 'node',
    seed.connectionAuthority('node', member.id)!, 'codex:PRIVATE_SESSION');
  seed.completions.baseline(member.id, target, 'original-epoch', 10);
  seed.completions.record({ owner: member.id, target, epoch: 'original-epoch', turnId: 'original-turn',
    sourceCursor: 11, provenance: 'live-successful-message' });
  const observation = seed.completions.observe(member.id, target);
  let otherTarget: string | undefined;
  if (collision) {
    seed.upsertConnection({ id: 'node', ownerUserId: other.id, label: 'Node', connectorUrl: 'http://other.invalid',
      credentialToken: 'PRIVATE_OTHER_CREDENTIAL', capabilities: ['events'] });
    seed.pinConnectionNode('node', other.id, seed.connectionAuthority('node', other.id)!, 'node_00000000-0000-4000-8000-000000000002');
    otherTarget = connectionCompletionTarget(seed.getConnection('node', other.id)!.nodeId!, 'node',
      seed.connectionAuthority('node', other.id)!, 'codex:PRIVATE_SESSION');
    seed.completions.baseline(other.id, otherTarget, 'original-epoch', 10);
    for (const [turnId, sourceCursor] of [['original-turn', 11], ['other-turn', 12]] as const)
      seed.completions.record({ owner: other.id, target: otherTarget, epoch: 'original-epoch', turnId,
        sourceCursor, provenance: 'live-successful-message' });
  }
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  // Separate composition metadata is NOT another writer of the owner's DB.
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
  let guarded = false, routes: ReturnType<typeof registerHubRoutes>;
  const store = new Proxy(metadata, { get(target, key, receiver) {
    if (guarded) throw Error('SYNC_COMPLETIONS_STORE_FALLBACK'); return Reflect.get(target, key, receiver);
  } });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= routes?.close() ?? Promise.resolve();
  t.after(async () => { guarded = false; await close(); await group.close(); await owner.close(); await metadata.close();
    rmSync(root, { recursive: true, force: true }); });
  const app = new Hono();
  routes = registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: store,
    administrative: group, principal: () => { behavior.sync++; return undefined; },
    connectorClient: () => { throw Error('UNEXPECTED_CONNECTOR'); }, normalizeError: () => 'safe' });
  guarded = true;
  const input = (action: string) => action === 'summary' ? { sessions: [sessionKey] } : action === 'observe' ? { sessionKey }
    : { sessionKey, requestId: 'original-receipt', token: observation.token, throughSequence: 1 };
  const request = (action: string, body = input(action), headers: Record<string, string> = { 'x-agentopsdeck-key': key.token }, method = 'POST') =>
    new Request(base + action, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  const evidence = hubMemberEvidence(request('summary'));
  const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
  const proof = { evidence, expectedScope: snapshot.recoveryScope };
  const revoke = async () => {
    const evidence = { accessKey: admin.token };
    const adminSnapshot = await owner.command('memberSnapshot', evidence); assert.ok(adminSnapshot);
    await owner.command('memberKeyRevoke', { evidence, expectedScope: adminSnapshot.recoveryScope, userId: member.id, keyId: key.id });
  };
  const change = async (action: 'disable' | 'credential' | 'delete' | 'label') => {
    const current = await owner.command('connectionTarget', { ...proof, id: 'node' });
    assert.ok(current && 'epoch' in current);
    const common = { id: 'node', expectedEpoch: current.epoch };
    await owner.command('connectionChange', { ...proof, change: action === 'credential'
      ? { ...common, action: 'maintenance', token: 'PRIVATE_REPLACEMENT' }
      : action === 'delete' ? { ...common, action: 'delete' }
      : { ...common, action: 'patch', configuration: action === 'disable' ? { enabled: false } : { label: 'Renamed' } } });
  };
  const retire = async () => { await owner.close(); await original?.close(); };
  return { app, owner, behavior, key, cookie, otherKey, sessionKey, target, member, observation, logs,
    input, request, revoke, change, close, retire, file, proof, other, otherTarget };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} same-name Connector notifications and ACK UUID stay owner scoped across reopen`, async t => {
    const f = await fixture(t, mode, true), otherHeaders = { 'x-agentopsdeck-key': f.otherKey.token };
    const summary = async (headers?: Record<string, string>) => {
      const response = await f.app.fetch(f.request('summary', undefined, headers)); assert.equal(response.status, 200);
      return (await response.json()).items[0];
    };
    const first = await summary(), second = await summary(otherHeaders);
    assert.equal(first.latestSequence, 1); assert.equal(second.latestSequence, 2);
    assert.notEqual(first.displayTarget, second.displayTarget);
    assert.equal((await f.app.fetch(f.request('read', f.input('read'), otherHeaders))).status, 409,
      'another owner cannot consume the original observation token even with identical session/request IDs');
    const observed = await f.app.fetch(f.request('observe', undefined, otherHeaders)); assert.equal(observed.status, 200);
    const otherObservation = await observed.json(); assert.equal(otherObservation.throughSequence, 2);
    const read = await f.app.fetch(f.request('read', { sessionKey: f.sessionKey, requestId: 'original-receipt',
      token: otherObservation.token, throughSequence: 2 }, otherHeaders));
    assert.equal(read.status, 200); assert.deepEqual(await read.json(), { throughSequence: 2 });
    assert.equal((await summary()).unread, true); assert.equal((await summary(otherHeaders)).unread, false);
    assert.equal((await f.app.fetch(f.request('read'))).status, 200, 'same ACK UUID has an independent original owner');
    await f.close(); await f.retire();
    const reopened = new HubStore(f.file, 'fixture');
    try {
      assert.equal(reopened.completions.summary(f.member.id, [f.target])[0]!.readThrough, 1);
      assert.equal(reopened.completions.summary(f.other.id, [f.otherTarget!])[0]!.readThrough, 2);
    } finally { await reopened.close(); }
    assert.equal(f.behavior.sync, 0);
  });
  test(`${mode} production completions preserve existing unread, Key/Cookies, read receipts and reopen`, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{ 'x-agentopsdeck-key': f.key.token }, { cookie: 'agentopsdeck_access=' + f.key.token }, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      const response = await f.app.fetch(f.request('summary', undefined, headers));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const rows = await response.json(); assert.equal(rows.items.length, 1); assert.equal(rows.items[0].unread, true);
      assert.deepEqual(Object.keys(rows.items[0]).sort(), ['coverage', 'displayTarget', 'generation', 'latestSequence', 'readThrough', 'sessionKey', 'unread']);
    }
    assert.deepEqual(await (await f.app.fetch(f.request('summary', undefined, { 'x-agentopsdeck-key': f.otherKey.token }))).json(), { items: [] });
    assert.equal((await f.app.fetch(f.request('observe', undefined, { 'x-agentopsdeck-key': f.otherKey.token }))).status, 404);
    const observed = await f.app.fetch(f.request('observe')); assert.equal(observed.status, 200);
    assert.equal((await observed.json()).throughSequence, 1);
    for (let retry = 0; retry < 2; retry++) assert.deepEqual(await (await f.app.fetch(f.request('read'))).json(), { throughSequence: 1 });
    assert.equal(f.behavior.sync, 0); assert.equal(f.behavior.commands.includes('connectionDirectory'), false, 'no full directory materialization');
    await f.close(); await f.retire();
    const reopened = new HubStore(f.file, 'fixture');
    try {
      assert.equal(reopened.completions.summary(f.member.id, [f.target])[0]!.readThrough, 1);
      assert.ok(reopened.identities.requestPrincipal(f.request('summary', undefined, { cookie: 'agentopsdeck_session=' + f.cookie }), () => false));
    } finally { await reopened.close(); }
    for (const secret of [f.key.token, f.cookie, f.sessionKey, f.observation.token, 'PRIVATE_CREDENTIAL']) assert.equal(f.logs.join('').includes(secret), false);
  });

  test(`${mode} completions exact bypass preserves capability, invalid key, scope and unknown method guards`, async t => {
    const f = await fixture(t, mode);
    for (const { action } of actions) {
      for (const token of ['aod_board_synthetic', 'aod_note_synthetic', 'invalid'])
        assert.equal((await f.app.fetch(f.request(action, undefined, { 'x-agentopsdeck-key': token }))).status, 401);
      assert.equal((await f.app.fetch(f.request(action, undefined, { 'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'b'.repeat(64) }))).status, 409);
      assert.equal((await f.app.fetch(f.request(action, undefined, undefined, 'GET'))).status, 401);
    }
    assert.equal(f.behavior.commands.filter(kind => actions.some(a => a.kind === kind)).length, 0);
  });

  for (const { action, kind: command } of actions) {
    for (const mutation of ['revoke', 'disable', 'credential', 'delete', 'label', 'check-gap'] as const)
      test(`${mode} completion ${action} refuses ${mutation} after original transaction without replay`, async t => {
        const f = await fixture(t, mode); let changed = false;
        f.behavior.after = async kind => {
          if (changed || kind !== (mutation === 'check-gap' ? 'connectionDirectoryCheck' : command)) return;
          changed = true;
          if (mutation === 'revoke') await f.revoke(); else await f.change(mutation === 'check-gap' ? 'credential' : mutation);
        };
        const response = await f.app.fetch(f.request(action));
        assert.equal(response.status, mutation === 'revoke' ? 401 : 503);
        assert.equal(f.behavior.commands.filter(kind => kind === command).length, 1);
        assert.doesNotMatch(await response.text(), /PRIVATE_|SYNC_/);
      });

    test(`${mode} completion ${action} lost ACK is unavailable and original effect survives once`, async t => {
      const f = await fixture(t, mode);
      f.behavior.after = kind => { if (kind === command) throw Error('PRIVATE_ACK_FAILURE'); };
      const response = await f.app.fetch(f.request(action)); assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /PRIVATE_ACK_FAILURE/);
      assert.equal(f.behavior.commands.filter(kind => kind === command).length, 1);
      delete f.behavior.after; await f.close(); await f.retire();
      const reopened = new HubStore(f.file, 'fixture');
      try {
        const db = (reopened as unknown as { db: DatabaseSync }).db;
        assert.equal(db.prepare('SELECT count(*) n FROM completion_observations').get()!.n, action === 'observe' ? 2 : 1);
        assert.equal(db.prepare('SELECT count(*) n FROM completion_acks').get()!.n, action === 'read' ? 1 : 0);
      } finally { await reopened.close(); }
    });

    test(`${mode} completion ${action} close waits original ACK and withholds late delivery`, async t => {
      const f = await fixture(t, mode), entered = deferred(), release = deferred();
      f.behavior.after = async kind => { if (kind === command) { entered.resolve(); await release.promise; } };
      const pending = f.app.fetch(f.request(action)); await entered.promise;
      let drained = false; const close = f.close().then(() => { drained = true; });
      try { await tick(); assert.equal(drained, false); assert.equal((await f.app.fetch(f.request(action))).status, 503); }
      finally { release.resolve(); }
      assert.equal((await pending).status, 503); await close;
      assert.equal(f.behavior.commands.filter(kind => kind === command).length, 1);
    });

    for (const boundary of ['close', 'revoke'] as const)
      test(`${mode} completion ${action} ${boundary} during body wait cannot late-dispatch`, async t => {
        const f = await fixture(t, mode), authorized = deferred(), release = deferred();
        f.behavior.after = kind => { if (kind === 'memberSnapshot') authorized.resolve(); };
        const body = new ReadableStream<Uint8Array>({ async start(controller) {
          await release.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify(f.input(action)))); controller.close();
        } });
        const pending = f.app.fetch(new Request(base + action, { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token },
          body, duplex: 'half' } as RequestInit));
        await authorized.promise; await tick(); let drained = false;
        const close = boundary === 'close' ? f.close().then(() => { drained = true; }) : undefined;
        try { if (boundary === 'revoke') await f.revoke(); else { await tick(); assert.equal(drained, false); } }
        finally { release.resolve(); }
        assert.equal((await pending).status, boundary === 'close' ? 503 : 401); await close;
        assert.equal(f.behavior.commands.filter(kind => kind === command).length, 0);
      });
  }
}

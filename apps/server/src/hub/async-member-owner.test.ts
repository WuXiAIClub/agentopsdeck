import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { encodeHubSessionId } from './session-id.js';
import { validHubContentDocumentCommand } from './member-content-document-domain.js';
import { AsyncHubMemberOwner, encodeHubMemberJson } from './async-member-owner.js';
import { executeHubMemberCommand, hubMemberEvidence, validHubMemberInput,
  validHubMemberOutput, HubMemberOwnerUnavailable, hubMemberOwnerConfig, hubMemberKinds, hubMemberCommandSteps,
  hubMemberResultBytes, HUB_MEMBER_RESULT_BUDGET } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const silence = new PerformanceDiagnostics(() => {});
test('command telemetry retains legacy IDs and complete unique append-only mapping', () => {
  const legacy = ['memberSnapshot', 'memberSessionCreate', 'memberSessionDelete',
    'memberKeysRead', 'memberKeyIssue', 'memberKeyRevoke', 'loginLimiterCheck', 'loginLimiterFailure', 'loginLimiterSuccess',
    'auditAppend', 'auditPage', 'auditList', 'workspaceGet', 'workspaceSave', 'layoutGet', 'layoutSave',
    'completionSummary', 'completionObserve', 'completionRead', 'sessionPreferenceSet', 'memberActivity',
    'connectionSnapshot', 'userChange', 'connectionTarget', 'connectionChange', 'roleRead', 'roleSet',
    'accessDirectory', 'membershipRead', 'membershipSet', 'grantRead', 'grantChange', 'receivedGrants',
    'creationEnvironments', 'sessionCollaborators', 'sessionSharing', 'ownedSessionSharing', 'sessionGuidance',
    'quickChatState', 'quickChatCleanup', 'eventAppend', 'executionLease', 'connectorAccess'] as const;
  assert.deepEqual(Object.keys(hubMemberCommandSteps).sort(), [...hubMemberKinds].sort());
  assert.equal(new Set(Object.values(hubMemberCommandSteps)).size, hubMemberKinds.length);
  for (const [index, kind] of legacy.entries()) assert.equal(hubMemberCommandSteps[kind], index + 1);
  assert.equal(hubMemberCommandSteps.ownerControl, 44); assert.equal(hubMemberCommandSteps.executionIssuer, 45);
  assert.equal(hubMemberCommandSteps.workspaceBoard, 46);
  assert.equal(hubMemberCommandSteps.boardCapability, 47);
  assert.equal(hubMemberCommandSteps.boardMachine, 48);
  assert.equal(hubMemberCommandSteps.personalNotebook, 49);
  assert.equal(hubMemberCommandSteps.sharedDirectory, 50);
  assert.equal(hubMemberCommandSteps.notebookControl, 53);
  assert.equal(Object.isFrozen(hubMemberCommandSteps), true);
});
async function seed(file: string) {
  const original = new HubStore(file, 'private-fixture-vault');
  const key = original.identities.issueKey('default').token;
  await original.close();
  return key;
}
async function disk<T>(work: (file: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'hub-member-owner-'));
  try { return await work(join(root, 'hub.sqlite')); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { this.stops++; return Promise.resolve(1); }
  ready() { this.emit('message', { kind: 'ready' }); }
  reply(index: number, value: unknown) {
    const r = this.messages[index]!;
    this.emit('message', { id: r.id, kind: r.kind, ok: true, body: JSON.stringify(value) });
  }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const metadata of [undefined, {}, { hubId: '' }, { hubId: 'private\nvalue' }, { hubId: 'x'.repeat(4097) }, { hubId: 'original', extra: true }]) {
  test('bootstrapped owner refuses malformed ready metadata and retains path until physical exit: ' + JSON.stringify(metadata)?.slice(0, 80), async () => {
    const fake = new FakeWorker();
    const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-member-fake-metadata.sqlite'),
      bootstrap: { legacyPreferences: { hidden: 'h.json', archived: 'a.json', pinned: 'p.json' } } }, silence, () => fake as unknown as Worker);
    const failed = assert.rejects(owner.open(), HubMemberOwnerUnavailable);
    fake.emit('message', { kind: 'ready', ...(metadata === undefined ? {} : { metadata }) }); await failed;
    assert.equal(owner.snapshot().ready, false); assert.throws(() => owner.metadata);
    assert.equal(fake.stops, 0); assert.equal(owner.snapshot().ownerExitConfirmed, false);
    const closing = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await closing;
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
  });
}

test('maintenance ACK must correlate original action; mismatch fences without replay', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-member-fake-maintenance.sqlite') }, silence, () => fake as unknown as Worker);
  fake.ready();
  const work = owner.command('storageMaintenance', { evidence: {}, expectedScope: 'a'.repeat(64), command: { action: 'stats' } });
  const failed = assert.rejects(work, HubMemberOwnerUnavailable); await tick();
  assert.equal(fake.messages.length, 1);
  fake.reply(0, { action: 'recovery', value: { state: 'ready', attempts: 0 } }); await failed;
  assert.equal(owner.snapshot().unavailable, true); assert.equal(fake.messages.length, 1);
  const closing = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await closing;
});

for(const mode of ['original','worker'] as const)test(`${mode}: content batch accepts original 10000-session catalog through actual owner codec`,()=>disk(async file=>{
  const store=new HubStore(file,'private-fixture-vault'),key=store.identities.issueKey('default').token;
  store.upsertConnection({id:'local',kind:'local',label:'Local',connectorUrl:'local://aod-connector'});
  store.pinConnectionNode('local','default',store.connectionAuthority('local','default')!,'node_'+randomUUID());
  const resourceId=JSON.stringify(['taskboard','default']),sessions=['codex:one','codex:two'].map(s=>encodeHubSessionId('local',s));
  store.workspace.save('default',{revision:0,groups:[],sessions:Object.fromEntries(sessions.map(s=>[s,{tags:['review']}]))});
  await store.createContentDocumentStore().initializeAsync('default',resourceId,randomUUID(),JSON.stringify({kind:'taskboard',content:{title:'catalog',tasks:[]}}));
  if(mode==='worker')await store.close();
  const owner=mode==='worker'?new AsyncHubMemberOwner({file,encryptionSecret:'private-fixture-vault'},silence):new OriginalHubAdministrativeCommands(store,silence);
  try{
    const evidence={accessKey:key},snapshot=await owner.command('memberSnapshot',evidence);assert.ok(snapshot);
    const proof={evidence,expectedScope:snapshot.recoveryScope},directory=await owner.command('contentDocument',{...proof,command:{action:'batch-directory',resourceId}});
    assert.ok(directory&&'action'in directory&&directory.action==='batch-directory');
    const {connections:_,...fence}=directory.directory,id=randomUUID(),selection={tags:['review'],tagMode:'all' as const};
    const input={action:'batch-prepare' as const,resourceId,id,selection,catalog:{...fence,sessions}};
    const prepared=await owner.command('contentDocument',{...proof,command:input});
    assert.ok(prepared&&'action'in prepared&&prepared.action==='batch-prepare');assert.equal(prepared.batch.members.length,2);
    const full=[...sessions,...Array.from({length:9998},(_,n)=>encodeHubSessionId('local','codex:catalog-'+n))];
    const large={...input,catalog:{...fence,sessions:full}};
    assert.equal(validHubContentDocumentCommand(large),true);
    assert.throws(()=>encodeHubMemberJson(full,2_000_000),HubMemberOwnerUnavailable,'other domains retain original 8192 array ceiling');
    assert.deepEqual(await owner.command('contentDocument',{...proof,command:large}),prepared,'reentrant batch keeps original receipt and members');
    const tooLarge={...large,catalog:{...large.catalog,sessions:[...full,encodeHubSessionId('local','codex:overflow')]}};
    assert.equal(validHubContentDocumentCommand(tooLarge),false);
    await assert.rejects(owner.command('contentDocument',{...proof,command:tooLarge}));
  }finally{await owner.close();if(mode==='original')await store.close();}
}));

test('notebook control worker protocol refuses a well-shaped response for another private resource', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-notebook-control-protocol.sqlite') }, silence, () => fake as unknown as Worker);
  fake.ready();
  const work = owner.command('notebookControl', { evidence: {}, expectedScope: 'a'.repeat(64),
    command: { action: 'capabilities', resourceId: JSON.stringify(['hub-notebook', 1]) } });
  const failed = assert.rejects(work, HubMemberOwnerUnavailable); await tick();
  fake.reply(0, { action: 'capabilities', resourceId: JSON.stringify(['hub-notebook', 1, '11111111-1111-4111-8111-111111111111']), capabilities: [] });
  await failed; assert.equal(owner.snapshot().unavailable, true); assert.equal(fake.stops, 0);
  const retired = owner.retireForShutdown(); await tick(); fake.emit('exit', 1); await retired;
});

test('notebook control actual worker preserves original identity, token, receipts and revoke across reopen', () => disk(async file => {
  const store = new HubStore(file, 'private-fixture-vault'), resourceId = JSON.stringify(['hub-notebook', 1]);
  const key = store.identities.issueKey('default'), token = store.identities.createSession(key.token)!;
  const principal = store.identities.requestPrincipal(new Request('http://fixture.invalid', {
    headers: { cookie: 'agentopsdeck_session=' + token },
  }), () => false);
  assert.deepEqual(principal, { userId: 'default', admin: false });
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope(principal!) };
  store.notebooks.save('default', { resourceId, revision: 0, text: 'hello' }); await store.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'private-fixture-vault' }, silence);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const move = { requestId, hotRevision: 1, coldRevision: 0, direction: 'archive' as const,
    ranges: [{ start: 0, end: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }] };
  let grantToken: string;
  try {
    await owner.open();
    const issued = await owner.command('notebookControl', { ...proof, command: { action: 'issue', resourceId,
      input: { facets: ['hot:read'], expiresAt: Date.now() + 600_000 } } });
    assert.ok(issued?.action === 'issue' && issued.issued); grantToken = issued.issued.token;
    const saved = await owner.command('notebookControl', { ...proof, command: { action: 'move', resourceId, input: move } });
    assert.ok(saved?.action === 'move'); assert.deepEqual(saved.result, { hotRevision: 2, coldRevision: 1, moved: 5 });
    assert.deepEqual(await owner.command('notebookControl', { ...proof, command: { action: 'move', resourceId, input: move } }), saved);
    assert.deepEqual(await owner.command('notebookControl', { ...proof, command: { action: 'receipt', resourceId, requestId } }),
      { action: 'receipt', resourceId, requestId, result: saved.result });
    const listed = await owner.command('notebookControl', { ...proof, command: { action: 'capabilities', resourceId } });
    assert.ok(listed?.action === 'capabilities'); assert.deepEqual(listed.capabilities, [issued.issued.capability]);
    assert.deepEqual(await owner.command('notebookControl', { ...proof, command: { action: 'revoke', resourceId, capabilityId: issued.issued.capability.id } }),
      { action: 'revoke', resourceId, capabilityId: issued.issued.capability.id, revoked: true });
  } finally { await owner.close(); }
  const reopened = new HubStore(file, 'private-fixture-vault');
  try {
    assert.ok(reopened.identities.requestPrincipal(new Request('http://fixture.invalid', { headers: { cookie: 'agentopsdeck_session=' + token } }), () => false));
    assert.equal(reopened.notebookCapabilities.authorized(grantToken!), undefined);
    assert.equal(reopened.notebooks.getArchive('default', resourceId).text, 'hello');
    assert.deepEqual(reopened.notebooks.moveReceipt('default', resourceId, requestId), { hotRevision: 2, coldRevision: 1, moved: 5 });
  } finally { await reopened.close(); }
}));

test('complete Hub owner issues an original session, preserves scope and reopens saved cookie', () => disk(async file => {
  const key = await seed(file);
  let worker = new AsyncHubMemberOwner({ file, encryptionSecret: 'private-fixture-vault' }, silence);
  let token: string, scope: string;
  try {
    await worker.open();
    const created = await worker.command('memberSessionCreate', { key });
    assert.ok(created); token = created.token;
    const initial = await worker.command('memberSnapshot', { sessionToken: token });
    assert.ok(initial); assert.equal(initial.principal.userId, 'default'); scope = initial.recoveryScope;
    const direct = await worker.command('memberSnapshot', { accessKey: key });
    assert.deepEqual(direct, initial);
  } finally { await worker.close(); }
  assert.equal(worker.snapshot().ownerExitConfirmed, true);
  const original = new HubStore(file, 'private-fixture-vault');
  try {
    const request = new Request('http://localhost/', { headers: { cookie: 'agentopsdeck_session=' + token! } });
    const principal = original.identities.requestPrincipal(request, () => false);
    assert.ok(principal); assert.equal(original.identities.recoveryScope(principal), scope!);
  } finally { await original.close(); }
  worker = new AsyncHubMemberOwner({ file, encryptionSecret: 'private-fixture-vault' }, silence);
  try {
    await worker.open(); assert.ok(await worker.command('memberSnapshot', { sessionToken: token! }));
    await worker.command('memberSessionDelete', { token: token! });
    assert.equal(await worker.command('memberSnapshot', { sessionToken: token! }), null);
  } finally { await worker.close(); }
}));

test('revoked member key cannot use its saved cookie and never becomes a legacy principal', () => disk(async file => {
  const key = await seed(file), original = new HubStore(file, 'private-fixture-vault');
  const token = original.identities.createSession(key)!;
  const keyId = original.identities.keyIdentity(key)!.keyId;
  original.identities.revokeKey('default', keyId);
  await original.close();
  const worker = new AsyncHubMemberOwner({ file, encryptionSecret: 'private-fixture-vault' }, silence);
  try {
    await worker.open();
    assert.equal(await worker.command('memberSnapshot', { accessKey: key, sessionToken: token }), null);
    assert.equal(await worker.command('memberSnapshot', { sessionToken: token }), null);
    assert.equal(await worker.command('memberSessionCreate', { key }), null);
    assert.equal(await worker.command('memberSnapshot', {}), null);
    assert.equal(await worker.command('memberSnapshot', { accessKey: 'administrator-fixture' }), null);
  } finally { await worker.close(); }
}));

test('initial worker surface preserves all original tables and rows except explicit session/usage writes', () => disk(async file => {
  const key = await seed(file);
  function snapshot() {
    const db = new DatabaseSync(file);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
      return tables.filter(t => !['hub_login_sessions', 'hub_key_usage', 'hub_user_usage'].includes(t.name))
        .map(t => [t.name, JSON.stringify(db.prepare('SELECT * FROM "' + t.name.replaceAll('"','""') + '" ORDER BY rowid').all())]);
    } finally { db.close(); }
  }
  const before = snapshot(); assert.ok(before.length >= 60);
  const worker = new AsyncHubMemberOwner({ file, encryptionSecret: 'private-fixture-vault' }, silence);
  try { await worker.open(); assert.ok(await worker.command('memberSessionCreate', { key })); }
  finally { await worker.close(); }
  assert.deepEqual(snapshot(), before);
}));

test('invalid explicit member key outranks valid member cookie on original command owner', () => disk(async file => {
  const key = await seed(file), owner = new HubStore(file, 'private-fixture-vault');
  try {
    const token = owner.identities.createSession(key)!;
    assert.ok(executeHubMemberCommand(owner, 'memberSnapshot', { sessionToken: token }));
    assert.equal(executeHubMemberCommand(owner, 'memberSnapshot', { accessKey: 'hub_key_' + 'z'.repeat(43), sessionToken: token }), null);
    const proof = hubMemberEvidence(new Request('http://localhost/', { headers: { 'x-agentopsdeck-key': key, cookie: 'agentopsdeck_session=' + token } }));
    assert.deepEqual(proof, { accessKey: key, sessionToken: token });
  } finally { await owner.close(); }
}));

test('a timed pending warning retains slot, byte reservation and original effect until ACK', async () => {
  const fake = new FakeWorker(), rows: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-member-fake-pending.sqlite') }, new PerformanceDiagnostics(line => rows.push(line)), () => fake as unknown as Worker, 5);
  fake.ready();
  const work = owner.command('memberSessionCreate', { key: 'hub_key_' + 'x'.repeat(43) });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(owner.snapshot().accepted, 1); assert.equal(owner.snapshot().pending, 1);
  assert.equal(fake.messages.length, 1); assert.equal(fake.stops, 0);
  assert.ok(rows.some(line => line.includes('"phase":"pending"')));
  const close = owner.close(); await tick(); assert.equal(fake.messages.length, 1);
  fake.reply(0, { token: 'hub_session_' + 'y'.repeat(43) }); await work; await tick();
  assert.equal(fake.messages[1]!.kind, 'close'); fake.reply(1, null); fake.emit('exit', 0); await close;
  assert.equal(owner.snapshot().accepted, 0);
  assert.equal(rows.join('').includes('x'.repeat(43)), false);
});

test('malformed ACK fences owner and preserves unknown effects; only explicit shutdown retires it', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-member-fake-unknown.sqlite') }, silence, () => fake as unknown as Worker);
  fake.ready();
  const work = owner.command('memberSessionCreate', { key: 'hub_key_' + 'x'.repeat(43) });
  const failed = assert.rejects(work, HubMemberOwnerUnavailable); await tick();
  fake.reply(0, { token: 'not-a-session' }); await failed;
  assert.equal(owner.snapshot().unavailable, true); assert.equal(fake.stops, 0);
  await assert.rejects(owner.command('memberSnapshot', {}), HubMemberOwnerUnavailable);
  assert.equal(fake.messages.length, 1);
  const retired = owner.retireForShutdown(); await tick(); assert.equal(fake.stops, 1);
  assert.equal(owner.snapshot().ownerExitConfirmed, false);
  fake.emit('exit', 1); await retired; assert.equal(owner.snapshot().ownerExitConfirmed, true);
});

test('descriptor hazards, callbacks and caller authority booleans are refused before dispatch', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-member-fake-input.sqlite') }, silence, () => fake as unknown as Worker);
  fake.ready(); let getters = 0;
  const input = { get accessKey(): string { getters++; throw Error('private-fixture'); } };
  await assert.rejects(owner.command('memberSnapshot', input), HubMemberOwnerUnavailable);
  await assert.rejects(owner.command('memberSnapshot', { authorized: true } as never), HubMemberOwnerUnavailable);
  assert.equal(getters, 0); assert.equal(fake.messages.length, 0);
  assert.throws(() => encodeHubMemberJson({ check: () => true }, 1024), HubMemberOwnerUnavailable);
  const close = owner.close(); await tick(); fake.reply(0, null); fake.emit('exit', 0); await close;
});

test('protocol has exactly fixed domain shapes and rejects permission grants/extra fields', () => {
  assert.equal(validHubMemberInput('memberSnapshot', { userId: 'local' }), false);
  assert.equal(validHubMemberInput('memberSessionCreate', { key: 'hub_key_' + 'x'.repeat(43), authorized: true }), false);
  assert.equal(validHubMemberInput('memberSessionDelete', { token: 'hub_session_' + 'x'.repeat(43) }), true);
  assert.equal(validHubMemberOutput('memberSessionDelete', {}), false);
  assert.equal(validHubMemberOutput('memberSnapshot', { principal: { userId: 'local', admin: true }, recoveryScope: 'a'.repeat(64), authorized: true }), false);
});

test('original Hub constructor configuration remains explicit, validated and lossless', () => {
  const configuration = { file: '/operator-owned-fixture/hub.sqlite', encryptionSecret: 'vault-fixture',
    administratorKey: 'admin-fixture', lifecycleEndpoints: [] };
  assert.deepEqual(hubMemberOwnerConfig(configuration), configuration);
  assert.throws(() => hubMemberOwnerConfig({ ...configuration, authorized: true }), HubMemberOwnerUnavailable);
  assert.throws(() => hubMemberOwnerConfig({ ...configuration, lifecycleEndpoints: [{ origin: 'http://public.example/' }] }), HubMemberOwnerUnavailable);
  assert.throws(() => hubMemberOwnerConfig({ file: ':memory:' }), HubMemberOwnerUnavailable);
});

test('original member savepoint rolls back SQL failure and the same whole owner remains usable without replay', () => disk(async file => {
  const key = await seed(file);
  const original = new HubStore(file, 'private-fixture-vault');
  const existingToken = original.identities.createSession(key)!;
  const db = (original as unknown as { db: DatabaseSync }).db;
  const before = db.prepare('SELECT count(*) AS n FROM hub_login_sessions').get()!.n;
  db.exec("CREATE TRIGGER member_create_fixture_fault BEFORE INSERT ON hub_user_usage BEGIN SELECT RAISE(ABORT,'private-member-sql-error'); END");
  await original.close();
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const source = import.meta.url.endsWith('.ts');
  const entry = new URL(source ? './member-owner-worker.ts' : './member-owner-worker.js', import.meta.url);
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'private-fixture-vault' }, diagnostics, () => {
    const worker = new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], stdout: true, workerData: {
      file, encryptionSecret: 'private-fixture-vault', entry: entry.href,
      loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
    worker.stdout!.setEncoding('utf8'); worker.stdout!.on('data', chunk => lines.push(chunk));
    return worker;
  });
  try {
    await owner.open();
    await assert.rejects(owner.command('memberSessionCreate', { key }), HubMemberOwnerUnavailable);
    assert.equal(owner.snapshot().unavailable, false);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: existingToken }));
    await owner.close();
    const rows = lines.join('\n').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.ok(rows.some(row => row.operation === 'hub-identity-change' && row.sqlErrorCode === 1811 && row.category === 'failed'));
    assert.ok(rows.some(row => row.operation === 'hub-member-sqlite-owner' && row.step === 9 && row.category === 'failed'));
    assert.ok(rows.some(row => row.operation === 'hub-member-sqlite-command' && row.step === 2 && row.unknown === 1));
    assert.doesNotMatch(lines.join(''), /private-member-sql-error|private-fixture-vault|member_create_fixture_fault/);
    assert.equal(lines.join('').includes(key), false); assert.equal(lines.join('').includes(existingToken), false);
  } finally { await owner.close(); }
  const reopened = new HubStore(file, 'private-fixture-vault');
  try {
    const current = (reopened as unknown as { db: DatabaseSync }).db;
    assert.equal(current.prepare('SELECT count(*) AS n FROM hub_login_sessions').get()!.n, before);
    current.exec('DROP TRIGGER member_create_fixture_fault');
    assert.ok(reopened.identities.createSession(key));
  } finally { await reopened.close(); }
}));

test('duplicate owner is fenced until actual worker exit, not failed ACK or terminate promise', async () => {
  const fake = new FakeWorker(), file = join(tmpdir(), 'hub-member-fake-reservation.sqlite');
  const owner = new AsyncHubMemberOwner({ file }, silence, () => fake as unknown as Worker);
  fake.ready();
  assert.throws(() => new AsyncHubMemberOwner({ file }, silence, () => new FakeWorker() as unknown as Worker));
  const retired = owner.retireForShutdown(); await tick(); await tick();
  assert.equal(fake.stops, 1);
  assert.throws(() => new AsyncHubMemberOwner({ file }, silence, () => new FakeWorker() as unknown as Worker));
  fake.emit('exit', 1); await retired;
  const nextFake = new FakeWorker(), next = new AsyncHubMemberOwner({ file }, silence, () => nextFake as unknown as Worker);
  nextFake.ready(); const close = next.close(); await tick(); nextFake.reply(0, null); nextFake.emit('exit', 0); await close;
});

test('accepted startup-waiting commands drain before close and capacity refusal does not dispatch', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-member-fake-capacity.sqlite') }, silence, () => fake as unknown as Worker);
  const commands = Array.from({ length: 256 }, () => owner.command('memberSnapshot', {}));
  await assert.rejects(owner.command('memberSnapshot', {}), HubMemberOwnerUnavailable);
  const close = owner.close(); await tick(); assert.equal(fake.messages.length, 0);
  await assert.rejects(owner.command('memberSnapshot', {}), HubMemberOwnerUnavailable);
  fake.ready(); await tick(); assert.equal(fake.messages.length, 256);
  commands.forEach((_, index) => fake.reply(index, null)); await Promise.all(commands); await tick();
  assert.equal(fake.messages.length, 257); assert.equal(fake.messages[256]!.kind, 'close');
  fake.reply(256, null); fake.emit('exit', 0); await close;
  assert.equal(owner.snapshot().acceptedBytes, 0);
});

for (const workspaceFirst of [false, true]) test(`workspace reply reservation is isolated from ordinary commands (${workspaceFirst})`, async () => {
  const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), `hub-member-workspace-budget-${workspaceFirst}.sqlite`) }, silence, () => fake as unknown as Worker);
  fake.ready();
  const workspace = () => owner.command('workspaceGet', { evidence: {}, expectedScope: 'a'.repeat(64) });
  const member = () => owner.command('memberSnapshot', {});
  const work = workspaceFirst ? [workspace(), member()] : [member(), workspace()];
  const settled = Promise.all(work);
  await tick();
  assert.equal(fake.messages.length, 2, 'one bounded workspace reply must coexist with ordinary member reads');
  const waiting = workspace();
  await tick(); assert.equal(fake.messages.length, 2);
  fake.reply(0, null); fake.reply(1, null); await settled; await tick();
  assert.equal(fake.messages[2]!.kind, 'workspaceGet');
  fake.reply(2, null); await waiting; await tick();
  assert.equal(owner.snapshot().acceptedResultBytes, 0);
  const closing = owner.close(); await tick(); fake.reply(3, null); fake.emit('exit', 0); await closing;
});

test('large layout reads wait FIFO within the original reply budget and drain through close', async () => {
  const fake = new FakeWorker(), logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-member-layout-admission.sqlite') },
    new PerformanceDiagnostics(line => logs.push(line)), () => fake as unknown as Worker, 5);
  fake.ready();
  const proof = { evidence: {}, expectedScope: 'a'.repeat(64) };
  const notebook = { ...proof, command: { action: 'snapshotPrivate' as const,
    read: { mode: 'layouts' as const, resourceId: null, after: '', query: null, includeArchive: false } } };
  const first = owner.command('personalNotebook', notebook);
  const snapshots = Array.from({ length: 24 }, () => owner.command('sessionStateSnapshot', { ...proof, command: { action: 'read' } }));
  const last = owner.command('memberSnapshot', {});
  const all = Promise.all([first, ...snapshots, last]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fake.messages.length, 1);
  assert.equal(owner.snapshot().accepted, 26);
  assert.equal(owner.snapshot().acceptedResultBytes, hubMemberResultBytes('personalNotebook', notebook));
  const closing = owner.close();
  await assert.rejects(owner.command('memberSnapshot', {}), HubMemberOwnerUnavailable);
  for (let index = 0; index < 26; index++) {
    assert.ok(owner.snapshot().acceptedResultBytes <= HUB_MEMBER_RESULT_BUDGET);
    assert.equal(fake.messages[index]!.kind, index === 0 ? 'personalNotebook' : index === 25 ? 'memberSnapshot' : 'sessionStateSnapshot');
    fake.reply(index, null); await tick();
  }
  await all;
  assert.equal(owner.snapshot().acceptedResultBytes, 0);
  assert.equal(owner.snapshot().acceptedBytes, 0);
  assert.equal(fake.messages[26]!.kind, 'close');
  fake.reply(26, null); fake.emit('exit', 0); await closing;
  assert.equal(fake.stops, 0);
  const events = logs.map(line => JSON.parse(line));
  assert.ok(events.some(event => event.queueMs > 0 && event.settled === 1));
  assert.ok(events.some(event => event.admissionRefusalCode === 1));
});

test('result admission retains bounded command count and copied input without replay', async () => {
  const fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(tmpdir(), 'hub-member-result-count.sqlite') }, silence, () => fake as unknown as Worker);
  fake.ready();
  const input = { evidence: {}, expectedScope: 'a'.repeat(64), command: { action: 'read' as const } };
  const first = owner.command('sessionStateSnapshot', input);
  const waiting = owner.command('sessionStateSnapshot', input);
  input.expectedScope = 'b'.repeat(64);
  const reads = Array.from({ length: 254 }, () => owner.command('memberSnapshot', {}));
  await assert.rejects(owner.command('memberSnapshot', {}), HubMemberOwnerUnavailable);
  await tick(); assert.equal(fake.messages.length, 1);
  fake.reply(0, null); await first; await tick();
  assert.equal(JSON.parse(fake.messages[1]!.body).expectedScope, 'a'.repeat(64));
  assert.equal(fake.messages.length, 256);
  for (let index = 1; index < 256; index++) fake.reply(index, null);
  await Promise.all([waiting, ...reads]); await tick();
  assert.equal(owner.snapshot().accepted, 0);
  assert.equal(owner.snapshot().acceptedResultBytes, 0);
  const closing = owner.close(); await tick(); fake.reply(256, null); fake.emit('exit', 0); await closing;
});

test('worker failure rejects queued undispatched reads without replay or releasing original ownership', async () => {
  const fake = new FakeWorker(), file = join(tmpdir(), 'hub-member-result-failure.sqlite');
  const owner = new AsyncHubMemberOwner({ file }, silence, () => fake as unknown as Worker);
  fake.ready();
  const input = { evidence: {}, expectedScope: 'a'.repeat(64), command: { action: 'read' as const } };
  const works = Array.from({ length: 8 }, () => owner.command('sessionStateSnapshot', input));
  const rejected = works.map(work => assert.rejects(work, HubMemberOwnerUnavailable));
  await tick(); assert.equal(fake.messages.length, 1);
  fake.emit('error', Error('private-worker-failure')); await Promise.all(rejected); await tick();
  assert.equal(fake.messages.length, 1);
  assert.equal(owner.snapshot().accepted, 0);
  assert.equal(owner.snapshot().acceptedResultBytes, 0);
  assert.throws(() => new AsyncHubMemberOwner({ file }, silence, () => new FakeWorker() as unknown as Worker));
  const closing = assert.rejects(owner.close(), HubMemberOwnerUnavailable);
  await tick(); fake.emit('exit', 1); await closing;
});

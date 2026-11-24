import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubDefaultConnection } from './member-owner-bootstrap.js';
const quiet = new PerformanceDiagnostics(() => {});
const secret = 'isolated-bootstrap-worker-secret';

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hub-bootstrap-worker-')), file = join(root, 'hub.sqlite');
  const files = { hidden: join(root, 'hidden.json'), archived: join(root, 'archived.json'), pinned: join(root, 'pinned.json') };
  const store = new HubStore(file, secret);
  const member = store.createUser('Original member'), key = store.identities.issueKey(member.id);
  const cookie = store.identities.createSession(key.token)!;
  const session = encodeHubSessionId('local', 'existing-native-session');
  const hubId = store.identities.hubId;
  store.setSessionPreference(session, 'hidden', false, member.id);
  await store.close();
  const workers: AsyncHubMemberOwner[] = [];
  const open = (options: { admin?: boolean; owner?: string; defaultConnection?: HubDefaultConnection } = {}) => {
    const worker = new AsyncHubMemberOwner({ file, encryptionSecret: secret,
      ...(options.admin === false ? {} : { administratorKey: 'synthetic-admin' }),
      bootstrap: { legacyPreferences: files, ...(options.owner === undefined ? {} : { legacyPreferencesOwner: options.owner }),
        ...(options.defaultConnection === undefined ? {} : { defaultConnection: options.defaultConnection }) } }, quiet);
    workers.push(worker); return worker;
  };
  t.after(async () => {
    for (const worker of workers) await worker.closeForShutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const inspect = async (work: (original: HubStore) => void) => {
    assert.ok(workers.every(worker => worker.snapshot().ownerExitConfirmed));
    const original = new HubStore(file, secret);
    try { work(original); } finally { await original.close(); }
  };
  return { root, file, files, member, cookie, session, hubId, open, inspect };
}

test('worker initializes default before ready and publishes only immutable persisted identity across reopen', async t => {
  const f = await fixture(t);
  const first = f.open({ owner: f.member.id, defaultConnection: { kind: 'local', id: 'local', label: 'Local',
    environmentId: '', environmentLabel: '', status: 'degraded' } });
  assert.throws(() => first.metadata);
  await first.open(); assert.deepEqual(first.metadata, { hubId: f.hubId }); assert.ok(Object.isFrozen(first.metadata));
  await first.close(); assert.throws(() => first.metadata);
  await f.inspect(original => {
    const connection = original.getConnection('local');
    assert.equal(connection?.kind, 'local'); assert.equal(connection?.status, 'degraded');
    assert.equal(connection?.connectorUrl, 'local://aod-connector');
  });
  const second = f.open({ owner: f.member.id }); await second.open();
  assert.equal(second.metadata.hubId, f.hubId); await second.close();
});

test('real worker imports before ready and preserves original cookie, explicit choices and once-only migration', async t => {
  const f = await fixture(t);
  writeFileSync(f.files.hidden, JSON.stringify([f.session]));
  writeFileSync(f.files.archived, JSON.stringify([f.session]));
  const first = f.open({ owner: f.member.id }); await first.open();
  const snapshot = await first.command('memberSnapshot', { sessionToken: f.cookie });
  assert.equal(snapshot?.principal.userId, f.member.id);
  await first.close();
  await f.inspect(original => assert.deepEqual(original.sessionPreferences(f.member.id).get(f.session), { hidden: false, archived: true }));
  // A later corrupt legacy file is not re-imported after original migration.
  writeFileSync(f.files.pinned, '{invalid-after-migration');
  const second = f.open({ owner: 'default' }); await second.open();
  assert.equal((await second.command('memberSnapshot', { sessionToken: f.cookie }))?.principal.userId, f.member.id);
  await second.close();
  await f.inspect(original => {
    assert.deepEqual(original.sessionPreferences(f.member.id).get(f.session), { hidden: false, archived: true });
    assert.equal(original.sessionPreferences('default').size, 0);
  });
});

for (const fault of ['missing-admin', 'corrupt-source', 'ambiguous-owner'] as const) {
  test(`real worker refuses ${fault} before ready, retains original state and recovers after physical exit`, async t => {
    const f = await fixture(t), bytes = JSON.stringify([f.session]);
    writeFileSync(f.files.archived, bytes);
    if (fault === 'corrupt-source') writeFileSync(f.files.pinned, '{invalid');
    const failed = f.open({ admin: fault !== 'missing-admin', ...(fault === 'ambiguous-owner' ? {} : { owner: f.member.id }) });
    await assert.rejects(failed.open(), /hub_member_storage_unavailable/);
    assert.equal(failed.snapshot().ready, false);
    await assert.rejects(failed.close(), /hub_member_storage_unavailable/);
    assert.equal(failed.snapshot().ownerExitConfirmed, true);
    assert.equal(failed.snapshot().pending, 0); assert.equal(failed.snapshot().accepted, 0);
    await f.inspect(original => {
      const request = new Request('http://localhost/', { headers: { cookie: 'agentopsdeck_session=' + f.cookie } });
      assert.equal(original.identities.requestPrincipal(request, () => false)?.userId, f.member.id);
      assert.deepEqual(original.sessionPreferences(f.member.id).get(f.session), { hidden: false });
    });
    assert.equal(readFileSync(f.files.archived, 'utf8'), bytes);
    writeFileSync(f.files.pinned, '[]');
    const recovered = f.open({ owner: f.member.id }); await recovered.open();
    assert.equal((await recovered.command('memberSnapshot', { sessionToken: f.cookie }))?.principal.userId, f.member.id);
    await recovered.close();
    await f.inspect(original => assert.deepEqual(original.sessionPreferences(f.member.id).get(f.session), { hidden: false, archived: true }));
  });
}

test('real worker pins relative bootstrap paths and copies caller configuration before asynchronous startup', async t => {
  const f = await fixture(t), prior = process.cwd(), elsewhere = join(f.root, 'elsewhere');
  mkdirSync(elsewhere); writeFileSync(f.files.archived, JSON.stringify([f.session]));
  const config = { file: 'hub.sqlite', encryptionSecret: secret, administratorKey: 'synthetic-admin',
    bootstrap: { legacyPreferences: { hidden: 'hidden.json', archived: 'archived.json', pinned: 'pinned.json' }, legacyPreferencesOwner: f.member.id } };
  let worker: AsyncHubMemberOwner | undefined;
  try {
    process.chdir(f.root); worker = new AsyncHubMemberOwner(config, quiet);
    config.bootstrap.legacyPreferences.archived = 'replaced.json'; config.bootstrap.legacyPreferencesOwner = 'default';
    process.chdir(elsewhere); await worker.open();
    assert.equal((await worker.command('memberSnapshot', { sessionToken: f.cookie }))?.principal.userId, f.member.id);
  } finally { process.chdir(prior); await worker?.closeForShutdown(); }
  assert.equal(worker?.snapshot().ownerExitConfirmed, true);
  await f.inspect(original => assert.deepEqual(original.sessionPreferences(f.member.id).get(f.session), { hidden: false, archived: true }));
});

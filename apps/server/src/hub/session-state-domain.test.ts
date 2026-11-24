import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validHubSessionStateCommand, validHubSessionStateResult } from './session-state-domain.js';
import { migrateSessionPreferenceVersions } from './session-preference-version.js';
import { encodeHubSessionId } from './session-id.js';
import { validHubMemberInput, validHubMemberOutput, hubMemberResultBudget, hubMemberResultBytes,
  type HubMemberKind, type HubMemberCommands } from './member-owner-domain.js';
const quiet = new PerformanceDiagnostics(() => {});
const status = (n: number) => (e: unknown) => e instanceof HubMemberRequestError && e.status === n;
function fixture(t: test.TestContext, admin = false) {
  const root = mkdtempSync(join(tmpdir(), 'session-state-authority-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'isolated-state-vault'), userId = admin ? 'default' : store.createUser('Member').id;
  const db = (store as unknown as { db: DatabaseSync }).db;
  if (admin) db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(userId);
  const key = store.identities.issueKey(userId), session = encodeHubSessionId('node', 'codex:session');
  const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
    headers: { authorization: 'Bearer ' + key.token }, ...(signal ? { signal } : {}),
  });
  store.upsertConnection({ id: 'node', ownerUserId: userId, label: 'Node', connectorUrl: 'http://fixture.invalid' });
  const original = new OriginalHubAdministrativeCommands(store, quiet), service = new AsyncHubMemberRequests(original, quiet);
  t.after(async () => { await service.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { file, store, userId, db, key, session, request, original, service };
}
for (const admin of [false, true]) {
  test(`atomic session state retains original directory and privacy flags (admin=${admin})`, async t => {
    const f = fixture(t, admin), foreign = f.store.createUser('Foreign');
    f.store.upsertConnection({ id: 'foreign', ownerUserId: foreign.id, label: 'Foreign', connectorUrl: 'http://foreign.invalid' });
    f.store.setSessionPreference(f.session, 'hidden', true, f.userId);
    f.store.setSessionPreference(f.session, 'pinned', true, f.userId);
    const access = await f.service.begin(f.request()), state = await access.sessionState();
    assert.deepEqual(state.connections, JSON.parse(JSON.stringify(f.store.listConnections(f.userId))));
    assert.deepEqual(state.preferences, f.store.sessionPreferences(f.userId));
    assert.equal(state.authority('node'), f.store.connectionAuthority('node', f.userId));
    assert.equal(state.authority('foreign'), undefined); await state.check();
    assert.doesNotMatch(JSON.stringify(state), /foreign.invalid|isolated-state-vault|hub_key_|encrypted_token|authority_version/);
  });
  for (const field of ['hidden', 'archived', 'pinned'] as const) for (const mode of ['insert', 'update', 'delete'] as const)
    test(`atomic session state fences ${field}/${mode} (admin=${admin})`, async t => {
      const f = fixture(t, admin);
      if (mode !== 'insert') f.store.setSessionPreference(f.session, field, false, f.userId);
      const state = await (await f.service.begin(f.request())).sessionState(); await state.check();
      if (mode === 'delete') f.store.removeSessionPreferences(f.session, f.userId);
      else f.store.setSessionPreference(f.session, field, true, f.userId);
      await assert.rejects(state.check(), status(503));
    });
  for (const change of ['epoch', 'label', 'add', 'disable', 'key'] as const)
    test(`atomic session state fences ${change} (admin=${admin})`, async t => {
      const f = fixture(t, admin), state = await (await f.service.begin(f.request())).sessionState();
      if (change === 'epoch') f.db.prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('node');
      else if (change === 'key') f.store.identities.revokeKey(f.userId, f.key.id);
      else f.store.upsertConnection({ id: change === 'add' ? 'added' : 'node', ownerUserId: f.userId,
        label: 'Updated', connectorUrl: 'http://fixture.invalid', status: change === 'disable' ? 'disabled' : 'enabled' });
      await assert.rejects(state.check(), status(change === 'key' ? 401 : 503));
    });
}
test('persistent preference generation is idempotent, transactional and owner-scoped', async t => {
  const f = fixture(t), state = await (await f.service.begin(f.request())).sessionState();
  migrateSessionPreferenceVersions(f.db); migrateSessionPreferenceVersions(f.db); await state.check();
  f.db.exec('BEGIN');
  try { f.store.setSessionPreference(f.session, 'hidden', true, f.userId);
    assert.equal(f.db.prepare('SELECT version FROM hub_session_preference_versions WHERE user_id=?').get(f.userId)!.version, 1);
  } finally { f.db.exec('ROLLBACK'); }
  await state.check();
  const other = f.store.createUser('Other'); f.store.setSessionPreference(f.session, 'hidden', true, other.id); await state.check();
  f.db.prepare('UPDATE session_preferences SET user_id=? WHERE user_id=?').run(f.userId, other.id);
  await assert.rejects(state.check(), status(503));
  assert.equal(f.db.prepare('SELECT version FROM hub_session_preference_versions WHERE user_id=?').get(f.userId)!.version, 1);
  assert.equal(f.db.prepare('SELECT version FROM hub_session_preference_versions WHERE user_id=?').get(other.id)!.version, 2);
});
test('privacy generation survives reopen and legacy direct SQL updates; unchanged values do not invalidate', async t => {
  const f = fixture(t); f.store.setSessionPreference(f.session, 'hidden', true, f.userId);
  await f.service.close(); await f.original.close(); await f.store.close();
  const store = new HubStore(f.file, 'isolated-state-vault'), original = new OriginalHubAdministrativeCommands(store, quiet);
  const service = new AsyncHubMemberRequests(original, quiet);
  try {
    const state = await (await service.begin(f.request())).sessionState(), db = (store as unknown as { db: DatabaseSync }).db;
    assert.equal(state.preferences.get(f.session)?.hidden, true);
    db.prepare('UPDATE session_preferences SET hidden=hidden WHERE user_id=?').run(f.userId); await state.check();
    db.prepare('UPDATE session_preferences SET archived=1 WHERE user_id=?').run(f.userId); await assert.rejects(state.check(), status(503));
  } finally { await service.close(); await original.close(); await store.close(); }
});
test('atomic session state is available on the sole isolated worker, not a peer writer', async t => {
  const f = fixture(t); f.store.setSessionPreference(f.session, 'archived', true, f.userId);
  await f.service.close(); await f.original.close(); await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'isolated-state-vault' }, quiet);
  const service = new AsyncHubMemberRequests(owner, quiet);
  try { const state = await (await service.begin(f.request())).sessionState();
    assert.equal(state.preferences.get(f.session)?.archived, true); await state.check();
  } finally { await service.close(); await owner.close(); }
});
for (const command of [undefined, {}, { action: 'read', sql: 'SELECT 1' }, { action: 'check', directoryVersion: -1, preferenceVersion: 0 },
  { action: 'check', directoryVersion: 1, preferenceVersion: NaN }, { action: 'check', directoryVersion: 1, preferenceVersion: 0, principal: 'default' }])
  test(`session state refuses non-fixed input ${JSON.stringify(command)}`, () => {
    assert.equal(validHubSessionStateCommand(command), false);
    assert.equal(validHubMemberInput('sessionStateSnapshot', { evidence: { accessKey: 'x' }, expectedScope: 'a'.repeat(64), command }), false);
  });
test('snapshot/check kinds cannot exchange oversized results or disguise read as a cheap check', async t => {
  const f = fixture(t), expectedScope = f.store.identities.recoveryScope({ userId: f.userId, admin: false });
  const proof = { evidence: { accessKey: f.key.token }, expectedScope, command: { action: 'read' as const } };
  const snapshot = await f.original.command('sessionStateSnapshot', proof); assert.ok(snapshot?.action === 'read');
  assert.equal(validHubSessionStateResult(snapshot), true); assert.equal(validHubMemberOutput('sessionStateSnapshot', snapshot), true);
  const check = { ...proof, command: { action: 'check' as const, directoryVersion: snapshot.directory.version, preferenceVersion: snapshot.preferenceVersion } };
  assert.equal(validHubMemberInput('sessionStateCheck', proof), false); assert.equal(validHubMemberInput('sessionStateSnapshot', check), false);
  assert.equal(validHubMemberOutput('sessionStateCheck', snapshot), false);
  const result = await f.original.command('sessionStateCheck', check); assert.ok(result?.action === 'check' && result.ok);
  assert.equal(validHubMemberOutput('sessionStateSnapshot', result), false);
  assert.ok(hubMemberResultBytes('sessionStateSnapshot') + 4 * hubMemberResultBytes('sessionStateCheck') < hubMemberResultBudget('sessionStateSnapshot'));
  for (const value of [{ ...snapshot, preferences: [[f.session, { hidden: 1 }]] }, { ...snapshot, preferences: [[f.session, {}], [f.session, {}]] },
    { ...snapshot, preferenceVersion: -1 }, { ...snapshot, directory: { action: 'check', version: 0, ok: true } }, { ...snapshot, token: 'private' }])
    assert.equal(validHubSessionStateResult(value), false);
});
for (const corruption of ['action', 'directory', 'preference', 'unavailable'] as const)
  test(`atomic privacy check refuses ${corruption} and never replays the original owner`, async t => {
    const f = fixture(t); let checks = 0;
    const logs: string[] = [];
    const service = new AsyncHubMemberRequests({ command: async <K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']) => {
      const value = await f.original.command(kind, input);
      if (kind !== 'sessionStateCheck') return value;
      checks++;
      if (corruption === 'unavailable') throw Error('PRIVATE_SESSION_STATE_SQL_FAILURE');
      return { ...(value as object), ...(corruption === 'action' ? { action: 'read' }
        : corruption === 'directory' ? { directoryVersion: -1 } : { preferenceVersion: -1 }) } as HubMemberCommands[K]['output'];
    } }, new PerformanceDiagnostics(line => logs.push(line)));
    try {
      const state = await (await service.begin(f.request())).sessionState();
      await assert.rejects(state.check(), status(503));
      await assert.rejects(state.check(), status(503));
      assert.equal(checks, 1); assert.equal(service.pendingReads, 0);
      const text = logs.join('');
      for (const privateText of ['PRIVATE_SESSION_STATE_SQL_FAILURE', f.key.token, f.key.id, f.userId, f.session])
        assert.equal(text.includes(privateText), false);
      if (corruption === 'unavailable') {
        const rows = logs.map(line => JSON.parse(line)).filter(row => row.operation === 'auth-route-persistence' && row.step === 85);
        assert.equal(rows.filter(row => row.phase === 'finished' && row.unknown === 1).length, 1);
      }
    } finally { await service.close(); }
  });
test('generation overflow fails closed without silently truncating existing privacy preferences', async t => {
  const f = fixture(t); f.store.setSessionPreference(f.session, 'hidden', true, f.userId);
  f.db.prepare('UPDATE hub_session_preference_versions SET version=? WHERE user_id=?').run(Number.MAX_SAFE_INTEGER, f.userId);
  const state = await (await f.service.begin(f.request())).sessionState(); await state.check();
  assert.throws(() => f.store.setSessionPreference(f.session, 'hidden', false, f.userId));
  assert.equal(f.store.sessionPreferences(f.userId).get(f.session)?.hidden, true); await state.check();
});
for (const phase of ['snapshot', 'check'] as const) for (const boundary of ['cancel', 'deadline', 'close'] as const)
  test(`session state ${phase}/${boundary} retains original ACK/drain ownership`, async t => {
    const f = fixture(t), controller = new AbortController(); let release!: () => void, entered!: () => void, reads = 0;
    const logs: string[] = [];
    const gate = new Promise<void>(done => { release = done; }), entry = new Promise<void>(done => { entered = done; });
    const service = new AsyncHubMemberRequests({ command: async <K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']) => {
      const result = await f.original.command(kind, input);
      if (kind === (phase === 'snapshot' ? 'sessionStateSnapshot' : 'sessionStateCheck')) { reads++; entered(); await gate; } return result;
    } }, new PerformanceDiagnostics(line => logs.push(line)), 5, boundary === 'deadline' ? 5 : 30_000);
    const access = await service.begin(f.request(controller.signal));
    const state = phase === 'check' ? await access.sessionState() : undefined;
    const refused = assert.rejects(state ? state.check() : access.sessionState(), status(boundary === 'cancel' ? 499 : 503)); await entry;
    if (boundary === 'cancel') controller.abort();
    let closed = false; const closing = boundary === 'close' ? service.close().then(() => { closed = true; }) : undefined;
    try { if (boundary !== 'close') await refused;
      assert.equal(service.pendingReads, 1); assert.equal(reads, 1);
      await new Promise<void>(done => setImmediate(done)); assert.equal(closed, false);
    } finally { release(); }
    await refused; await (closing ?? service.close()); assert.equal(service.pendingReads, 0); assert.equal(reads, 1);
    const rows = logs.map(line => JSON.parse(line)).filter(row => row.operation === 'auth-route-persistence'
      && row.step === (phase === 'snapshot' ? 84 : 85));
    if (boundary !== 'close') assert.equal(rows.filter(row => row[boundary === 'cancel' ? 'cancelled' : 'timedOut'] === 1).length, 1);
    for (const privateText of [f.key.token, f.key.id, f.userId, f.session]) assert.equal(logs.join('').includes(privateText), false);
  });

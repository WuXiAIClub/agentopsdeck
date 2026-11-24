import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { executeHubMemberCommand, type HubMemberKind } from '../hub/member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAsyncHubConnectionMutations } from './hub-connection-mutations-async.js';

const quiet = new PerformanceDiagnostics(() => {});
const phases = ['start', 'add', 'add-getter', 'pending', 'pending-getter', 'finish', 'finish-getter'] as const;
function seed(store: HubStore) {
  const member = store.createUser('Member');
  store.upsertConnection({ id: 'original', ownerUserId: member.id, kind: 'remote', label: 'Original',
    connectorUrl: 'https://private.invalid', credentialToken: 'PRIVATE daily' });
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  return { member, key, token };
}
function mount(requests: AsyncHubMemberRequests, token: string, diagnostics = quiet, warningMs = 30_000) {
  const app = new Hono();
  const routes = registerAsyncHubConnectionMutations(app, { requests, diagnostics, warningMs,
    present: (connection, users) => ({ ...connection, ownerLabel: users.find(u => u.id === connection.ownerUserId)?.label }) });
  const request = (method = 'PATCH', body: unknown = { label: 'Renamed' }, id = 'original') => app.request(
    '/api/hub/v1/connections' + (id ? '/' + id : ''), { method,
      headers: { cookie: 'agentopsdeck_session=' + token, 'Content-Type': 'application/json' },
      ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }) });
  return { app, routes, request };
}
async function fixture(work: (f: ReturnType<typeof setup>) => unknown, diagnostics = quiet, warningMs = 30_000) {
  const root = mkdtempSync(join(tmpdir(), 'async-connection-http-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'fixture'), f = setup(store, diagnostics, warningMs);
  try { await work(f); } finally { f.routes.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function setup(store: HubStore, diagnostics: PerformanceDiagnostics, warningMs: number) {
  const s = seed(store), changes: any[] = [];
  let before: ((kind: HubMemberKind, input: any) => unknown) | undefined;
  let after: ((kind: HubMemberKind, input: any, result: unknown) => unknown) | undefined;
  const port = { command: async (kind: HubMemberKind, input: any) => {
    await before?.(kind, input);
    if (kind === 'connectionChange') changes.push(input.change);
    const result = executeHubMemberCommand(store, kind, input as never);
    await after?.(kind, input, result); return result;
  } } as Pick<AsyncHubMemberOwner, 'command'>;
  return { store, ...s, changes, ...mount(new AsyncHubMemberRequests(port, quiet), s.token, diagnostics, warningMs),
    before(fn: typeof before) { before = fn; }, after(fn: typeof after) { after = fn; } };
}

test('awaited connection HTTP preserves legacy wire, additive frontend fields, encrypted credentials and epoch policy', () => fixture(async f => {
  const epoch = f.store.connectionAuthority('original', f.member.id);
  const rename = await f.request('PATCH', { label: 'Renamed', ignored: true });
  assert.equal(rename.status, 200); assert.deepEqual(Object.keys(await rename.json()).sort(), ['connection', 'updatedAt']);
  assert.equal(f.store.connectionAuthority('original', f.member.id), epoch);
  assert.equal(f.store.getCredentialToken('original', f.member.id), 'PRIVATE daily');
  const created = await f.request('POST', { id: 'created', connectorUrl: 'https://created.invalid', capabilities: ['sessions', 42], ignored: true }, '');
  assert.equal(created.status, 201); assert.deepEqual(f.store.getConnection('created', f.member.id)!.capabilities, ['sessions']);
  assert.equal((await f.request('PATCH', { enabled: false })).status, 200);
  assert.ok(f.store.connectionAuthority('original', f.member.id)! > epoch!);
  assert.equal((await f.request('PUT', { token: ' PRIVATE maintenance ' }, 'original/maintenance-credential')).status, 200);
  assert.equal(f.store.getMaintenanceCredentialToken('original', f.member.id), 'PRIVATE maintenance');
  const deleted = await f.request('DELETE'); assert.deepEqual(await deleted.json(), { ok: true });
  assert.equal((await f.request('DELETE')).status, 404);
  for (const response of [rename, created, deleted]) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('retry-after'), null);
  }
  assert.equal(f.changes.length, 5);
}));

for (const body of [null, [], 42, { connectorUrl: 42 }, { connectorUrl: 'local://aod-connector' }, { connectorUrl: 'invalid' }, { connectorUrl: 'https://ok.invalid', token: 42 }])
  test('awaited create refuses malformed configuration without dispatch '+JSON.stringify(body), () => fixture(async f => {
    assert.equal((await f.request('POST', body, '')).status, 400); assert.equal(f.changes.length, 0);
  }));

test('optional display refusal keeps original committed create ACK and does not replay', () => fixture(async f => {
  f.before(kind => { if (kind === 'connectionSnapshot') throw Error('PRIVATE optional SELECT'); });
  const response = await f.request('POST', { id: 'created', connectorUrl: 'https://created.invalid' }, '');
  assert.equal(response.status, 201); const result = await response.json();
  assert.equal(result.connection.id, 'created'); assert.equal(result.connection.ownerLabel, undefined);
  assert.equal(f.changes.length, 1); assert.ok(f.store.getConnection('created', f.member.id));
}));

test('effect and optional display retain the original cookie despite mutable raw headers', () => fixture(async f => {
  const raw = new Request('http://fixture.invalid/api/hub/v1/connections/original', {
    method: 'PATCH', headers: { cookie: 'agentopsdeck_session=' + f.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Pinned request' }),
  });
  let displayReads = 0;
  f.after(kind => {
    if (kind === 'connectionChange') raw.headers.set('cookie', 'agentopsdeck_session=revoked');
    if (kind === 'connectionSnapshot') displayReads++;
  });
  const response = await f.app.fetch(raw);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connection.ownerLabel, 'Member');
  assert.equal(displayReads, 1); assert.equal(f.changes.length, 1);
}));

test('display suspension followed by connection epoch change denies stale delivery without compensating or retrying', () => fixture(async f => {
  f.before(kind => { if (kind === 'connectionSnapshot') f.store.upsertConnection({ id: 'original', ownerUserId: f.member.id,
    kind: 'remote', label: 'Changed elsewhere', connectorUrl: 'https://other.invalid' }); });
  assert.equal((await f.request()).status, 409); assert.equal(f.changes.length, 1);
  assert.equal(f.store.getConnection('original', f.member.id)!.label, 'Changed elsewhere');
}));

test('post-effect lost ACK returns unknown once and preserves the original row', () => fixture(async f => {
  f.after(kind => { if (kind === 'connectionChange') throw Error('PRIVATE lost ACK'); });
  const response = await f.request('POST', { id: 'created', connectorUrl: 'https://created.invalid' }, '');
  assert.equal(response.status, 503); assert.equal(f.changes.length, 1);
  assert.ok(f.store.getConnection('created', f.member.id)); assert.doesNotMatch(await response.text(), /PRIVATE/);
}));

test('worker-local SQL failure rolls back config and permits a later independent save', () => fixture(async f => {
  const db = (f.store as unknown as { db: DatabaseSync }).db;
  db.exec("CREATE TEMP TRIGGER reject_connection BEFORE UPDATE ON env_connections BEGIN SELECT RAISE(ABORT,'PRIVATE SQL'); END");
  assert.equal((await f.request()).status, 503);
  assert.equal(f.store.getConnection('original', f.member.id)!.label, 'Original');
  db.exec('DROP TRIGGER reject_connection');
  assert.equal((await f.request()).status, 200); assert.equal(f.changes.length, 2);
}));

test('revoke during admitted effect withholds old-account response and never repeats the write', () => fixture(async f => {
  f.after(kind => { if (kind === 'connectionChange') f.store.identities.revokeKey(f.member.id, f.key.id); });
  assert.equal((await f.request()).status, 401); assert.equal(f.changes.length, 1);
  assert.equal(f.store.getConnection('original', f.member.id)!.label, 'Renamed');
}));

test('closed HTTP facade denies writes without replacing or closing the original owner', () => fixture(async f => {
  f.routes.close(); assert.equal((await f.request()).status, 503); assert.equal(f.changes.length, 0);
  assert.ok(f.store.getConnection('original', f.member.id));
}));

for (const fault of phases) test('async connection '+fault+' diagnostics cannot replace the original effect or response', async t => {
  const diagnostic = new PerformanceDiagnostics(() => {});
  t.mock.method(diagnostic, 'start', () => {
    if (fault === 'start') throw Error('PRIVATE log start');
    return {
      get add() { if (fault === 'add-getter') throw Error('PRIVATE getter'); return () => { if (fault === 'add') throw Error('PRIVATE add'); }; },
      get reportPending() { if (fault === 'pending-getter') throw Error('PRIVATE getter'); return () => { if (fault === 'pending') throw Error('PRIVATE pending'); }; },
      get finish() { if (fault === 'finish-getter') throw Error('PRIVATE getter'); return () => { if (fault === 'finish') throw Error('PRIVATE finish'); }; },
    };
  });
  await fixture(async f => {
    f.before(async kind => { if (kind === 'connectionSnapshot') await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal((await f.request()).status, 200); assert.equal(f.changes.length, 1);
    assert.equal(f.store.getConnection('original', f.member.id)!.label, 'Renamed');
  }, diagnostic, 1);
});

test('real worker HTTP save and physical reopen preserve original cookie and encrypted credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'async-connection-worker-http-')), file = join(root, 'hub.sqlite');
  const original = new HubStore(file, 'fixture'), s = seed(original); await original.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet);
  try {
    await owner.open(); const f = mount(new AsyncHubMemberRequests(owner, quiet), s.token);
    try { assert.equal((await f.request()).status, 200); }
    finally { f.routes.close(); await owner.close(); }
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
    const reopened = new HubStore(file, 'fixture');
    try {
      assert.equal(reopened.getConnection('original', s.member.id)!.label, 'Renamed');
      assert.equal(reopened.getCredentialToken('original', s.member.id), 'PRIVATE daily');
      assert.deepEqual(reopened.identities.requestPrincipal(new Request('http://fixture.invalid', {
        headers: { cookie: 'agentopsdeck_session=' + s.token } }), () => false), { userId: s.member.id, admin: false });
    } finally { await reopened.close(); }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

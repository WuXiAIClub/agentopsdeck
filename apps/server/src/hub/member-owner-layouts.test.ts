import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner, encodeHubMemberJson } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput } from './member-owner-domain.js';
import { HUB_LAYOUT_RPC_BYTES } from './member-layout-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const document = (active: unknown = null) => ({ revision: 0, content: JSON.stringify({
  id: 'current', name: 'Current', workspace: { version: 2, panes: [], floating: [], active }, collapsedKeys: [],
}) });
async function fixture(work: (f: ReturnType<typeof seed>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-layout-owner-r46-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'layout-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Existing member'), second = store.createUser('Other member');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }), layoutKind: 'current' as const };
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, file, member, second, key, token, proof, db };
}
test('layout worker preserves saved content, stale identical reply reconciliation, CAS and old cookie on reopening', () => fixture(async f => {
  const initial = document(), saved = f.store.layouts.save(f.member.id, 'current', initial)!;
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'layout-fixture' }, quiet);
  try {
    await owner.open();
    assert.deepEqual(await owner.command('layoutGet', f.proof), wire({ document: saved }));
    assert.deepEqual(await owner.command('layoutSave', { ...f.proof, document: initial }), wire({ document: saved }));
    assert.deepEqual(await owner.command('layoutSave', { ...f.proof, document: document('different') }), { conflict: true });
    const changed = { ...document('changed'), revision: 1 };
    assert.deepEqual(await owner.command('layoutSave', { ...f.proof, document: changed }), { document: { ...changed, revision: 2 } });
  } finally { await owner.close(); }
  const old = new HubStore(f.file, 'layout-fixture');
  try {
    assert.deepEqual(wire(old.layouts.get(f.member.id, 'current')), { ...document('changed'), revision: 2 });
    assert.deepEqual(old.layouts.get(f.second.id, 'current'), { revision: 0, content: null });
    assert.ok(old.identities.requestPrincipal(new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + f.token } }), () => false));
  } finally { await old.close(); }
}));
test('layout authority and CAS share original savepoint; client userId and permission booleans cannot authorize', () => fixture(async f => {
  const command = (proof: typeof f.proof) => executeHubMemberCommand(f.store, 'layoutSave', { ...proof, document: document() });
  assert.equal(command({ ...f.proof, expectedScope: '0'.repeat(64) }), null);
  for (const extra of [{ userId: f.second.id }, { authorized: true }, { admin: true }]) {
    assert.equal(validHubMemberInput('layoutSave', { ...f.proof, document: document(), ...extra }), false);
  }
  assert.equal(validHubMemberInput('layoutGet', { ...f.proof, layoutKind: 'arbitrary' }), false);
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(command(f.proof), null);
  assert.equal(f.store.layouts.get(f.member.id, 'current').revision, 0);
  assert.equal(f.store.layouts.get(f.second.id, 'current').revision, 0);
}));
test('layout trigger failure rolls back, retains old document, and permits subsequent CAS without replacement writer', () => fixture(async f => {
  const original = f.store.layouts.save(f.member.id, 'current', document())!;
  f.db.exec("CREATE TRIGGER reject_layout BEFORE UPDATE ON hub_workspace_layouts BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END");
  const next = { ...document('changed'), revision: 1 };
  assert.throws(() => executeHubMemberCommand(f.store, 'layoutSave', { ...f.proof, document: next }));
  assert.deepEqual(f.store.layouts.get(f.member.id, 'current'), original);
  f.db.exec('DROP TRIGGER reject_layout');
  assert.deepEqual(wire(executeHubMemberCommand(f.store, 'layoutSave', { ...f.proof, document: next })), { document: { ...next, revision: 2 } });
  assert.equal(f.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
}));
test('layout old MAX_SAFE_INTEGER revision and opaque presentation envelope remain readable but cannot wrap on write', () => fixture(async f => {
  f.db.prepare('INSERT INTO hub_workspace_layouts VALUES (?, ?, ?, ?)').run(f.member.id, 'current', Number.MAX_SAFE_INTEGER, 'old-opaque-layout');
  const read = executeHubMemberCommand(f.store, 'layoutGet', f.proof);
  assert.deepEqual(wire(read), { document: { revision: Number.MAX_SAFE_INTEGER, content: 'old-opaque-layout' } });
  assert.equal(validHubMemberOutput('layoutGet', read), true);
  assert.equal(validHubMemberInput('layoutSave', { ...f.proof, document: { ...document(), revision: Number.MAX_SAFE_INTEGER } }), false);
}));

test('layout result envelope never fabricates a read conflict, negative revision, missing content or extra authority', () => {
  for (const value of [{ conflict: true }, { document: { revision: -1, content: 'old' } },
    { document: { revision: 1, content: null } }, { document: { revision: 0 } },
    { document: { revision: 0, content: null, userId: 'other' } }]) {
    assert.equal(validHubMemberOutput('layoutGet', value), false);
  }
  assert.equal(validHubMemberOutput('layoutSave', { conflict: true }), true);
  assert.equal(validHubMemberOutput('layoutGet', null), true);
});
test('layout full 1MiB escaped saved content crosses real worker boundary without expanded JSON depth reduction', () => fixture(async f => {
  let nested: unknown = 'leaf'; for (let i = 0; i < 60; i++) nested = { child: nested };
  const item = { ...JSON.parse(document().content), id: 'saved', name: 'Saved' };
  item.workspace.active = nested;
  item.workspace.padding = '';
  const empty = JSON.stringify([item]);
  item.workspace.padding = '"'.repeat((1_048_576 - Buffer.byteLength(empty)) / 2 | 0);
  const value = { revision: 0, content: JSON.stringify([item]) }, proof = { ...f.proof, layoutKind: 'saved' as const };
  assert.ok(Buffer.byteLength(value.content) >= 1_048_575);
  assert.equal(validHubMemberInput('layoutSave', { ...proof, document: value }), true);
  assert.ok(Buffer.byteLength(encodeHubMemberJson({ ...proof, document: value }, HUB_LAYOUT_RPC_BYTES)) > 1_048_576);
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'layout-fixture' }, quiet);
  try {
    await owner.open();
    assert.deepEqual(await owner.command('layoutSave', { ...proof, document: value }), { document: { ...value, revision: 1 } });
    assert.deepEqual(await owner.command('layoutGet', proof), { document: { ...value, revision: 1 } });
  } finally { await owner.close(); }
}));

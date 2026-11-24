import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { initializeHubMemberOwner, initializeHubDefaultConnection, parseHubMemberBootstrap } from './member-owner-bootstrap.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {});
const input = { legacyPreferences: { hidden: 'hidden.json', archived: 'archived.json', pinned: 'pinned.json' } };

test('default configuration preserves original empty labels and environment while rejecting executable or extra data', () => {
  const local = { kind: 'local', id: 'local', label: '', environmentId: '', environmentLabel: '', status: 'degraded' };
  assert.deepEqual(parseHubMemberBootstrap({ ...input, defaultConnection: local }).defaultConnection, local);
  for (const defaultConnection of [{ ...local, status: 'invented' }, { ...local, replay: true },
    { kind: 'remote', id: 'remote', label: '', connectorUrl: 'http://localhost', callback: () => {} }]) {
    assert.throws(() => parseHubMemberBootstrap({ ...input, defaultConnection }));
  }
});

test('default remote reopen preserves disabled status and absent credentials, applies explicit credentials; local keeps overrides', t => {
  const { store } = fixture(t);
  store.upsertConnection({ id: 'remote', label: 'Original', connectorUrl: 'http://old.invalid', credentialToken: 'original-secret', status: 'disabled' });
  initializeHubDefaultConnection(store, { kind: 'remote', id: 'remote', label: 'Updated', connectorUrl: 'http://new.invalid' });
  assert.equal(store.getConnection('remote')?.status, 'disabled');
  assert.equal(store.getCredentialToken('remote'), 'original-secret');
  assert.equal(store.getConnection('remote')?.connectorUrl, 'http://new.invalid');
  initializeHubDefaultConnection(store, { kind: 'remote', id: 'remote', label: 'Updated', connectorUrl: 'http://new.invalid', credentialToken: 'replacement-secret' });
  assert.equal(store.getCredentialToken('remote'), 'replacement-secret');
  assert.equal(store.getConnection('remote')?.status, 'disabled');
  store.upsertConnection({ id: 'local', kind: 'local', label: 'User label', connectorUrl: 'local://aod-connector', status: 'disabled', environmentId: 'original-env', environmentLabel: 'Original environment' });
  initializeHubDefaultConnection(store, { kind: 'local', id: 'local', label: 'Default', status: 'enabled', environmentId: 'changed', environmentLabel: 'Changed' });
  const local = store.getConnection('local');
  assert.equal(local?.status, 'disabled'); assert.equal(local?.label, 'User label');
  assert.equal(local?.environmentId, 'original-env'); assert.equal(local?.environmentLabel, 'Original environment');
});

test('bootstrap captures exact original configuration and never retains mutable path objects', () => {
  const supplied = { ...input, legacyPreferences: { ...input.legacyPreferences }, legacyPreferencesOwner: ' existing-owner ' };
  const copied = parseHubMemberBootstrap(supplied);
  assert.deepEqual(copied, supplied); supplied.legacyPreferences.hidden = 'replaced';
  assert.equal(copied.legacyPreferences.hidden, 'hidden.json');
});
for (const [label, value] of Object.entries({
  missing: undefined, array: [], null: null, unknown: { ...input, replay: true },
  absentFiles: {}, missingFlag: { legacyPreferences: { hidden: 'h', archived: 'a' } },
  extraFlag: { legacyPreferences: { ...input.legacyPreferences, deleted: 'd' } },
  emptyPath: { legacyPreferences: { ...input.legacyPreferences, hidden: '' } },
  nulPath: { legacyPreferences: { ...input.legacyPreferences, hidden: 'h\0x' } },
  promise: { legacyPreferences: Promise.resolve(input.legacyPreferences) },
  falseOwner: { ...input, legacyPreferencesOwner: false },
  falseLocalOwner: { ...input, ownLocalPreferences: false },
  executableLocalOwner: { ...input, ownLocalPreferences: () => true },
  oversized: { legacyPreferences: { ...input.legacyPreferences, hidden: 'x'.repeat(16_385) } },
})) test(`bootstrap refuses ${label} without treating it as empty legacy state`, () => {
  assert.throws(() => parseHubMemberBootstrap(value), /hub_member_storage_unavailable/);
});
test('bootstrap refuses executable descriptors and proxy configuration without invoking them', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'legacyPreferences', { enumerable: true, get() { calls++; return input.legacyPreferences; } });
  const proxy = new Proxy(input, { ownKeys() { calls++; return []; }, get() { calls++; return undefined; } });
  const pathGetter = { legacyPreferences: Object.defineProperty({ archived: 'a', pinned: 'p' }, 'hidden', { enumerable: true, get() { calls++; return 'h'; } }) };
  for (const value of [getter, proxy, pathGetter]) assert.throws(() => parseHubMemberBootstrap(value));
  assert.equal(calls, 0);
});

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hub-bootstrap-'));
  const file = join(root, 'hub.sqlite'), files = { hidden: join(root, 'private-hidden.json'), archived: join(root, 'private-archive.json'), pinned: join(root, 'private-pinned.json') };
  const store = new HubStore(file, 'isolated-bootstrap-secret');
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, file, files, store };
}
test('startup gate rejects missing administrator before reading or importing any legacy file', t => {
  const f = fixture(t); f.store.identities.issueKey('default');
  writeFileSync(f.files.hidden, '{corrupt source must not be read');
  assert.throws(() => initializeHubMemberOwner(f.store, { legacyPreferences: f.files }, undefined, quiet), /hub_member_storage_unavailable/);
  assert.equal(f.store.sessionPreferences('default').size, 0);
});
test('all legacy sources validate before the original import and preserve source bytes on failure', t => {
  const f = fixture(t), id = encodeHubSessionId('local', 'codex:old-session');
  const hidden = JSON.stringify([id]); writeFileSync(f.files.hidden, hidden); writeFileSync(f.files.pinned, '{bad');
  assert.throws(() => initializeHubMemberOwner(f.store, { legacyPreferences: f.files }, undefined, quiet), /Invalid legacy pinned preferences/);
  assert.equal(f.store.sessionPreferences('default').size, 0); assert.equal(readFileSync(f.files.hidden, 'utf8'), hidden);
  writeFileSync(f.files.pinned, '[]'); initializeHubMemberOwner(f.store, { legacyPreferences: f.files }, undefined, quiet);
  assert.equal(f.store.sessionPreferences('default').get(id)?.hidden, true);
});
test('explicit legacy owner retains original once-only migration and existing explicit preference choices', t => {
  const f = fixture(t), member = f.store.createUser('Existing member'), id = encodeHubSessionId('local', 'codex:old-session');
  f.store.setSessionPreference(id, 'hidden', false, member.id); writeFileSync(f.files.hidden, JSON.stringify([id]));
  assert.throws(() => initializeHubMemberOwner(f.store, { legacyPreferences: f.files }, undefined, quiet), /ambiguous or unknown/);
  assert.equal(f.store.sessionPreferences('default').size, 0);
  initializeHubMemberOwner(f.store, { legacyPreferences: f.files, legacyPreferencesOwner: member.id }, undefined, quiet);
  assert.equal(f.store.sessionPreferences(member.id).get(id)?.hidden, false);
  writeFileSync(f.files.pinned, JSON.stringify([id]));
  initializeHubMemberOwner(f.store, { legacyPreferences: f.files, legacyPreferencesOwner: 'default' }, undefined, quiet);
  assert.equal(f.store.sessionPreferences('default').size, 0); assert.equal(f.store.sessionPreferences(member.id).get(id)?.pinned, undefined);
});
test('bootstrap records numeric startup outcome without paths, keys or error text and tolerates a failed sink', t => {
  const f = fixture(t); f.store.identities.issueKey('default');
  const rows: string[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(line), () => 0);
  assert.throws(() => initializeHubMemberOwner(f.store, { legacyPreferences: f.files }, undefined, diagnostics));
  assert.equal(rows.length, 1); const row = JSON.parse(rows[0]!);
  assert.equal(row.operation, 'hub-member-sqlite-owner'); assert.equal(row.step, 13); assert.equal(row.deferred, 1);
  for (const text of [f.root, 'private-hidden', 'isolated-bootstrap-secret', 'hub_member_storage_unavailable']) assert.equal(rows.join('').includes(text), false);
  const broken = { start() { throw Error('sink failure'); } } as unknown as PerformanceDiagnostics;
  assert.throws(() => initializeHubMemberOwner(f.store, { legacyPreferences: f.files }, undefined, broken), /hub_member_storage_unavailable/);
  initializeHubMemberOwner(f.store, { legacyPreferences: f.files }, 'synthetic-administrator', broken);
});

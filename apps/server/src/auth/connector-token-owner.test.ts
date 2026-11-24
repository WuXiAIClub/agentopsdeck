import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore } from './connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const broken of ['start', 'add', 'finish'] as const)
  test(`token observation ${broken} failure cannot alter durable create, revoke or owner retirement`, t => {
    class BrokenDiagnostics extends PerformanceDiagnostics {
      override start(operation: Parameters<PerformanceDiagnostics['start']>[0]) {
        if (broken === 'start') throw Error('private-observation-fault');
        const trace = super.start(operation);
        trace[broken] = () => { throw Error('private-observation-fault'); }; return trace;
      }
    }
    const { file } = fixture(t), store = new ConnectorTokenStore(file, undefined, new BrokenDiagnostics(() => {}));
    const issued = store.create({ label: 'fixture' });
    assert.equal(store.hasScope(issued.record.id, 'messages:send'), true);
    assert.equal(store.revoke(issued.record.id), true);
    assert.equal(new ConnectorTokenStore(file).hasScope(issued.record.id, 'messages:send'), false);
    const live = store.create({ label: 'still-active-durably' }); const before = readFileSync(file, 'utf8');
    mkdirSync(file + '.writer-lock');
    const revision = store.changes.revision;
    assert.throws(() => store.revoke(live.record.id), /auth_persistence_failed/);
    assert.equal(store.changes.revision, revision + 1);
    assert.equal(store.hasScope(live.record.id, 'messages:send'), false);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(new ConnectorTokenStore(file).hasScope(live.record.id, 'messages:send'), true);
  });
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-token-recovery-red-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'tokens.json') };
}
for (const value of ['{private-corrupt-token', '{"version":2,"records":[]}', '{"version":1,"records":[{}]}'])
  test('damaged or unsupported token data cannot become an empty bootstrap store: ' + value.length, t => {
    const { file } = fixture(t); writeFileSync(file, value);
    assert.throws(() => new ConnectorTokenStore(file, 'synthetic-bootstrap'), /auth_persistence_failed/);
    assert.equal(readFileSync(file, 'utf8'), value);
  });
test('a stale original owner cannot authorize or overwrite a newer durable revocation', t => {
  const { file } = fixture(t), first = new ConnectorTokenStore(file);
  const issued = first.create({ label: 'synthetic', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub-test' });
  const local = first.createTransient(['messages:send']);
  const second = new ConnectorTokenStore(file);
  second.revoke(issued.record.id);
  const durable = readFileSync(file, 'utf8');
  assert.equal(first.authenticate(new Request('http://test.invalid', { headers: { authorization: `Bearer ${issued.token}` } })), undefined);
  assert.equal(first.hasScope(issued.record.id, 'messages:send'), false);
  assert.equal(first.delegationHubId(issued.record.id), undefined);
  assert.equal(first.hasScope('unrelated', 'messages:send'), false);
  assert.equal(first.authenticate(new Request('http://test.invalid', { headers: { authorization: `Bearer ${local.token}` } })), undefined);
  assert.throws(() => first.create({ label: 'cannot overwrite' }), /auth_persistence_failed/);
  assert.equal(readFileSync(file, 'utf8'), durable);
  const reopened = new ConnectorTokenStore(file);
  assert.equal(reopened.hasScope(issued.record.id, 'messages:send'), false);
});
test('failed original token save does not publish a newly created credential', t => {
  const { file } = fixture(t), store = new ConnectorTokenStore(file);
  const initial = store.create({ label: 'initial' }), before = readFileSync(file, 'utf8');
  mkdirSync(file + '.writer-lock');
  assert.throws(() => store.create({ label: 'failed-create' }), /auth_persistence_failed/);
  assert.deepEqual(store.list().map(r => r.id), [initial.record.id]);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(statSync(file + '.writer-lock').isDirectory(), true);
});
test('list and create DTOs cannot mutate the authoritative scope array', t => {
  const { file } = fixture(t), store = new ConnectorTokenStore(file);
  const created = store.create({ label: 'reader', scopes: ['messages:read'] });
  created.record.scopes.push('messages:send');
  store.list()[0]!.scopes.push('execution:delegate');
  assert.equal(store.hasScope(created.record.id, 'messages:send'), false);
  assert.equal(store.hasScope(created.record.id, 'execution:delegate'), false);
});
test('atomic durable replacement uses private permissions and survives reopen', t => {
  const { file } = fixture(t), store = new ConnectorTokenStore(file);
  const created = store.create({ label: 'reader', scopes: ['messages:read'] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const oldInode = statSync(file).ino;
  // Create a deliberately permissive ORIGINAL fixture before opening its owner.
  chmodSync(file, 0o644);
  const reopened = new ConnectorTokenStore(file);
  assert.equal(reopened.hasScope(created.record.id, 'messages:read'), true);
  reopened.revoke(created.record.id);
  assert.notEqual(statSync(file).ino, oldInode, 'replacement must be atomic, not an in-place truncate');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(new ConnectorTokenStore(file).hasScope(created.record.id, 'messages:read'), false);
});

test('failed revoke retires authority once, preserves original durable facts and never steals the writer lock', async t => {
  const { file } = fixture(t);
  const lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const store = new ConnectorTokenStore(file, undefined, diagnostics);
  const issued = store.create({ label: 'private-fixture-label', scopes: ['messages:send'] });
  const local = store.createTransient(['messages:send']);
  const before = readFileSync(file, 'utf8');
  const revision = store.changes.revision;
  const controller = new AbortController();
  const wake = store.changes.wait(revision, controller.signal);
  mkdirSync(file + '.writer-lock');
  assert.throws(() => store.revoke(issued.record.id), /auth_persistence_failed/);
  await wake;
  assert.equal(store.changes.revision, revision + 1);
  const request = (token: string) => new Request('http://test.invalid', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(store.authenticate(request(issued.token)), undefined);
  assert.equal(store.authenticate(request(local.token)), undefined);
  assert.throws(() => store.create({ label: 'no replay' }), /auth_persistence_failed/);
  assert.throws(() => store.createTransient(), /auth_persistence_failed/);
  assert.throws(() => store.list(), /auth_persistence_failed/);
  assert.equal(store.changes.revision, revision + 1, 'retirement must not repeatedly wake consumers');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(statSync(file + '.writer-lock').isDirectory());
  // Failure denied THIS owner; it is not a receipt proving durable revocation.
  assert.ok(new ConnectorTokenStore(file).authenticate(request(issued.token)));
  const rows = lines.map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.operation === 'connector-token-owner' && row.step === 4).length, 1);
  assert.ok(rows.some(row => row.step === 3 && row.unknown === 1));
  assert.doesNotMatch(lines.join('\n'), /private-fixture-label|aod_conn_|tokens\.json|writer-lock/);
});

test('stale retirement is latched and logged once even if the original file is restored', t => {
  const { file } = fixture(t), lines: string[] = [];
  const store = new ConnectorTokenStore(file, undefined, new PerformanceDiagnostics(line => lines.push(line)));
  const issued = store.create({ label: 'fixture', scopes: ['messages:read'] });
  const original = readFileSync(file, 'utf8'), revision = store.changes.revision;
  new ConnectorTokenStore(file).revoke(issued.record.id);
  assert.equal(store.hasScope(issued.record.id, 'messages:read'), false);
  writeFileSync(file, original);
  assert.equal(store.hasScope(issued.record.id, 'messages:read'), false);
  assert.throws(() => store.create({ label: 'cannot resurrect' }), /auth_persistence_failed/);
  assert.equal(store.changes.revision, revision + 1);
  assert.equal(lines.map(line => JSON.parse(line)).filter(row => row.step === 2).length, 1);
});

test('a zero revocation timestamp is a durable denial and bootstrap rotation never reuses an identity', t => {
  const { file } = fixture(t);
  const first = new ConnectorTokenStore(file, 'synthetic-first-bootstrap');
  const originalId = first.list()[0]!.id;
  const document = JSON.parse(readFileSync(file, 'utf8'));
  document.records[0].revokedAt = 0;
  writeFileSync(file, JSON.stringify(document));
  const reopened = new ConnectorTokenStore(file, 'synthetic-second-bootstrap');
  assert.equal(reopened.hasScope(originalId, 'messages:send'), false);
  const records = reopened.list();
  assert.equal(records.length, 2);
  assert.notEqual(records[1]!.id, originalId);
  assert.equal(new ConnectorTokenStore(file).hasScope(records[1]!.id, 'messages:send'), true);
});

test('revoking a historical duplicate bootstrap identity denies every matching durable credential without deleting history', t => {
  const { file } = fixture(t), original = new ConnectorTokenStore(file);
  const first = original.create({ label: 'old-bootstrap-1', scopes: ['messages:send'] });
  const second = original.create({ label: 'old-bootstrap-2', scopes: ['events:read'] });
  const other = original.create({ label: 'unrelated', scopes: ['messages:read'] });
  const document = JSON.parse(readFileSync(file, 'utf8'));
  document.records[0].id = 'tok_bootstrap';
  document.records[1].id = 'tok_bootstrap';
  writeFileSync(file, JSON.stringify(document));
  const store = new ConnectorTokenStore(file);
  const request = (token: string) => new Request('http://test.invalid', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(store.authenticate(request(first.token)), undefined);
  assert.equal(store.authenticate(request(second.token)), undefined);
  assert.equal(store.revoke('tok_bootstrap'), true);
  assert.equal(store.changes.revision, 1);
  assert.equal(store.authenticate(request(first.token)), undefined);
  assert.equal(store.authenticate(request(second.token)), undefined);
  assert.equal(store.hasScope('tok_bootstrap', 'events:read'), false);
  assert.ok(store.authenticate(request(other.token)));
  assert.equal(store.revoke('tok_bootstrap'), false);
  assert.equal(store.changes.revision, 1);
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.records.length, 3);
  assert.equal(persisted.records[0].revokedAt, persisted.records[1].revokedAt);
  assert.equal(persisted.records[2].revokedAt, undefined);
  assert.equal(new ConnectorTokenStore(file).authenticate(request(second.token)), undefined);
});

for (const revokedAt of [undefined, 0] as const) test(`historical duplicate IDs deny all authority without rewriting history (${revokedAt})`, t => {
  const { file } = fixture(t), original = new ConnectorTokenStore(file);
  const first = original.create({ label: 'historical', scopes: ['events:read'] });
  const second = original.create({ label: 'newer', scopes: ['messages:send', 'execution:delegate'], delegationHubId: 'hub-test' });
  const other = original.create({ label: 'unrelated', scopes: ['messages:read'] });
  const document = JSON.parse(readFileSync(file, 'utf8'));
  document.records[1].id = first.record.id;
  if (revokedAt !== undefined) document.records[0].revokedAt = revokedAt;
  writeFileSync(file, JSON.stringify(document));
  const before = readFileSync(file, 'utf8'), lines: string[] = [];
  const store = new ConnectorTokenStore(file, first.token, new PerformanceDiagnostics(line => lines.push(line)));
  const request = (token: string) => new Request('http://test.invalid', { headers: { authorization: `Bearer ${token}` } });
  for (const token of [first.token, second.token]) assert.equal(store.authenticate(request(token)), undefined);
  for (const scope of ['events:read', 'messages:send', 'execution:delegate'] as const)
    assert.equal(store.hasScope(first.record.id, scope), false);
  assert.equal(store.delegationHubId(first.record.id), undefined);
  assert.ok(store.authenticate(request(other.token)));
  const transient = store.createTransient(['messages:send']);
  assert.ok(store.authenticate(request(transient.token))); transient.dispose();
  assert.equal(readFileSync(file, 'utf8'), before, 'bootstrap must not implicitly expand ambiguous authority');
  assert.deepEqual(store.list().map(row => row.identityAmbiguous), [true, true, undefined]);
  const events = lines.map(line => JSON.parse(line)).filter(row => row.operation === 'connector-token-owner');
  assert.equal(events.length, 1); assert.equal(events[0].step, 5); assert.equal(events[0].pending, 1);
  assert.equal(events[0].unknown, undefined);
  for (const secret of [first.token, second.token, first.record.id, file, 'hub-test']) assert.equal(JSON.stringify(events).includes(secret), false);
});

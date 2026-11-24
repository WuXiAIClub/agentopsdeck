import { mkdtempSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorTokenStore } from './connector-token.js';

test('lifecycle maintenance is an explicit durable scope, not a default or update privilege', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-lifecycle-scope-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'tokens.json');
  const store = new ConnectorTokenStore(file, 'synthetic-bootstrap');
  const ordinary = store.create({ label: 'ordinary' });
  const update = store.create({ label: 'updater', scopes: ['connector:update'] });
  const local = store.createTransient(undefined, 'local:default');
  assert.match(local.token, /^aod_local_[A-Za-z0-9_-]{43}$/);
  for (const id of ['tok_bootstrap', ordinary.record.id, update.record.id, 'local:default']) {
    assert.equal(store.hasScope(id, 'connector:lifecycle'), false);
  }
  const explicit = store.create({ label: 'node supervisor', scopes: ['connector:lifecycle'] });
  const reopened = new ConnectorTokenStore(file, 'synthetic-bootstrap');
  assert.equal(reopened.hasScope(explicit.record.id, 'connector:lifecycle'), true);
  assert.equal(reopened.hasScope('tok_bootstrap', 'connector:lifecycle'), false);
  assert.equal(reopened.hasScope(explicit.record.id, 'messages:send'), false);
  reopened.revoke(explicit.record.id);
  assert.equal(new ConnectorTokenStore(file).hasScope(explicit.record.id, 'connector:lifecycle'), false);
  local.dispose();
});

test('revocation and transient disposal wake readers, including failed revoke persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-revoke-wake-'));
  try {
    const file = join(dir, 'tokens.json');
    const tokens = new ConnectorTokenStore(file);
    const persistent = tokens.create({ label: 'synthetic', scopes: ['events:read'] });
    const transient = tokens.createTransient(['events:read']);
    const controller = new AbortController();
    const wait = tokens.changes.wait(tokens.changes.revision, controller.signal);
    transient.dispose();
    await wait;
    assert.equal(tokens.changes.revision, 1);
    transient.dispose();
    assert.equal(tokens.changes.revision, 1);
    rmSync(file);
    mkdirSync(file);
    const revoked = tokens.changes.wait(tokens.changes.revision, controller.signal);
    assert.throws(() => tokens.revoke(persistent.record.id));
    await revoked;
    assert.equal(tokens.hasScope(persistent.record.id, 'events:read'), false);
    assert.equal(tokens.changes.waiting, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('execution delegation requires opt-in and is never a bootstrap or default privilege', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-delegation-scope-')), 'tokens.json');
  const store = new ConnectorTokenStore(file, 'synthetic-bootstrap');
  const ordinary = store.create({ label: 'ordinary' });
  const local = store.createTransient(undefined, 'local:default');
  for (const id of ['tok_bootstrap', ordinary.record.id, 'local:default']) {
    assert.equal(store.hasScope(id, 'messages:send'), true);
    assert.equal(store.hasScope(id, 'execution:delegate'), false);
    assert.equal(store.hasScope(id, 'messages:mirror'), false);
  }
  const issuer = store.create({ label: 'explicit issuer', scopes: ['messages:send', 'execution:delegate'] });
  assert.equal(store.hasScope(issuer.record.id, 'execution:delegate'), true);
  assert.equal(new ConnectorTokenStore(file, 'synthetic-bootstrap').hasScope('tok_bootstrap', 'execution:delegate'), false);
  local.dispose();
});

test('delegation issuer Hub binding is explicit, durable and revoked with its credential', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-issuer-binding-')), 'tokens.json');
  const tokens = new ConnectorTokenStore(file);
  const scopes = ['messages:send', 'execution:delegate'] as const;
  const unbound = tokens.create({ label: 'unbound', scopes: [...scopes] });
  assert.equal(tokens.delegationHubId(unbound.record.id), undefined);
  for (const delegationHubId of ['', 'hub\n', 'x'.repeat(129)]) {
    assert.throws(() => tokens.create({ label: 'bad', scopes: [...scopes], delegationHubId }), /binding/);
  }
  assert.throws(() => tokens.create({ label: 'bad', delegationHubId: 'hub' }), /binding/);
  const issuer = tokens.create({ label: 'issuer', scopes: [...scopes], delegationHubId: 'hub-test' });
  assert.equal(tokens.delegationHubId(issuer.record.id), 'hub-test');
  const reopened = new ConnectorTokenStore(file);
  assert.equal(reopened.delegationHubId(issuer.record.id), 'hub-test');
  reopened.revoke(issuer.record.id);
  assert.equal(reopened.delegationHubId(issuer.record.id), undefined);
});

test('queued identity lookup respects revocation, scope and local capability disposal without retaining secrets', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-actor-')), 'tokens.json');
  const store = new ConnectorTokenStore(file);
  const writer = store.create({ label: 'writer', scopes: ['messages:send'] });
  const reader = store.create({ label: 'reader', scopes: ['messages:read'] });
  assert.equal(store.hasScope(undefined, 'messages:send'), false);
  assert.equal(store.hasScope(writer.token, 'messages:send'), false);
  assert.equal(store.hasScope(writer.record.id, 'messages:send'), true);
  assert.equal(store.hasScope(reader.record.id, 'messages:send'), false);
  store.revoke(writer.record.id);
  assert.equal(store.hasScope(writer.record.id, 'messages:send'), false);
  assert.equal(new ConnectorTokenStore(file).hasScope(writer.record.id, 'messages:send'), false);
  const local = store.createTransient(['messages:send'], 'local:daily');
  assert.throws(() => store.createTransient(['messages:send'], 'local:daily'), /already exists/);
  assert.throws(() => store.createTransient(['messages:send'], writer.record.id), /already exists/);
  assert.equal(store.hasScope('local:daily', 'messages:send'), true);
  local.dispose();
  assert.equal(store.hasScope('local:daily', 'messages:send'), false);
  const rotated = store.createTransient(['messages:send'], 'local:daily');
  assert.notEqual(rotated.token, local.token);
  assert.equal(store.hasScope('local:daily', 'messages:send'), true);
  rotated.dispose();
});

test('connector token store hashes bootstrap tokens and authenticates by bearer scope', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-connector-token-')), 'tokens.json');
  const store = new ConnectorTokenStore(file, 'secret-bootstrap-token');
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes('secret-bootstrap-token'), false);

  const request = new Request('http://connector.test/api/connector/v1/capabilities', {
    headers: { authorization: 'Bearer secret-bootstrap-token' },
  });
  const principal = store.requireScope(request, 'sessions:read');
  assert.equal(principal?.tokenId, 'tok_bootstrap');
  assert.equal(principal?.scopes.includes('messages:send'), true);
});

test('connector token create returns raw token once and revoke disables it', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-connector-token-')), 'tokens.json');
  const store = new ConnectorTokenStore(file);
  const created = store.create({ label: 'Read only Hub', scopes: ['sessions:read'] });
  assert.match(created.token, /^aod_conn_[A-Za-z0-9_-]{32}$/);
  assert.equal(JSON.stringify(created.record).includes(created.token), false);

  const request = new Request('http://connector.test/api/connector/v1/sessions/state', {
    headers: { authorization: `Bearer ${created.token}` },
  });
  assert.equal(store.requireScope(request, 'sessions:read')?.label, 'Read only Hub');
  assert.equal(store.requireScope(request, 'messages:send'), undefined);
  assert.equal(store.revoke(created.record.id), true);
  assert.equal(store.authenticate(request), undefined);
});

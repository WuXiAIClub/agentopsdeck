import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ExecutionGrants, ExecutionIssuerDenied, createTurnAuthorizer } from './execution-grants.js';
import { createMirrorAuthorizer } from './mirror-authorization.js';
import { resolveExplicitChannelRoute, type MirrorParams } from '../messages/mirror.js';

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-authority-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json')), database = new DatabaseSync(':memory:');
  let now = 1000;
  const grants = new ExecutionGrants(database, (id, action) => tokens.hasScope(id, 'execution:delegate')
    && tokens.hasScope(id, 'messages:send') && (action !== 'messages:mirror' || tokens.hasScope(id, 'messages:mirror')), () => now);
  const authorize = createMirrorAuthorizer(createTurnAuthorizer(grants, (id, scope) => tokens.hasScope(id, scope)), 'main');
  const sessionKey = 'agent:original:feishu:direct:synthetic-user';
  const explicitRoute = resolveExplicitChannelRoute(sessionKey, 'main'); assert.ok(explicitRoute);
  const params: MirrorParams = { actorId: 'local:daily', sessionKey, explicitRoute, after: 1, inputText: 'input', idempotencyKey: 'one' };
  context.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  return { tokens, grants, authorize, params, advance: () => { now = 2000; } };
}

test('local mirror preserves only original local route and current daily authority', context => {
  const setup = fixture(context), credential = setup.tokens.createTransient(undefined, 'local:daily');
  assert.equal(setup.authorize(setup.params), true);
  for (const field of ['originatingChannel', 'originatingTo', 'originatingAccountId', 'outboundTarget']) {
    assert.equal(setup.authorize({ ...setup.params, explicitRoute: { ...setup.params.explicitRoute, [field]: 'different' } }), false);
  }
  for (const actorId of ['actor_hub', 'other-token', 'local:maintenance']) {
    assert.equal(setup.authorize({ ...setup.params, actorId }), false);
  }
  const { actorId: originalActor, ...anonymous } = setup.params;
  assert.equal(originalActor, 'local:daily');
  assert.equal(setup.authorize(anonymous), false);
  assert.equal(setup.authorize({ ...setup.params, executionGrant: { id: 'grant', actorId: 'local:daily', issuerTokenId: 'issuer' } }), false);
  assert.equal(setup.authorize({ ...setup.params, sessionKey: 'agent:original:feishu:direct:other-user' }), false);
  assert.equal(setup.authorize({ ...setup.params, sessionKey: 'agent:original:dashboard' }), false);
  credential.dispose();
  assert.equal(setup.authorize(setup.params), false);
});

test('direct external mirror requires explicit send and mirror scopes without widening old credentials', context => {
  const setup = fixture(context);
  for (const scopes of [undefined, ['messages:send'] as const, ['messages:mirror'] as const, ['messages:send', 'messages:mirror'] as const]) {
    const credential = setup.tokens.create({ label: 'synthetic', ...(scopes ? { scopes: [...scopes] } : {}) });
    const params = { ...setup.params, actorId: credential.record.id };
    assert.equal(setup.authorize(params), scopes?.length === 2);
    setup.tokens.revoke(credential.record.id);
    assert.equal(setup.authorize(params), false);
  }
});

test('send-only issuer cannot issue mirror authority or leave a partial grant', context => {
  const setup = fixture(context);
  const issuer = setup.tokens.create({ label: 'synthetic send issuer', delegationHubId: 'hub-synthetic',
    scopes: ['execution:delegate', 'messages:send'] });
  const binding = { issuerTokenId: issuer.record.id, hubId: 'hub-synthetic', principalId: 'synthetic-user',
    grantKey: 'original-policy', version: 1, runtime: 'openclaw' as const, sessionKey: setup.params.sessionKey };
  assert.throws(() => setup.grants.issue(binding, ['messages:send', 'messages:mirror'], 2000), ExecutionIssuerDenied);
  const ref = setup.grants.issue(binding, ['messages:send'], 2000);
  assert.equal(setup.authorize({ ...setup.params, actorId: ref.actorId,
    executionGrant: { ...ref, issuerTokenId: issuer.record.id } }), false);
});

for (const failure of ['expiry', 'revoke', 'issuer', 'target', 'actor', 'send-only'] as const) {
  test(`delegated mirror retains exact original actor/issuer/session/actions and rejects ${failure}`, context => {
    const setup = fixture(context);
    const issuer = setup.tokens.create({ label: 'synthetic issuer', delegationHubId: 'hub-synthetic',
      scopes: ['execution:delegate', 'messages:send', 'messages:mirror'] });
    const binding = { issuerTokenId: issuer.record.id, hubId: 'hub-synthetic', principalId: 'synthetic-user',
      grantKey: 'original-policy', version: 1, runtime: 'openclaw' as const, sessionKey: setup.params.sessionKey };
    const ref = setup.grants.issue(binding, failure === 'send-only' ? ['messages:send'] : ['messages:send', 'messages:mirror'], 2000);
    const params = { ...setup.params, actorId: ref.actorId, executionGrant: { ...ref, issuerTokenId: issuer.record.id } };
    assert.equal(setup.authorize(params), failure !== 'send-only');
    if (failure === 'expiry') setup.advance();
    if (failure === 'revoke') setup.grants.revoke(issuer.record.id, ref.id);
    if (failure === 'issuer') setup.tokens.revoke(issuer.record.id);
    if (failure === 'actor') params.actorId = 'actor_someone_else';
    if (failure === 'target') {
      params.sessionKey = 'agent:original:feishu:direct:other-user';
      params.explicitRoute = resolveExplicitChannelRoute(params.sessionKey, 'main')!;
    }
    assert.equal(setup.authorize(params), false);
    if (failure === 'revoke') {
      setup.grants.issue({ ...binding, version: 2 }, ['messages:send', 'messages:mirror'], 2000);
      assert.equal(setup.authorize(params), false);
    }
  });
}

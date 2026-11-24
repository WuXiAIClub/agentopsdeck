import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Exercise the sealed candidate's HTTP authority, not a second store or a
// transport mock. All identities belong to the caller's disposable Hub.
export async function verifyJointRoles({ api, administrator, alice, session, creationPath }) {
  const request = api;
  let phase = 'observer';
  api = async (...args) => {
    try { return await request(...args); }
    catch (error) { throw new Error(`Role acceptance (${phase}): ${error.message}`); }
  };
  const memberPath = id => `/api/hub/v1/access/default/connections/isolated-codex/members/${id}`;
  async function identity(label) {
    const { user } = await api(administrator, '/api/hub/v1/users', 'POST', { label }, 201);
    const key = await api(administrator, `/api/hub/v1/users/${user.id}/login-keys`, 'POST', undefined, 201);
    return { id: user.id, token: key.token };
  }
  const observer = await identity('Joint Observer'), manager = await identity('Joint Connector manager');
  const legacy = await identity('Joint legacy migration');
  const environments = codex => ({ codex, openclaw: 'disabled' });
  async function nodeVersion(actor = administrator) {
    const directory = await api(actor, '/api/hub/v1/access/directory');
    const connection = directory.connections.find(item => item.ownerUserId === 'default' && item.id === 'isolated-codex');
    assert.ok(connection?.verified, 'Role acceptance requires the current verified Connector authority');
    return connection.nodeVersion;
  }
  async function change(actor, user, role, modes, extra = {}) {
    const previous = await api(actor, memberPath(user.id));
    const input = { role, version: previous.version, nodeVersion: await nodeVersion(actor),
      environments: modes, migrateLegacy: true, grantSetDigest: previous.grantSetDigest, ...extra };
    return { previous, input, next: await api(actor, memberPath(user.id), 'PUT', input) };
  }
  const forbiddenSend = async actor => {
    await api(actor, session.path + '/messages', 'POST', { message: 'Must not execute', idempotencyKey: randomUUID() }, 403);
    await api(actor, creationPath, 'POST', { label: 'Must not create', idempotencyKey: randomUUID() }, 403);
  };
  const observe = await change(administrator, observer, 'observer', environments('observer'));
  assert.equal(observe.next.role, 'observer');
  await api(observer, session.path + '/messages', 'GET', undefined, 404);
  const share = await api(alice, session.path + '/collaborators', 'POST',
    { userId: observer.id, role: 'observer', live: true, media: true }, 201);
  const read = await api(observer, session.path + '/messages');
  assert.equal(read.access.messagesSend, false); assert.equal(read.access.eventsRead, true);
  await forbiddenSend(observer);
  await api(observer, memberPath(observer.id), 'GET', undefined, 403);
  await api(administrator, memberPath(observer.id), 'PUT', observe.input, 409);
  const invalidObserver = { ...observe.input, version: observe.next.version,
    grantSetDigest: observe.next.grantSetDigest, environments: environments('developer') };
  await api(administrator, memberPath(observer.id), 'PUT', invalidObserver, 409);

  phase = 'Connector manager';
  const management = await change(administrator, manager, 'admin', { codex: 'observer', openclaw: 'observer' });
  assert.equal(management.next.role, 'admin');
  const directory = await api(manager, '/api/hub/v1/access/directory');
  assert.equal(directory.administrator, false);
  assert.ok(directory.connections.every(connection => connection.appointAdministrators === false));
  assert.equal((await api(manager, session.path + '/messages')).access.messagesSend, false);
  await forbiddenSend(manager);
  await api(manager, memberPath(manager.id), 'PUT', { ...management.input,
    version: management.next.version, grantSetDigest: management.next.grantSetDigest }, 409);
  const currentObserver = await api(manager, memberPath(observer.id));
  await api(manager, memberPath(observer.id), 'PUT', { role: 'admin', version: currentObserver.version,
    nodeVersion: currentObserver.nodeVersion, grantSetDigest: currentObserver.grantSetDigest,
    environments: { codex: 'observer', openclaw: 'observer' }, migrateLegacy: true }, 409);
  await api(manager, `/api/hub/v1/access/users/${observer.id}/hub-role`, 'PUT', { role: 'admin', version: 0 }, 403);
  phase = 'bootstrap owner read';
  await api(administrator, creationPath, 'POST', { label: 'Inherited reads are not execution', idempotencyKey: randomUUID() }, 403);
  // The bootstrap administrator owns this connection: its inherited read uses
  // the owned route, not a received-share route requiring a recipient grant.
  await api(administrator, `/api/hub/v1/sessions/${encodeURIComponent(session.key)}/messages`);

  phase = 'legacy migration';
  const grantsPath = '/api/hub/v1/connections/isolated-codex/grants';
  const legacyBefore = await api(administrator, memberPath(legacy.id));
  assert.equal(legacyBefore.version, 0);
  const policy = { runtime: 'codex', actions: ['sessions:read', 'messages:read'] };
  const { grant } = await api(administrator, grantsPath, 'POST',
    { userId: legacy.id, nodeVersion: await nodeVersion(), policy }, 201);
  await api(legacy, session.path + '/messages');
  const reviewed = await api(administrator, memberPath(legacy.id));
  assert.ok(reviewed.legacyBroad > 0);
  const conversion = { role: 'none', version: reviewed.version, nodeVersion: await nodeVersion(),
    environments: environments('disabled'), migrateLegacy: false, grantSetDigest: reviewed.grantSetDigest };
  await api(administrator, memberPath(legacy.id), 'PUT', conversion, 409);
  await api(administrator, memberPath(legacy.id), 'PUT', { ...conversion, migrateLegacy: true,
    grantSetDigest: legacyBefore.grantSetDigest }, 409);
  const converted = await api(administrator, memberPath(legacy.id), 'PUT', { ...conversion, migrateLegacy: true });
  assert.equal(converted.role, 'none'); assert.equal(converted.version, 1);
  await api(legacy, session.path + '/messages', 'GET', undefined, 404);
  assert.equal((await api(legacy, '/api/hub/v1/shared/grants')).grants.length, 0);
  await api(administrator, grantsPath + '/' + grant.id, 'PUT', { version: grant.version,
    nodeVersion: converted.nodeVersion, policy }, 409);

  phase = 'downgrade';
  const none = await change(administrator, observer, 'none', environments('disabled'));
  assert.equal(none.next.role, 'none');
  await api(observer, session.path + '/messages', 'GET', undefined, 404);
  await api(observer, session.path + '/events/stream', 'GET', undefined, 404);
  // Raising a ceiling cannot resurrect the exact share revoked by a downgrade.
  await change(administrator, observer, 'observer', environments('observer'));
  await api(observer, session.path + '/messages', 'GET', undefined, 404);
  assert.ok(!(await api(observer, '/api/hub/v1/shared/grants')).grants.some(item => item.id === share.grant.id));
  return {
    async afterRestart() {
      for (const actor of [observer, legacy]) await api(actor, session.path + '/messages', 'GET', undefined, 404);
      assert.equal((await api(manager, session.path + '/messages')).access.messagesSend, false);
      await forbiddenSend(manager);
      assert.equal((await api(administrator, memberPath(legacy.id))).role, 'none');
    },
  };
}

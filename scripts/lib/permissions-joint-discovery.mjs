import assert from 'node:assert/strict';

// HTTP-only checks against the same disposable candidate and identities as the
// native acceptance. A received session is not an owned Connector credential.
export function assertExactJointDirectory(page, sessionId) {
  assert.ok(Array.isArray(page.sessions), 'Shared directory must contain sessions');
  assert.deepEqual(page.sessions.map(session => session.sessionId), [sessionId],
    'An exact grant cannot expose another session, title or child summary');
  assert.ok(!page.nextCursor, 'An exact session must not expose another page');
}

export function assertJointReceivedGrants(grants, sessions, connections) {
  const exact = grants.filter(grant => grant.sessionId !== null);
  assert.deepEqual(exact.map(grant => grant.sessionId).sort(), sessions.map(session => session.key).sort());
  const creation = grants.filter(grant => grant.sessionId === null);
  assert.deepEqual(creation.map(grant => grant.connectionId).sort(), [...connections].sort(),
    'Only the explicitly seeded per-node creation grants may lack a session link');
  for (const grant of creation) {
    assert.deepEqual(grant.policy, { runtime: 'codex', actions: ['sessions:create'] },
      'An environment creation grant must not acquire discovery or read authority');
    assert.equal(grant.availability, 'available');
    assert.equal(grant.ownerUserId, 'default');
  }
  for (const grant of exact) {
    assert.ok(grant.policy.sessionKey && !grant.policy.agentId, 'Readable grants remain exact-session scoped');
    assert.equal(grant.sessionId, grant.connectionId + ':' + Buffer.from(grant.policy.sessionKey).toString('base64url'));
  }
  return { exact, creation };
}

export async function verifyJointDiscovery({ api, administrator, alice, bob, first, second, secondNode }) {
  const sessions = [first, second, ...(secondNode ? [secondNode.session] : [])];
  for (const actor of [alice, bob]) {
    const me = await api(actor, '/api/hub/v1/me');
    assert.equal(me.userId, actor.id); assert.equal(me.admin, false);
    assert.deepEqual((await api(actor, '/api/hub/v1/users')).users.map(user => user.id), [actor.id]);
    assert.deepEqual((await api(actor, '/api/hub/v1/connections')).connections, []);
    const state = await api(actor, '/api/hub/v1/sessions/state?includeHidden=1&includeArchived=1');
    assert.deepEqual(state.groups, []); assert.deepEqual(state.connections, []);
    assert.deepEqual(state.sources, []); assert.deepEqual(state.sourceStates, []);
    const summary = await api(actor, '/api/hub/v1/completions/summary', 'POST', { sessions: sessions.map(session => session.key) });
    assert.deepEqual(summary.items, [], 'Received shares do not expose owned notification state');
    for (const session of sessions) {
      const base = '/api/hub/v1/sessions/' + encodeURIComponent(session.key);
      for (const suffix of ['/messages', '/token-usage', '/token-usage/export', '/token-usage/snapshots/original-request', '/skills', '/files']) {
        await api(actor, base + suffix, 'GET', undefined, 404);
      }
      await api(actor, '/api/hub/v1/completions/observe', 'POST', { sessionKey: session.key }, 404);
      await api(actor, '/api/sessions/' + encodeURIComponent(session.key) + '/pin', 'PATCH', { pinned: true }, 404);
    }
    const grants = (await api(actor, '/api/hub/v1/shared/grants')).grants;
    const allowed = actor.id === alice.id ? [first, ...(secondNode ? [secondNode.session] : [])] : [first, second];
    const { exact, creation } = assertJointReceivedGrants(grants, allowed,
      ['isolated-codex', ...(secondNode ? [secondNode.connectionId] : [])]);
    for (const grant of creation) {
      await api(actor, `/api/hub/v1/shared/default/connections/${grant.connectionId}/grants/${grant.id}/sessions`, 'GET', undefined, 404);
    }
    for (const grant of exact) {
      assert.equal(grant.ownerUserId, 'default');
      const path = `/api/hub/v1/shared/${grant.ownerUserId}/connections/${grant.connectionId}/grants/${grant.id}/sessions`;
      assertExactJointDirectory(await api(actor, path + '?limit=1'), grant.sessionId);
      // Caller query parameters must not broaden the grant's pinned resource.
      await api(actor, path + '?runtime=codex&limit=1', 'GET', undefined, 400);
      await api(actor.id === alice.id ? bob : alice, path, 'GET', undefined, 404);
    }
    const research = await api(actor, '/api/hub/v1/workspace/research/config');
    // Never call a configured external search provider as a side effect of an
    // isolation test. The default-disabled candidate must reject before I/O.
    assert.equal(research.enabled, false, 'Fixture must keep external research disabled');
    await api(actor, '/api/hub/v1/workspace/research/search', 'POST', { query: 'Joint Alice' }, 403);
    await api(actor, '/api/hub/v1/workspace/research/synthesize', 'POST',
      { consent: true, searchId: '00000000-0000-4000-8000-000000000001', sourceIds: ['S1'] }, 403);
  }
  // Positive controls: these routes exist and the original node owner can read
  // its catalog/history/notification state. An all-404 server cannot pass.
  const owned = await api(administrator, '/api/hub/v1/sessions/state?includeHidden=1&includeArchived=1');
  const listed = owned.groups.flatMap(group => group.sessions.map(session => session.sessionKey));
  for (const session of sessions) {
    assert.ok(listed.includes(session.key), 'Original owner catalog retains native session');
    await api(administrator, '/api/hub/v1/sessions/' + encodeURIComponent(session.key) + '/messages');
  }
  const notifications = await api(administrator, '/api/hub/v1/completions/summary', 'POST', { sessions: sessions.map(session => session.key) });
  // Only first has completed a turn at this checkpoint. Empty newly created
  // sessions must not acquire invented completion facts just to satisfy a test.
  assert.deepEqual(notifications.items.map(item => item.sessionKey), [first.key],
    'Original owner sees the completed native turn, not fabricated completions for empty sessions');
}

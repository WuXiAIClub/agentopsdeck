import assert from 'node:assert/strict';

// The integration runner supplies real process and HTTP operations. Keep this
// checkpoint before sharing and before the first send: neither collaboration
// nor an existing transcript may conceal lost creator authority on reopen.
export async function verifyJointEmptyRestart({ connector, hub, secondHost, sessions,
  creationPath, api, stop, start, requestCount }) {
  assert.equal(requestCount(), 0, 'Empty-session checkpoint must precede all model requests');
  const receipts = [];
  for (const { actor, session } of sessions) {
    const receipt = await api(actor, creationPath + '/creation-commands/' + session.creation.idempotencyKey);
    assert.equal(receipt.command?.state, 'accepted');
    receipts.push(receipt.command);
    assert.deepEqual((await api(actor, session.path + '/messages')).messages, []);
  }
  const hubPid = hub.child.pid, secondPid = secondHost?.child.pid;
  const oldPid = connector.child.pid, port = new URL(connector.origin).port;
  await stop(connector);
  const replacement = await start('connector', port);
  assert.notEqual(replacement.child.pid, oldPid, 'Restart must physically replace the Connector');
  assert.equal(replacement.origin, connector.origin, 'Keep the original pinned transport address');
  assert.equal(replacement.exit, undefined);
  assert.equal(hub.child.pid, hubPid); assert.equal(hub.exit, undefined);
  if (secondHost) {
    assert.equal(secondHost.child.pid, secondPid); assert.equal(secondHost.exit, undefined);
  }
  for (const [index, { actor, foreign, session }] of sessions.entries()) {
    assert.deepEqual((await api(actor, session.path + '/messages')).messages, []);
    const path = creationPath + '/creation-commands/' + session.creation.idempotencyKey;
    assert.deepEqual((await api(actor, path)).command, receipts[index], 'Keep the exact original creation receipt');
    // Retry only the original creation identity, never manufacture a replacement.
    assert.equal((await api(actor, creationPath, 'POST', session.creation, 201)).key, session.key);
    await api(foreign, session.path + '/messages', 'GET', undefined, 404);
    await api(foreign, path, 'GET', undefined, 404);
  }
  assert.equal(requestCount(), 0, 'Restart/read/creation retry must not manufacture a model turn');
  return replacement;
}

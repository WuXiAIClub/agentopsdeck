import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// Test-only reader. Never open production or a running Hub's database. Return
// only the exact disposable lease's identity/state, not proofs or credentials.
export async function stoppedJointLease({ root, hub, principalId, sessionKey, leaseId }) {
  assert.equal(hub?.exit?.code, 0, 'Hub must have stopped cleanly before ledger inspection');
  assert.equal(hub?.child?.exitCode, 0, 'Hub process must have physically exited');
  const directory = await realpath(root);
  assert.match(basename(directory), /^agentopsdeck-native-sdk-[a-zA-Z0-9]+$/);
  const file = join(directory, 'hub', 'hub.sqlite');
  assert.equal(await realpath(file), file, 'Disposable ledger must not be a symlink');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare(`SELECT id, version, node_id AS nodeId, issuer_id AS issuerId,
      expires_at AS expiresAt, state FROM hub_execution_leases
      WHERE principal_id = ? AND json_extract(proof, '$.resource.sessionKey') = ?
        AND (? IS NULL OR id = ?) ORDER BY id DESC LIMIT 1`)
      .get(principalId, sessionKey, leaseId ?? null, leaseId ?? null);
    assert.ok(row, 'Exact disposable execution lease must exist');
    return { ...row };
  } finally { db.close(); }
}

export function assertPinnedJointLease(original, current, state) {
  assert.deepEqual(current, { ...original, state }, 'Only the pinned original lease state may change');
}

export async function verifyJointIssuerRecovery({ api, administrator, actor, create, send, reply,
  relay, originalIssuer, replacementIssuer, nodeId, root, getHub, replaceHub, stop, start,
  connector, providerCount, until, check }) {
  const memberPath = `/api/hub/v1/access/default/connections/isolated-codex/members/${actor.id}`;
  const previous = await api(administrator, memberPath);
  const directory = await api(administrator, '/api/hub/v1/access/directory');
  const connection = directory.connections.find(item => item.ownerUserId === 'default' && item.id === 'isolated-codex');
  assert.ok(connection?.verified);
  await api(administrator, memberPath, 'PUT', { role: 'developer', version: previous.version,
    nodeVersion: connection.nodeVersion, grantSetDigest: previous.grantSetDigest, migrateLegacy: true,
    environments: { codex: 'developer', openclaw: 'disabled' } });
  const session = await create(actor, 'Joint durable issuer recovery');
  const count = providerCount() + 1;
  await send(actor, session); await reply(actor, session, `JOINT_REPLY_${count}`);
  const fault = relay.isolateIssuer(originalIssuer.token);
  const rotated = await api(administrator, '/api/hub/v1/connections/isolated-codex/execution-issuer',
    'PUT', { token: replacementIssuer.token });
  assert.equal(rotated.issuer.issuerId, replacementIssuer.record.id);
  assert.equal(rotated.issuer.nodeId, nodeId);
  await api(actor, session.path + '/messages', 'GET', undefined, 404);
  await until('original issuer transport actually unavailable', () => fault.attempts > 0);
  const port = new URL(getHub().origin).port;
  await stop(getHub());
  const sessionKey = Buffer.from(session.key.slice(session.key.indexOf(':') + 1), 'base64url').toString('utf8');
  const selection = { root, principalId: actor.id, sessionKey };
  const original = await stoppedJointLease({ ...selection, hub: getHub() });
  assert.equal(original.issuerId, originalIssuer.record.id); assert.equal(original.nodeId, nodeId);
  assert.equal(original.state, 'revoking');
  const wait = original.expiresAt - Date.now() + 100;
  assert.ok(wait <= 61_000, 'Lease expiry wait must stay bounded');
  // Real wall-clock expiry, not a fabricated lease or test clock mutation.
  if (wait > 0) await delay(wait);
  const attempts = fault.attempts;
  replaceHub(await start('hub', port));
  await until('reopened Hub retries the unavailable original issuer', () => fault.attempts > attempts);
  await stop(getHub());
  const expired = await stoppedJointLease({ ...selection, hub: getHub(), leaseId: original.id });
  assert.ok(Date.now() > original.expiresAt);
  assertPinnedJointLease(original, expired, 'revoking');
  assert.equal(fault.acknowledgments, 0, 'Neither rotation nor expiry can invent an original issuer ACK');
  check('Original issuer transport outage survives actual lease expiry and physical Hub reopen; exact pinned ledger remains revoking');
  fault.restore(); replaceHub(await start('hub', port));
  await until('actual original issuer revocation response', () => fault.acknowledgments > 0, 60_000);
  // The HTTP response is not itself proof of a committed Hub ledger update.
  await stop(getHub());
  const settled = await stoppedJointLease({ ...selection, hub: getHub(), leaseId: original.id });
  assertPinnedJointLease(original, settled, 'revoked');
  assert.equal(connector.exit, undefined, 'Connector was not replaced by this recovery');
  assert.equal(providerCount(), count, 'Recovery must not replay any native model command');
  replaceHub(await start('hub', port));
  await api(actor, session.path + '/messages', 'GET', undefined, 404);
  check('Only actual retained original issuer ACK commits the exact durable revoked lease after rotation; no command replay or grant resurrection');
  return { outageObserved: true, expiredWhileRevoking: true, persistedAcrossPhysicalReopen: true,
    originalIssuerAcknowledged: true, finalState: settled.state, noReplay: true };
}

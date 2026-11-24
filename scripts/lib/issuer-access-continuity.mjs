import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = (db, sql, ...parameters) => db.prepare(sql).all(...parameters).map(row => ({ ...row }));
const equal = (actual, expected) => assert.deepEqual(actual, expected, 'Reviewed issuer access changed');

/** Offline operator primitive, NOT an HTTP permission shortcut. The caller must
 * prove physical stop/exclusive ownership and back up current state. Its review
 * comes from BEFORE the normal, identity-verified issuer rotation. No token is
 * read here and no old lease, command, receipt or grant version is revived.
 */
export function reviewIssuerAccess(db, { ownerId, connectionId, fromVersion, memberIds }) {
  assert.ok(typeof ownerId === 'string' && ownerId.length && typeof connectionId === 'string' && connectionId.length);
  assert.ok(Number.isSafeInteger(fromVersion) && fromVersion > 0);
  assert.ok(Array.isArray(memberIds) && memberIds.length > 0 && memberIds.length <= 100);
  assert.equal(new Set(memberIds).size, memberIds.length);
  assert.ok(memberIds.every(id => typeof id === 'string' && id.length > 0 && id !== ownerId));
  const issuer = rows(db, `SELECT owner_id, connection_id, node_id, issuer_id, authority_version,
    connector_url, kind, creation_allowed FROM hub_execution_issuers
    WHERE owner_id=? AND connection_id=? AND authority_version=?`, ownerId, connectionId, fromVersion);
  assert.equal(issuer.length, 1);
  assert.equal(issuer[0].kind, 'local', 'Only reviewed local credential repair is supported');
  assert.equal(issuer[0].creation_allowed, 1);
  const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const accessTable = hasTable('hub_user_access');
  const members = [...memberIds].sort().map(id => {
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').get(id));
    const access = accessTable ? db.prepare('SELECT status,version FROM hub_user_access WHERE user_id=?').get(id) : undefined;
    assert.ok(!access || access.status === 'enabled', 'Disabled accounts cannot be reauthorized');
    const found = rows(db, `SELECT * FROM connector_memberships WHERE node_owner=? AND connection_id=? AND user_id=?`,
      ownerId, connectionId, id);
    assert.equal(found.length, 1);
    assert.equal(found[0].node_version, fromVersion);
    assert.ok(['admin', 'developer', 'observer'].includes(found[0].role));
    return { ...found[0], accountVersion: access?.version ?? 0 };
  });
  const grants = rows(db, `SELECT * FROM node_grants WHERE node_owner=? AND connection_id=?
    AND node_version=? AND revoked=0 ORDER BY id`, ownerId, connectionId, fromVersion)
    .filter(row => memberIds.includes(row.user_id));
  assert.ok(grants.length > 0 && grants.length <= 1000);
  const ids = new Set(grants.map(row => row.id));
  const dependencies = rows(db, 'SELECT * FROM node_grant_dependencies ORDER BY child_id,parent_id')
    .filter(row => ids.has(row.child_id));
  for (const dependency of dependencies) {
    const parent = grants.find(row => row.id === dependency.parent_id);
    assert.ok(parent && parent.version === dependency.parent_version, 'Missing or stale grant parent');
  }
  // Fail closed on cycles rather than lending authority to an invalid lineage.
  for (const id of ids) {
    const seen = new Set(); let frontier = [id];
    while (frontier.length) {
      const current = frontier.pop();
      assert.ok(current !== id || seen.size === 0, 'Cyclic grant lineage');
      if (seen.has(current)) continue;
      seen.add(current);
      frontier.push(...dependencies.filter(row => row.child_id === current).map(row => row.parent_id));
    }
  }
  const owners = rows(db, `SELECT * FROM hub_session_owners WHERE node_owner=? AND connection_id=?
    AND node_version=? ORDER BY session_key`, ownerId, connectionId, fromVersion).filter(row => ids.has(row.grant_id));
  const roleGrants = rows(db, 'SELECT * FROM role_grants ORDER BY grant_id').filter(row => ids.has(row.grant_id));
  const fileBindingQuery = table => hasTable(table)
    ? rows(db, `SELECT binding_id, user_id, resource_id, session_id, connection_id, authority, state, created_at
      FROM ${table} WHERE user_id=? AND connection_id=? AND authority=? AND state!='revoked' ORDER BY binding_id`,
      ownerId, connectionId, fromVersion)
    : [];
  const boardFileBindings = fileBindingQuery('hub_workspace_board_file_bindings');
  const cardFileBindings = fileBindingQuery('hub_workspace_card_file_bindings');
  const data = {
    format: 1, issuer: issuer[0], members, grants, dependencies, owners, roleGrants,
    ...(boardFileBindings.length ? { boardFileBindings } : {}),
    ...(cardFileBindings.length ? { cardFileBindings } : {}),
  };
  return { ...data, sha256: digest(data) };
}

export function continueIssuerAccess(db, review, { stopped, expectedDigest, toVersion, issuerId }) {
  assert.equal(stopped, true, 'An independent stopped/exclusive-writer gate is mandatory');
  const { sha256, ...data } = review;
  assert.equal(sha256, digest(data)); assert.equal(sha256, expectedDigest);
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(toVersion) && toVersion === review.issuer.authority_version + 2,
    'Only the reviewed disable followed by verified local setup is supported');
  assert.ok(typeof issuerId === 'string' && issuerId.length && issuerId !== review.issuer.issuer_id);
  const source = review.issuer, parameters = { ownerId: source.owner_id, connectionId: source.connection_id,
    fromVersion: source.authority_version, memberIds: review.members.map(row => row.user_id) };
  const stripOwnerBindings = value => {
    const { sha256: _sha, boardFileBindings: _b, cardFileBindings: _c, ...core } = value;
    return core;
  };
  const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const reconcileOwnerFileBindings = (table, expectedBindings) => {
    if (!hasTable(table)) {
      equal([], expectedBindings);
      return;
    }
    const actual = rows(db, `SELECT binding_id, user_id, resource_id, session_id, connection_id, authority, state, created_at
      FROM ${table} WHERE user_id=? AND connection_id=? AND authority IN (?, ?) AND state!='revoked' ORDER BY binding_id`,
      parameters.ownerId, parameters.connectionId, parameters.fromVersion, toVersion);
    equal(actual.map(({ authority: _a, ...rest }) => rest), expectedBindings.map(({ authority: _a, ...rest }) => rest));
    for (let i = 0; i < expectedBindings.length; i++) {
      const binding = expectedBindings[i], current = actual[i];
      assert.ok(current.authority === parameters.fromVersion || current.authority === toVersion, 'Reviewed issuer access changed');
      if (current.authority === parameters.fromVersion) {
        assert.equal(db.prepare(`UPDATE ${table} SET authority=? WHERE binding_id=?
          AND user_id=? AND connection_id=? AND authority=? AND state=? AND state!='revoked'`)
          .run(toVersion, binding.binding_id, parameters.ownerId, parameters.connectionId, parameters.fromVersion, binding.state).changes, 1);
      }
    }
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    equal(stripOwnerBindings(reviewIssuerAccess(db, parameters)), stripOwnerBindings(review));
    const node = db.prepare(`SELECT node_id,authority_version,connector_url,kind,status,deleted_at FROM env_connections
      WHERE owner_user_id=? AND id=?`).get(parameters.ownerId, parameters.connectionId);
    assert.ok(node && !node.deleted_at && node.status !== 'disabled');
    equal([node.node_id, node.authority_version, node.connector_url, node.kind],
      [source.node_id, toVersion, source.connector_url, source.kind]);
    const previous = db.prepare(`SELECT retired FROM hub_execution_issuers WHERE owner_id=? AND connection_id=? AND authority_version=?`)
      .get(parameters.ownerId, parameters.connectionId, parameters.fromVersion);
    assert.equal(previous?.retired, 1);
    const fresh = db.prepare(`SELECT * FROM hub_execution_issuers WHERE owner_id=? AND connection_id=? AND authority_version=?`)
      .get(parameters.ownerId, parameters.connectionId, toVersion);
    assert.ok(fresh && fresh.issuer_id === issuerId && fresh.retired === 0 && fresh.creation_allowed === 1);
    equal([fresh.node_id, fresh.connector_url, fresh.kind], [source.node_id, source.connector_url, source.kind]);
    for (const member of review.members) {
      assert.equal(db.prepare(`UPDATE connector_memberships SET node_version=? WHERE node_owner=? AND connection_id=?
        AND user_id=? AND node_version=? AND version=?`).run(toVersion, parameters.ownerId, parameters.connectionId,
        member.user_id, parameters.fromVersion, member.version).changes, 1);
    }
    for (const grant of review.grants) {
      assert.equal(db.prepare(`UPDATE node_grants SET node_version=? WHERE id=? AND node_version=? AND version=? AND revoked=0`)
        .run(toVersion, grant.id, parameters.fromVersion, grant.version).changes, 1);
    }
    for (const owner of review.owners) {
      assert.equal(db.prepare(`UPDATE hub_session_owners SET node_version=? WHERE node_owner=? AND connection_id=?
        AND node_version=? AND session_key=? AND grant_id=?`).run(toVersion, parameters.ownerId, parameters.connectionId,
        parameters.fromVersion, owner.session_key, owner.grant_id).changes, 1);
    }
    reconcileOwnerFileBindings('hub_workspace_board_file_bindings', review.boardFileBindings ?? []);
    reconcileOwnerFileBindings('hub_workspace_card_file_bindings', review.cardFileBindings ?? []);
    db.exec(`CREATE TABLE IF NOT EXISTS operator_issuer_access_continuity (
      review_sha256 TEXT PRIMARY KEY, owner_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, issuer_id TEXT NOT NULL)`);
    db.prepare('INSERT INTO operator_issuer_access_continuity VALUES (?,?,?,?,?,?)')
      .run(sha256, parameters.ownerId, parameters.connectionId, parameters.fromVersion, toVersion, issuerId);
    db.exec('COMMIT');
    return { passed: true, reviewSha256: sha256, memberships: review.members.length, grants: review.grants.length,
      creatorOwnerships: review.owners.length, dependencies: review.dependencies.length,
      boardFileBindings: (review.boardFileBindings ?? []).length, cardFileBindings: (review.cardFileBindings ?? []).length,
      fromVersion: parameters.fromVersion, toVersion, leaseRestorations: 0, queueReplays: 0 };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

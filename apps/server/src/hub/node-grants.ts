import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { observedParticipant } from '../storage/observed-participant.js';
import { initializeHubUserAccess, hubUserEnabled } from './user-access.js';
import { NODE_ACTIONS, isOwnerOnlyRuntimeResource, type NodeAction, type NodeResource, type NodeGrantPolicy } from '@agentopsdeck/shared';
export { NODE_ACTIONS, type NodeAction, type NodeResource, type NodeGrantPolicy } from '@agentopsdeck/shared';

export type NodeGrantTarget = { ownerUserId: string; connectionId: string; userId: string; administrator?: boolean };
export type NodeGrantRecord = { id: string; userId: string; version: number; nodeVersion: number; revoked: boolean; policy: NodeGrantPolicy; derived?: boolean };
export type NodeGrantProof = Readonly<NodeGrantTarget & {
  grantId: string; version: number; nodeVersion: number; action: NodeAction; resource: Readonly<NodeResource>;
}>;
export type SessionShareOptions = { live?: boolean; queue?: boolean; media?: boolean };
export type SessionRevocationStatus = { state: 'pending' | 'confirmed'; pending: number; confirmed: number };
type Row = {
  id: string; node_owner: string; connection_id: string; user_id: string; node_version: number; version: number;
  runtime: NodeResource['runtime'] | null; agent_id: string | null; session_key: string | null; actions: string; revoked: number;
};

/** A definite zero-row authority/capacity refusal, never a SQL/COMMIT fault. */
export class NodeGrantConflict extends Error {
  constructor() { super('Node unavailable or grant capacity reached'); this.name = 'NodeGrantConflict'; }
}

/** Pure policy refusal before sharing effects; SQL/callback failures stay unknown. */
export class SessionSharePolicyConflict extends Error {}
/** Emitted only AFTER the original sharing savepoint has successfully settled. */
export class SessionShareConflict extends Error {}

/** Hub policy only. No Connector credentials or second human account database.
 * Shared routes must resolve an exact resource and revalidate a captured proof.
 */
export class NodeGrants {
  ceiling: ((target: NodeGrantTarget, action: NodeAction, resource: NodeResource, grantId?: string) => boolean) | undefined;
  canShareWith: ((sender: NodeGrantTarget, recipient: NodeGrantTarget) => boolean) | undefined;
  constructor(private readonly db: DatabaseSync, private readonly maxRows = 10_000) {
    initializeHubUserAccess(db);
    db.exec(`CREATE TABLE IF NOT EXISTS node_grants (
      id TEXT PRIMARY KEY, node_owner TEXT NOT NULL, connection_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      node_version INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      runtime TEXT CHECK(runtime IN ('codex', 'openclaw')), agent_id TEXT, session_key TEXT,
      actions TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1)),
      FOREIGN KEY(connection_id, node_owner) REFERENCES env_connections(id, owner_user_id)
    );
    CREATE INDEX IF NOT EXISTS node_grant_actor ON node_grants(node_owner, connection_id, user_id);
    CREATE INDEX IF NOT EXISTS node_grant_directory ON node_grants(node_owner, connection_id, id);
    CREATE INDEX IF NOT EXISTS node_grant_recipient ON node_grants(user_id, id) WHERE revoked = 0;
    CREATE TABLE IF NOT EXISTS node_grant_usage (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL);
    INSERT OR IGNORE INTO node_grant_usage SELECT 1, count(*) FROM node_grants;
    CREATE TRIGGER IF NOT EXISTS node_grant_insert AFTER INSERT ON node_grants BEGIN
      UPDATE node_grant_usage SET rows = rows + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS node_grant_delete AFTER DELETE ON node_grants BEGIN
      UPDATE node_grant_usage SET rows = rows - 1 WHERE singleton = 1;
    END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS hub_disabled_user_grant_insert BEFORE INSERT ON node_grants
      WHEN NEW.revoked = 0 AND EXISTS(SELECT 1 FROM hub_user_access WHERE user_id = NEW.user_id AND status = 'disabled')
      BEGIN SELECT RAISE(ABORT, 'User disabled'); END;
      CREATE TRIGGER IF NOT EXISTS hub_disabled_user_grant_update BEFORE UPDATE ON node_grants
      WHEN NEW.revoked = 0 AND EXISTS(SELECT 1 FROM hub_user_access WHERE user_id = NEW.user_id AND status = 'disabled')
      BEGIN SELECT RAISE(ABORT, 'User disabled'); END;`);
    db.exec(`CREATE TABLE IF NOT EXISTS node_grant_dependencies (
      child_id TEXT PRIMARY KEY REFERENCES node_grants(id), parent_id TEXT NOT NULL REFERENCES node_grants(id),
      parent_version INTEGER NOT NULL, CHECK(child_id != parent_id)
    );
    CREATE INDEX IF NOT EXISTS node_grant_parent ON node_grant_dependencies(parent_id);
    CREATE TABLE IF NOT EXISTS hub_session_owners (
      node_owner TEXT NOT NULL, connection_id TEXT NOT NULL, node_version INTEGER NOT NULL,
      session_key TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), grant_id TEXT NOT NULL REFERENCES node_grants(id),
      command_scope TEXT NOT NULL, command_key TEXT NOT NULL,
      PRIMARY KEY(node_owner, connection_id, node_version, session_key), UNIQUE(command_scope, command_key)
    );
    CREATE TRIGGER IF NOT EXISTS node_grant_dependents_changed AFTER UPDATE ON node_grants
      WHEN NEW.version != OLD.version OR NEW.revoked != OLD.revoked BEGIN
      UPDATE node_grants SET revoked = 1, version = version + 1 WHERE revoked = 0 AND id IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT child_id FROM node_grant_dependencies WHERE parent_id = OLD.id
          UNION SELECT dependency.child_id FROM node_grant_dependencies dependency JOIN descendants ON dependency.parent_id = descendants.id
        ) SELECT id FROM descendants
      );
    END;`);
  }

  list(target: Pick<NodeGrantTarget, 'ownerUserId' | 'connectionId'>, after = '', limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (after !== '' && !/^[0-9a-f-]{36}$/.test(after))) {
      throw new Error('Invalid grant page');
    }
    const rows = this.db.prepare(`SELECT * FROM node_grants WHERE node_owner = ? AND connection_id = ? AND id > ?
      ORDER BY id LIMIT ?`).all(target.ownerUserId, target.connectionId, after, limit + 1) as Row[];
    return { grants: rows.slice(0, limit).map(row => this.record(row)), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  }

  /** Recipient's own policy directory, not another owner's resource catalog.
   * Never includes credentials/URLs/labels or crosses into Connector I/O. Broad
   * and outdated grants stay visible but carry no implied resource authority. */
  received(userId: string, after = '', limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (after !== '' && !/^[0-9a-f-]{36}$/.test(after))) {
      throw new Error('Invalid grant page');
    }
    const rows = this.db.prepare(`SELECT g.*, c.authority_version AS current_version, c.status AS node_status, c.node_id
      FROM node_grants g JOIN env_connections c ON c.id = g.connection_id AND c.owner_user_id = g.node_owner
      WHERE g.user_id = ? AND g.revoked = 0 AND g.id > ? AND c.deleted_at IS NULL
      ORDER BY g.id LIMIT ?`).all(userId, after, limit + 1) as Array<Row & { current_version: number; node_status: string; node_id: string | null }>;
    return { grants: rows.slice(0, limit).map(row => ({ ...this.record(row), ownerUserId: row.node_owner, connectionId: row.connection_id,
      currentNodeVersion: row.current_version, nodeStatus: row.node_status, nodeId: row.node_id })),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  }

  get(target: Pick<NodeGrantTarget, 'ownerUserId' | 'connectionId'>, id: string) {
    const row = this.db.prepare('SELECT * FROM node_grants WHERE node_owner = ? AND connection_id = ? AND id = ?')
      .get(target.ownerUserId, target.connectionId, id) as Row | undefined;
    return row && this.record(row);
  }

  private record(row: Row): NodeGrantRecord {
    const derived = !!this.db.prepare('SELECT 1 FROM node_grant_dependencies WHERE child_id = ?').get(row.id);
    return { ...record(row), ...(derived ? { derived: true } : {}) };
  }

  acceptCreatedSession(proof: NodeGrantProof, sessionKey: string, scope: string, commandKey: string, settle: () => void) {
    if (proof.action !== 'sessions:create' || proof.resource.runtime !== 'codex' || proof.resource.sessionKey
      || proof.resource.agentId || !sessionKey.startsWith('codex:') || !validResource({ runtime: 'codex', sessionKey })) {
      throw new Error('Invalid created session authority');
    }
    observedSavepoint(this.db, 'session-creation-ownership', checkParticipant => {
      if (!this.revalidate(proof)) throw new Error('Creation authority changed');
      const existing = this.db.prepare('SELECT * FROM hub_session_owners WHERE command_scope = ? AND command_key = ?')
        .get(scope, commandKey) as { node_owner: string; connection_id: string; node_version: number; session_key: string; user_id: string } | undefined;
      if (existing) {
        if (existing.node_owner !== proof.ownerUserId || existing.connection_id !== proof.connectionId || existing.node_version !== proof.nodeVersion
          || existing.session_key !== sessionKey || existing.user_id !== proof.userId) throw new Error('Creation ownership conflict');
      } else {
        const grant = this.derive(proof, proof.userId, { runtime: 'codex', sessionKey,
          actions: ['sessions:read', 'messages:read', 'messages:send', 'events:read', 'media:read', 'queue:manage', 'sessions:share'] });
        this.db.prepare('INSERT INTO hub_session_owners VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(proof.ownerUserId, proof.connectionId, proof.nodeVersion, sessionKey, proof.userId, grant.id, scope, commandKey);
      }
      checkParticipant(settle());
    });
  }

  private derive(proof: NodeGrantProof, userId: string, policy: NodeGrantPolicy) {
    const grant = this.create({ ...proof, userId }, policy);
    this.db.prepare('INSERT INTO node_grant_dependencies VALUES (?, ?, ?)').run(grant.id, proof.grantId, proof.version);
    return grant;
  }

  ownedSession(proof: NodeGrantProof) {
    if (proof.action !== 'sessions:share' || !this.revalidate(proof)) return false;
    return !!this.db.prepare(`SELECT 1 FROM hub_session_owners WHERE node_owner = ? AND connection_id = ?
      AND node_version = ? AND session_key = ? AND user_id = ? AND grant_id = ?`)
      .get(proof.ownerUserId, proof.connectionId, proof.nodeVersion, proof.resource.sessionKey ?? '', proof.userId, proof.grantId);
  }

  collaborators(proof: NodeGrantProof) {
    if (!this.ownedSession(proof)) throw new Error('Session owner authority required');
    return (this.db.prepare(`SELECT grant_row.* FROM node_grants grant_row JOIN node_grant_dependencies dependency
      ON dependency.child_id = grant_row.id WHERE dependency.parent_id = ? AND grant_row.revoked = 0 ORDER BY grant_row.id LIMIT 101`)
      .all(proof.grantId) as Row[]).map(row => this.record(row));
  }

  private sharePolicy(proof: NodeGrantProof, userId: string, role: 'observer' | 'collaborator', options: SessionShareOptions) {
    if (this.canShareWith && observedParticipant(this.db, 'node-authority-check', () => this.canShareWith!(proof, { ...proof, userId })) !== true) throw new SessionSharePolicyConflict('Recipient needs a Connector membership');
    const policy = this.sessionPolicy({ ...proof, userId }, proof.resource, role, options);
    const parent = this.get(proof, proof.grantId);
    if (!parent || policy.actions.some(action => !parent.policy.actions.includes(action))) throw new SessionSharePolicyConflict('Cannot delegate permissions absent from creator grant');
    return policy;
  }

  sessionGrants(target: Pick<NodeGrantTarget, 'ownerUserId' | 'connectionId'>, resource: NodeResource) {
    return (this.db.prepare(`SELECT grant_row.* FROM node_grants grant_row WHERE node_owner = ? AND connection_id = ?
      AND runtime = ? AND session_key = ? AND agent_id IS NULL AND revoked = 0
      AND NOT EXISTS (SELECT 1 FROM node_grant_dependencies WHERE child_id = grant_row.id)
      ORDER BY id LIMIT 101`).all(target.ownerUserId, target.connectionId, resource.runtime!, resource.sessionKey!) as Row[]).map(row => this.record(row));
  }

  sessionPolicy(target: NodeGrantTarget, resource: NodeResource, role: 'observer' | 'collaborator', options: SessionShareOptions) {
    if (!['observer', 'collaborator'].includes(role) || resource.runtime !== 'codex' || !resource.sessionKey) throw new SessionSharePolicyConflict('Invalid session scope');
    const actions: NodeAction[] = ['sessions:read', 'messages:read'];
    if (options.live !== false) actions.push('events:read');
    if (options.media === true) actions.push('media:read');
    if (role === 'collaborator') {
      actions.push('messages:send');
      if (options.queue !== false) actions.push('queue:manage');
    } else if (options.queue === true) throw new SessionSharePolicyConflict('Observers cannot manage queues');
    if (actions.some(action => this.ceiling && observedParticipant(this.db, 'node-authority-check', () => this.ceiling!(target, action, resource)) !== true)) throw new SessionSharePolicyConflict('Recipient environment role does not permit this access');
    return { runtime: 'codex' as const, sessionKey: resource.sessionKey, actions };
  }

  /** Original connection owns policy, CAS, write and readback as one boundary. */
  saveSessionAccess(target: NodeGrantTarget, resource: NodeResource, role: 'observer' | 'collaborator', options: SessionShareOptions,
    nodeVersion: number, previous?: { id: string; version: number }) {
    const settled = observedSavepoint(this.db, 'session-share-change', () => {
      if (!this.db.prepare("SELECT 1 FROM env_connections WHERE owner_user_id = ? AND id = ? AND authority_version = ? AND deleted_at IS NULL AND status != 'disabled'")
        .get(target.ownerUserId, target.connectionId, nodeVersion)) return { conflict: true as const };
      let policy;
      try { policy = this.sessionPolicy(target, resource, role, options); }
      catch (error) { if (error instanceof SessionSharePolicyConflict) return { conflict: true as const }; throw error; }
      let id;
      if (previous) {
        if (!this.replace(target, previous.id, previous.version, policy)) return { conflict: true as const };
        id = previous.id;
      } else {
        const rows = this.sessionGrants(target, resource).filter(grant => grant.nodeVersion === nodeVersion);
        if (rows.some(grant => grant.userId === target.userId) || rows.length >= 100) return { conflict: true as const };
        try { id = this.create(target, policy).id; }
        catch (error) { if (error instanceof NodeGrantConflict) return { conflict: true as const }; throw error; }
      }
      const grant = this.get(target, id);
      if (!grant) throw new Error('Session access readback unavailable');
      return { grant };
    });
    // A refusal is definite only after successful savepoint settlement.
    if ('conflict' in settled) throw new SessionShareConflict('Access changed or disallowed');
    return settled.grant;
  }

  updateCollaborator(proof: NodeGrantProof, id: string, version: number, role: 'observer' | 'collaborator', options: SessionShareOptions) {
    const outcome = observedSavepoint(this.db, 'session-share-change', () => {
      if (!this.ownedSession(proof) || !['observer', 'collaborator'].includes(role)) return { error: 'Session creator required' };
      const previous = this.collaborators(proof).find(grant => grant.id === id);
      if (!previous || previous.version !== version) return { error: 'Session access changed' };
      let policy;
      try { policy = this.sharePolicy(proof, previous.userId, role, options); }
      catch (error) { if (error instanceof SessionSharePolicyConflict) return { error: error.message }; throw error; }
      if (!this.db.prepare('UPDATE node_grants SET actions = ?, version = version + 1 WHERE id = ? AND version = ? AND revoked = 0')
        .run(JSON.stringify(policy.actions), id, version).changes) return { error: 'Session access changed' };
      const grant = this.get(proof, id);
      if (!grant) throw new Error('Session access readback unavailable');
      return { grant };
    });
    if ('error' in outcome) throw new SessionShareConflict(outcome.error);
    return outcome.grant;
  }

  shareSession(proof: NodeGrantProof, userId: string, role: 'observer' | 'collaborator', options: SessionShareOptions = {}) {
    const outcome = observedSavepoint(this.db, 'session-share-change', () => {
      if (!this.ownedSession(proof) || userId === proof.userId || !['observer', 'collaborator'].includes(role)) return { error: 'Invalid session share' };
      const existing = this.collaborators(proof).filter(grant => !grant.revoked);
      if (existing.length >= 100 || existing.some(grant => grant.userId === userId)) return { error: 'Revoke existing access before changing role' };
      let policy;
      try { policy = this.sharePolicy(proof, userId, role, options); }
      catch (error) { if (error instanceof SessionSharePolicyConflict) return { error: error.message }; throw error; }
      let created;
      try { created = this.derive(proof, userId, policy); }
      catch (error) { if (error instanceof NodeGrantConflict) return { error: error.message }; throw error; }
      const grant = this.get(proof, created.id);
      if (!grant) throw new Error('Session access readback unavailable');
      return { grant };
    });
    if ('error' in outcome) throw new SessionShareConflict(outcome.error);
    return outcome.grant;
  }

  revokeCollaborator(proof: NodeGrantProof, id: string, version: number) {
    if (!this.ownedSession(proof)) throw new Error('Session owner authority required');
    const grant = this.collaborators(proof).find(item => item.id === id);
    return !!grant && this.revoke({ ...proof, userId: grant.userId }, id, version);
  }

  /** Exact original-owner tombstone and ledger read, NOT a synthetic remote ACK. */
  collaboratorRevocation(proof: NodeGrantProof, id: string, version: number): SessionRevocationStatus | null {
    if (!this.ownedSession(proof)) throw new Error('Session owner authority required');
    const tombstone = this.db.prepare(`SELECT 1 FROM node_grants g JOIN node_grant_dependencies d ON d.child_id=g.id
      WHERE g.id=? AND d.parent_id=? AND g.node_owner=? AND g.connection_id=? AND g.node_version=?
        AND g.runtime='codex' AND g.session_key=? AND g.revoked=1 AND g.version=?`)
      .get(id, proof.grantId, proof.ownerUserId, proof.connectionId, proof.nodeVersion, proof.resource.sessionKey!, version + 1);
    if (!tombstone) return null;
    const row = this.db.prepare(`SELECT count(*) AS total,
      coalesce(sum(CASE WHEN state='revoked' THEN 1 ELSE 0 END),0) AS confirmed
      FROM hub_execution_leases WHERE grant_id=? AND owner_id=? AND connection_id=?`)
      .get(id, proof.ownerUserId, proof.connectionId) as { total: number; confirmed: number };
    const pending = row.total - row.confirmed;
    return { state: pending ? 'pending' : 'confirmed', pending, confirmed: row.confirmed };
  }

  create(target: NodeGrantTarget, policy: NodeGrantPolicy) {
    if (!hubUserEnabled(this.db, target.userId)) throw new NodeGrantConflict();
    const fields = validatePolicy(policy);
    const id = randomUUID();
    // Capacity and node authority are tested within the insert statement, not
    // a stale preflight count. Revoked grants remain tombstones, never reused.
    const inserted = this.db.prepare(`INSERT INTO node_grants
      (id, node_owner, connection_id, user_id, node_version, runtime, agent_id, session_key, actions)
      SELECT ?, owner_user_id, id, ?, authority_version, ?, ?, ?, ? FROM env_connections
      WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL AND status != 'disabled'
        AND (SELECT rows FROM node_grant_usage WHERE singleton = 1) < ?`)
      .run(id, target.userId, ...fields, target.ownerUserId, target.connectionId, this.maxRows);
    if (!inserted.changes) throw new NodeGrantConflict();
    return { id, version: 1 };
  }

  replace(target: NodeGrantTarget, id: string, expectedVersion: number, policy: NodeGrantPolicy) {
    if (!hubUserEnabled(this.db, target.userId)) return false;
    const fields = validatePolicy(policy);
    if (this.db.prepare('SELECT 1 FROM node_grant_dependencies WHERE child_id = ?').get(id)) return false;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('Invalid grant version');
    // Re-authorizing after a node/credential change is explicit. Immutable
    // owner/node/actor bindings cannot be retargeted via a supplied grant ID.
    return this.db.prepare(`UPDATE node_grants SET runtime = ?, agent_id = ?, session_key = ?, actions = ?,
      version = version + 1, node_version = (SELECT authority_version FROM env_connections WHERE id = ? AND owner_user_id = ?)
      WHERE id = ? AND node_owner = ? AND connection_id = ? AND user_id = ? AND version = ? AND revoked = 0
      AND EXISTS(SELECT 1 FROM env_connections WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL AND status != 'disabled')`)
      .run(...fields, target.connectionId, target.ownerUserId, id, target.ownerUserId, target.connectionId, target.userId,
        expectedVersion, target.connectionId, target.ownerUserId).changes > 0;
  }

  revoke(target: NodeGrantTarget, id: string, expectedVersion: number) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('Invalid grant version');
    return this.db.prepare(`UPDATE node_grants SET revoked = 1, version = version + 1
      WHERE id = ? AND node_owner = ? AND connection_id = ? AND user_id = ? AND version = ? AND revoked = 0`)
      .run(id, target.ownerUserId, target.connectionId, target.userId, expectedVersion).changes > 0;
  }

  authorize(target: NodeGrantTarget, action: NodeAction, resource: NodeResource, grantId?: string): NodeGrantProof | undefined {
    if (!hubUserEnabled(this.db, target.userId)) return undefined;
    if (!NODE_ACTIONS.includes(action) || !validResource(resource)) return undefined;
    const rows = this.db.prepare(`SELECT g.* FROM node_grants g JOIN env_connections c
      ON c.id = g.connection_id AND c.owner_user_id = g.node_owner
      WHERE g.node_owner = ? AND g.connection_id = ? AND g.user_id = ? AND g.revoked = 0
        AND c.deleted_at IS NULL AND c.status != 'disabled' AND c.authority_version = g.node_version
        AND (? IS NULL OR g.id = ?) AND (g.runtime IS NULL OR g.runtime = ?)
        AND (g.agent_id IS NULL OR g.agent_id = ?) AND (g.session_key IS NULL OR g.session_key = ?)
        AND EXISTS(SELECT 1 FROM json_each(g.actions) WHERE value = ?)
      ORDER BY g.id`)
      .all(target.ownerUserId, target.connectionId, target.userId, grantId ?? null, grantId ?? null,
        resource.runtime ?? null, resource.agentId ?? null, resource.sessionKey ?? null, action) as Row[];
    // Effective access needs both a matching live grant and the current role ceiling.
    // Grants are additive: changing one grant is not a deny rule for other grants.
    const row = rows.find(candidate => !this.ceiling || observedParticipant(this.db, 'node-authority-check', () => this.ceiling!(target, action, resource, candidate.id)) === true);
    return row ? Object.freeze({ ...target, grantId: row.id, version: row.version, nodeVersion: row.node_version, action,
      resource: Object.freeze({ ...resource }) }) : undefined;
  }

  revalidate(proof: NodeGrantProof) {
    const current = this.authorize(proof, proof.action, proof.resource, proof.grantId);
    return !!current && current.version === proof.version && current.nodeVersion === proof.nodeVersion;
  }
}

function record(row: Row): NodeGrantRecord {
  return { id: row.id, userId: row.user_id, version: row.version, nodeVersion: row.node_version, revoked: !!row.revoked,
    policy: { ...(row.runtime ? { runtime: row.runtime } : {}), ...(row.agent_id ? { agentId: row.agent_id } : {}),
      ...(row.session_key ? { sessionKey: row.session_key } : {}), actions: JSON.parse(row.actions) } };
}

export function parseNodeGrantPolicy(value: unknown): NodeGrantPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['runtime', 'agentId', 'sessionKey', 'actions'].includes(key))) throw new Error('Invalid node grant policy');
  const policy = value as NodeGrantPolicy;
  validatePolicy(policy);
  return policy;
}

function validResource(value: NodeResource) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.runtime !== undefined && value.runtime !== 'codex' && value.runtime !== 'openclaw') return false;
  if (isOwnerOnlyRuntimeResource(value)) return false;
  for (const [field, limit] of [['agentId', 256], ['sessionKey', 2048]] as const) {
    const text = value[field];
    if (text !== undefined && (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > limit || /[\x00-\x1f\x7f]/.test(text))) return false;
  }
  // A runtime-specific identity must not accidentally match another runtime.
  return (!value.agentId && !value.sessionKey) || value.runtime !== undefined;
}

function validatePolicy(policy: NodeGrantPolicy): [NonNullable<NodeResource['runtime']> | null, string | null, string | null, string] {
  if (!validResource(policy) || !Array.isArray(policy.actions) || policy.actions.length < 1 || policy.actions.length > NODE_ACTIONS.length
    || policy.actions.some((action) => !NODE_ACTIONS.includes(action))) throw new Error('Invalid node grant policy');
  // Maintenance is node-wide; an apparently session-scoped maintenance grant
  // would misrepresent the scope of restart/update operations.
  if (policy.actions.includes('node:manage') && (policy.runtime || policy.agentId || policy.sessionKey)) throw new Error('Node management cannot be resource-scoped');
  return [policy.runtime ?? null, policy.agentId ?? null, policy.sessionKey ?? null, JSON.stringify([...new Set(policy.actions)].sort())];
}

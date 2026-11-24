import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { isOwnerOnlyRuntimeResource } from '@agentopsdeck/shared';
import type { HubPrincipal } from './identity.js';
import type { HubStore } from './hub-store.js';
import type { NodeAction, NodeGrantPolicy, NodeGrantTarget, NodeResource } from './node-grants.js';

export type ConnectorRole = 'none' | 'admin' | 'developer' | 'observer';
export type EnvironmentMode = 'disabled' | 'developer' | 'observer';
export type EnvironmentAccess = { codex: EnvironmentMode; openclaw: 'disabled' | 'observer' };
export type Membership = { role: ConnectorRole; version: number; nodeVersion: number; environments: EnvironmentAccess };
export type MembershipChange = Membership & { migrateLegacy: boolean; grantSetDigest?: string };
/** Explicit original policy rejection, never a SQL/commit/cleanup failure. */
export class RoleAccessConflict extends Error {
  constructor(readonly reason: 'denied' | 'changed' | 'owner' | 'administrator' | 'legacy' | 'observer' | 'adminEnvironments', message: string) {
    super(message);
  }
}
type MemberRow = { role: ConnectorRole; version: number; node_version: number; environments: string };
const readActions: NodeAction[] = ['sessions:read', 'messages:read', 'events:read', 'media:read'];
const creatorActions: NodeAction[] = [...readActions, 'messages:send', 'queue:manage', 'sessions:share'];
const emptyEnvironments = (): EnvironmentAccess => ({ codex: 'disabled', openclaw: 'disabled' });

/**
 * Role/runtime ceilings constrain grants; they do not replace resource authorization.
 * Ownership and inherited administrator reads are separate from delegated membership.
 * See docs/architecture/hub-permissions-maintenance.md before changing these boundaries.
 */
export class RoleAccess {
  constructor(private readonly db: DatabaseSync, private readonly store: HubStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS connector_memberships (
      node_owner TEXT NOT NULL, connection_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('none','admin','developer','observer')), version INTEGER NOT NULL,
      node_version INTEGER NOT NULL, environments TEXT NOT NULL,
      PRIMARY KEY(node_owner, connection_id, user_id),
      FOREIGN KEY(connection_id, node_owner) REFERENCES env_connections(id, owner_user_id)
    );
    CREATE TABLE IF NOT EXISTS role_grants (
      grant_id TEXT PRIMARY KEY REFERENCES node_grants(id), source TEXT NOT NULL CHECK(source IN ('hub','bootstrap','connector','creation'))
    );`);
    store.grants.ceiling = (target, action, resource, grantId) => this.permits(target, action, resource, grantId);
    store.grants.canShareWith = (sender, recipient) => !this.membership(sender).version || this.membership(recipient).version > 0;
  }

  managedGrant(id: string) {
    return !!this.db.prepare('SELECT 1 FROM role_grants WHERE grant_id = ?').get(id);
  }

  permitsDirectGrant(target: NodeGrantTarget, policy: NodeGrantPolicy) {
    if (isOwnerOnlyRuntimeResource(policy)) return false;
    return !this.membership(target).version || !!policy.sessionKey && policy.actions.every(action => this.permits(target, action, policy));
  }

  hubRole(userId: string) {
    return this.db.prepare('SELECT role, version FROM hub_roles WHERE user_id = ?').get(userId) as { role: 'member' | 'admin'; version: number } | undefined
      ?? { role: 'member' as const, version: 0 };
  }

  setHubRole(actor: HubPrincipal, userId: string, role: 'member' | 'admin', version: number) {
    if (!actor.admin || actor.userId === userId || !this.store.getUser(userId)) throw new Error('Hub administrator required; self changes are not allowed');
    return this.atomic(() => {
      if (this.hubRole(userId).version !== version) throw new Error('Role changed; refresh');
      this.db.prepare(`INSERT INTO hub_roles VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, version = version + 1`).run(userId, role);
      this.db.prepare(`UPDATE node_grants SET revoked = 1, version = version + 1 WHERE user_id = ? AND revoked = 0
        AND id IN (SELECT grant_id FROM role_grants WHERE source = 'hub')`).run(userId);
      this.store.identities.audit.append({ event: 'role_changed', outcome: 'success', actorUserId: actor.userId, userId, reason: `hub:${role}` });
      return this.hubRole(userId);
    });
  }

  membership(target: NodeGrantTarget): Membership {
    const row = this.db.prepare(`SELECT * FROM connector_memberships WHERE node_owner = ? AND connection_id = ? AND user_id = ?`)
      .get(target.ownerUserId, target.connectionId, target.userId) as MemberRow | undefined;
    return row ? { role: row.role, version: row.version, nodeVersion: row.node_version, environments: JSON.parse(row.environments) as EnvironmentAccess }
      : { role: 'none', version: 0, nodeVersion: 0, environments: emptyEnvironments() };
  }

  canManage(actor: HubPrincipal, target: Pick<NodeGrantTarget, 'ownerUserId' | 'connectionId'>) {
    if (actor.admin || actor.userId === target.ownerUserId) return true;
    const member = this.membership({ ...target, userId: actor.userId });
    return member.role === 'admin' && member.nodeVersion === this.store.connectionAuthority(target.connectionId, target.ownerUserId);
  }

  connections(actor: HubPrincipal) {
    const rows = this.db.prepare('SELECT id, owner_user_id FROM env_connections WHERE deleted_at IS NULL ORDER BY owner_user_id, id')
      .all() as Array<{ id: string; owner_user_id: string }>;
    return rows.filter(row => this.canManage(actor, { ownerUserId: row.owner_user_id, connectionId: row.id })).map(row => {
      const connection = this.store.getConnection(row.id, row.owner_user_id)!;
      const issuer = this.store.executionIssuers.current(row.owner_user_id, row.id);
      return { id: row.id, ownerUserId: row.owner_user_id, label: connection.label,
        nodeVersion: this.store.connectionAuthority(row.id, row.owner_user_id)!,
        verified: !!connection.nodeId && connection.status !== 'disabled',
        creationReady: issuer?.creationAllowed === true && issuer.nodeId === connection.nodeId,
        appointAdministrators: actor.admin, owner: row.owner_user_id === actor.userId };
    });
  }

  members(actor: HubPrincipal) {
    if (actor.admin) return this.store.listUsers();
    const connections = this.connections(actor);
    if (!connections.length) return [];
    const ids = new Set([actor.userId]);
    for (const connection of connections) {
      ids.add(connection.ownerUserId);
      const rows = this.db.prepare(`SELECT user_id FROM connector_memberships WHERE node_owner = ? AND connection_id = ? AND role != 'none'
        UNION SELECT user_id FROM node_grants WHERE node_owner = ? AND connection_id = ? AND revoked = 0`)
        .all(connection.ownerUserId, connection.id, connection.ownerUserId, connection.id) as Array<{ user_id: string }>;
      rows.forEach(row => ids.add(row.user_id));
    }
    return [...ids].map(id => this.store.getUser(id)!).filter(Boolean);
  }

  snapshot(actor: HubPrincipal, target: NodeGrantTarget) {
    if (!this.canManage(actor, target) || !this.store.getUser(target.userId)) throw new RoleAccessConflict('denied', 'Access management denied');
    const member = this.membership(target);
    const grantSetDigest = this.grantSetDigest(target);
    const legacy = this.db.prepare(`SELECT g.id, g.actions, g.runtime, g.session_key FROM node_grants g
      WHERE node_owner = ? AND connection_id = ? AND user_id = ? AND revoked = 0
      AND NOT EXISTS(SELECT 1 FROM role_grants WHERE grant_id = g.id)
      AND NOT EXISTS(SELECT 1 FROM node_grant_dependencies WHERE child_id = g.id)
      AND (? = 0 OR session_key IS NULL)`)
      .all(target.ownerUserId, target.connectionId, target.userId, member.version) as Array<{ id: string; actions: string; runtime: string | null; session_key: string | null }>;
    return { ...member, grantSetDigest, editable: target.userId !== target.ownerUserId && (actor.admin || target.userId !== actor.userId && member.role !== 'admin' && this.hubRole(target.userId).role !== 'admin'),
      legacyCount: legacy.length, legacyBroad: legacy.filter(row => !row.session_key && JSON.parse(row.actions).includes('messages:read')).length,
      inherited: this.hubRole(target.userId).role === 'admin' ? 'hub-admin' : target.userId === target.ownerUserId ? 'owner' : null };
  }

  sessionCandidates(target: NodeGrantTarget, resource: NodeResource) {
    const rows = this.db.prepare(`SELECT DISTINCT users.id, users.label FROM users JOIN connector_memberships member ON member.user_id = users.id
      WHERE member.node_owner = ? AND member.connection_id = ? AND member.role != 'none' AND users.id != ?
      AND NOT EXISTS (SELECT 1 FROM hub_user_access access WHERE access.user_id = users.id AND access.status = 'disabled')
      ORDER BY users.label LIMIT 500`)
      .all(target.ownerUserId, target.connectionId, target.userId) as Array<{ id: string; label: string }>;
    return rows.filter(user => this.permits({ ...target, userId: user.id }, 'messages:read', resource))
      .map(user => ({ ...user, canChat: this.permits({ ...target, userId: user.id }, 'messages:send', resource) }));
  }

  /** Snapshot binding covers additive grants and affected descendants, not just
   * membership CAS. Bound raw TEXT before materializing it; never hash secrets.
   * The digest is confirmation data, not authority, and is recomputed on save. */
  private grantSetDigest(target: NodeGrantTarget) {
    const sql = `WITH RECURSIVE affected(id) AS (
      SELECT id FROM node_grants WHERE node_owner=? AND connection_id=? AND user_id=? AND revoked=0
      UNION SELECT d.child_id FROM node_grant_dependencies d JOIN affected a ON d.parent_id=a.id
    ) SELECT g.id, g.user_id, g.node_owner, g.connection_id, g.node_version, g.version, g.revoked,
      g.runtime, g.agent_id, g.session_key, g.actions, r.source, d.parent_id, d.parent_version
      FROM affected a JOIN node_grants g ON g.id=a.id
      LEFT JOIN role_grants r ON r.grant_id=g.id LEFT JOIN node_grant_dependencies d ON d.child_id=g.id`;
    const args = [target.ownerUserId, target.connectionId, target.userId];
    let count = 0, bytes = 0;
    for (const row of this.db.prepare(`SELECT length(CAST(id AS BLOB)) AS i, length(CAST(user_id AS BLOB)) AS u,
      length(CAST(node_owner AS BLOB)) AS o, length(CAST(connection_id AS BLOB)) AS c,
      coalesce(length(CAST(runtime AS BLOB)),0) AS r, coalesce(length(CAST(agent_id AS BLOB)),0) AS a,
      coalesce(length(CAST(session_key AS BLOB)),0) AS s, length(CAST(actions AS BLOB)) AS p,
      coalesce(length(CAST(source AS BLOB)),0) AS f, coalesce(length(CAST(parent_id AS BLOB)),0) AS d
      FROM (${sql}) LIMIT 4097`).iterate(...args)) {
      if (++count > 4096) throw new Error('hub_membership_unavailable');
      for (const n of Object.values(row)) if (!Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 16384
        || (bytes += Number(n)) > 16 * 1024 * 1024) throw new Error('hub_membership_unavailable');
    }
    const digest = createHash('sha256').update(JSON.stringify(['membership-grants-v1', ...args]));
    for (const row of this.db.prepare(`${sql} ORDER BY g.id`).iterate(...args)) digest.update(JSON.stringify(row));
    return digest.digest('hex');
  }

  save(actor: HubPrincipal, target: NodeGrantTarget, input: MembershipChange) {
    return this.atomic(() => {
      const previous = this.snapshot(actor, target);
      if ((input.grantSetDigest !== undefined || previous.legacyCount > 0)
        && input.grantSetDigest !== previous.grantSetDigest) {
        throw new RoleAccessConflict('changed', 'Authorization set changed or not reviewed; refresh permissions');
      }
      const connection = this.store.getConnection(target.connectionId, target.ownerUserId);
      if (!connection?.nodeId || connection.status === 'disabled' || input.nodeVersion !== this.store.connectionAuthority(target.connectionId, target.ownerUserId)
        || previous.version !== input.version) throw new RoleAccessConflict('changed', 'Connection or member version changed; refresh');
      if (target.userId === target.ownerUserId) throw new RoleAccessConflict('owner', 'Connection owner access is inherited');
      if (!actor.admin && (target.userId === actor.userId || previous.role === 'admin' || input.role === 'admin' || this.hubRole(target.userId).role === 'admin')) throw new RoleAccessConflict('administrator', 'Only Hub administrators appoint Connector administrators');
      if (previous.legacyCount && !input.migrateLegacy) throw new RoleAccessConflict('legacy', 'Review and confirm legacy authorization conversion');
      const environments = input.role === 'none' ? emptyEnvironments() : input.environments;
      if (input.role === 'observer' && environments.codex === 'developer') throw new RoleAccessConflict('observer', 'Observers cannot execute');
      if (input.role === 'admin' && (environments.codex === 'disabled' || environments.openclaw === 'disabled')) throw new RoleAccessConflict('adminEnvironments', 'Connector administrators inherit read access to every environment');
      this.db.prepare(`INSERT INTO connector_memberships VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(node_owner,connection_id,user_id) DO UPDATE SET role = excluded.role, version = version + 1,
        node_version = excluded.node_version, environments = excluded.environments`)
        .run(target.ownerUserId, target.connectionId, target.userId, input.role, input.nodeVersion, JSON.stringify(environments));
      const rows = this.db.prepare(`SELECT g.id, g.version, g.runtime, g.agent_id, g.session_key, g.actions, g.node_version, r.source FROM node_grants g
        LEFT JOIN role_grants r ON r.grant_id = g.id WHERE g.node_owner = ? AND g.connection_id = ? AND g.user_id = ? AND g.revoked = 0`)
        .all(target.ownerUserId, target.connectionId, target.userId) as Array<{ id: string; version: number; runtime: NodeResource['runtime']; agent_id: string | null; session_key: string | null; actions: string; node_version: number; source: string | null }>;
      // Reconcile grants in the same savepoint as membership. Revoking a parent also
      // invalidates dependent shares; preserve compatible exact-session/creator grants.
      for (const row of rows) {
        if (row.source === 'hub' || row.source === 'bootstrap') continue;
        const actions = JSON.parse(row.actions) as NodeAction[];
        const creation = row.runtime === 'codex' && !row.agent_id && !row.session_key && actions.length === 1 && actions[0] === 'sessions:create';
        const resource = { ...(row.runtime ? { runtime: row.runtime } : {}), ...(row.session_key ? { sessionKey: row.session_key } : {}) };
        const derived = !!this.db.prepare('SELECT 1 FROM node_grant_dependencies WHERE child_id = ?').get(row.id);
        const keep = row.node_version === input.nodeVersion && actions.every(action => this.permits(target, action, resource, row.id))
          && (derived || creation || !!row.session_key || row.source === 'connector' && input.role === 'admin');
        if (!keep) this.store.grants.revoke(target, row.id, row.version);
        else if (creation) this.db.prepare("INSERT OR IGNORE INTO role_grants VALUES (?, 'creation')").run(row.id);
      }
      if (environments.codex === 'developer') this.ensureGrant(target, 'creation', { runtime: 'codex', actions: ['sessions:create'] });
      if (input.role === 'admin') for (const runtime of ['codex', 'openclaw'] as const) this.ensureGrant(target, 'connector', { runtime, actions: readActions });
      this.store.identities.audit.append({ event: 'role_changed', outcome: 'success', actorUserId: actor.userId, userId: target.userId,
        reason: JSON.stringify({ owner: target.ownerUserId, connector: target.connectionId, role: input.role, environments }) });
      return this.snapshot(actor, target);
    });
  }

  permits(target: NodeGrantTarget, action: NodeAction, resource: NodeResource, grantId?: string): boolean {
    // New runtimes stay owner-only until their role/grant migration is shipped.
    // Neither legacy wildcard grants nor inherited administrator reads opt in.
    if (isOwnerOnlyRuntimeResource(resource)) return false;
    // Inherited administrator grants are read-only and independent of member roles.
    // Bootstrap access additionally requires the authenticated administrator flag:
    // a normal key belonging to the default user must not inherit bootstrap access.
    const inherited = grantId ? this.db.prepare('SELECT source FROM role_grants WHERE grant_id = ?').get(grantId) as { source: string } | undefined : undefined;
    if (inherited?.source === 'hub') return this.hubRole(target.userId).role === 'admin' && readActions.includes(action);
    if (inherited?.source === 'bootstrap') return target.userId === 'default' && target.administrator === true && readActions.includes(action);
    const member = this.membership(target);
    // Version zero means legacy/unmanaged, not an explicit "none" membership.
    // Leave its existing grants unchanged until confirmed migration; this true
    // only passes the ceiling and never authorizes a resource without a grant.
    if (!member.version) return true;
    if (member.role === 'none' || member.nodeVersion !== this.store.connectionAuthority(target.connectionId, target.ownerUserId) || !resource.runtime) return false;
    // The identity registry is wider than the member permission model. New
    // owner-only runtimes must not index an absent environment as if enabled.
    if (resource.runtime !== 'codex' && resource.runtime !== 'openclaw') return false;
    const mode = member.environments[resource.runtime];
    if (mode === 'disabled') return false;
    if (inherited?.source === 'connector') return member.role === 'admin' && readActions.includes(action);
    if (action === 'sessions:create') return resource.runtime === 'codex' && mode === 'developer' && member.role !== 'observer';
    if (!resource.sessionKey) return false;
    if (readActions.includes(action)) return true;
    if (member.role === 'observer' || mode !== 'developer') return false;
    return creatorActions.includes(action);
  }

  syncAdministrator(actor: HubPrincipal) {
    if (!actor.admin) return;
    const source = this.hubRole(actor.userId).role === 'admin' ? 'hub' : 'bootstrap';
    if (source === 'bootstrap' && actor.userId !== 'default') return;
    this.atomic(() => {
      for (const connection of this.connections(actor)) {
        if (!connection.verified || connection.ownerUserId === actor.userId) continue;
        const target = { ownerUserId: connection.ownerUserId, connectionId: connection.id, userId: actor.userId };
        for (const runtime of ['codex', 'openclaw'] as const) this.ensureGrant(target, source, { runtime, actions: readActions });
      }
    });
  }

  private ensureGrant(target: NodeGrantTarget, source: string, policy: NodeGrantPolicy) {
    const existing = this.db.prepare(`SELECT 1 FROM node_grants g JOIN role_grants r ON r.grant_id = g.id
      WHERE node_owner = ? AND connection_id = ? AND user_id = ? AND revoked = 0 AND node_version = ? AND source = ? AND runtime = ?`)
      .get(target.ownerUserId, target.connectionId, target.userId, this.store.connectionAuthority(target.connectionId, target.ownerUserId)!, source, policy.runtime!);
    if (existing) return;
    const grant = this.store.grants.create(target, policy);
    this.db.prepare('INSERT INTO role_grants VALUES (?, ?)').run(grant.id, source);
  }

  private atomic<Result>(operation: () => Result extends PromiseLike<unknown> ? never : Result): Result {
    return observedSavepoint(this.db, 'role-access-change', operation);
  }
}

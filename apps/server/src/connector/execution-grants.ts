import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isOwnerOnlyRuntimeResource, type AgentRuntimeId } from '@agentopsdeck/shared';
import { observedTransaction } from '../storage/observed-transaction.js';
import { observedParticipant } from '../storage/observed-participant.js';

// Connector-owned, attenuated execution authority. This is neither a second
// human-account store nor an execution queue. No bearer secret is persisted.
export const EXECUTION_ACTIONS = ['messages:send', 'messages:mirror', 'runs:interrupt', 'runs:compact'] as const;
export type ExecutionAction = typeof EXECUTION_ACTIONS[number];
export type ExecutionGrantTarget = { runtime: AgentRuntimeId; sessionKey: string };
export type ExecutionGrantBinding = ExecutionGrantTarget & {
  issuerTokenId: string; hubId: string; principalId: string; grantKey: string; version: number;
};
export class ExecutionGrantConflict extends Error {}
export class ExecutionGrantCapacity extends Error {}
export class ExecutionGrantInvalid extends Error {}
export class ExecutionIssuerDenied extends Error {}
type Row = {
  id: string; binding: string; lineage: string; version: number; actor_id: string; issuer_token_id: string;
  runtime: string; session_key: string; actions: string; issued_at: number; expires_at: number; revoked: number;
};
export type ExecutionGrantRef = { id: string; actorId: string };
export type ExecutionGrantAuthority = ExecutionGrantRef & { issuerTokenId: string };
export type AuthorizeTurn = (actorId: string | undefined, target: ExecutionGrantTarget,
  action: ExecutionAction, grant?: ExecutionGrantAuthority) => boolean;

export function createTurnAuthorizer(grants: ExecutionGrants,
  hasScope: (tokenId: string | undefined, scope: 'messages:send' | 'messages:mirror' | 'execution:delegate') => boolean): AuthorizeTurn {
  return (actorId, target, action, grant) => grants.authorizeTurn(hasScope, actorId, target, action, grant);
}

/** Scheduling observations are hints, not effect authority. Unlike admission,
 * observing an expired lease must not write a revocation from a pure-read
 * command. The actual claim still uses authorizeTurn and durably revokes it. */
export function createTurnObserver(grants: ExecutionGrants,
  hasScope: Parameters<typeof createTurnAuthorizer>[1]): AuthorizeTurn {
  return (actorId, target, action, grant) => grants.observeTurn(hasScope, actorId, target, action, grant);
}

export class ExecutionGrants {
  constructor(private readonly db: DatabaseSync,
    private readonly issuerAuthorized: (tokenId: string, action: ExecutionAction) => boolean,
    private readonly now = Date.now, private readonly maxRows = 10_000) {
    db.exec(`CREATE TABLE IF NOT EXISTS connector_execution_grants (
      id TEXT PRIMARY KEY, binding TEXT NOT NULL UNIQUE, lineage TEXT NOT NULL, version INTEGER NOT NULL,
      actor_id TEXT NOT NULL, issuer_token_id TEXT NOT NULL,
      runtime TEXT NOT NULL CHECK(runtime IN ('codex', 'openclaw')), session_key TEXT NOT NULL,
      actions TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS connector_execution_grant_version ON connector_execution_grants(lineage, version);`);
  }

  authorizeTurn(hasScope: Parameters<typeof createTurnAuthorizer>[1], actorId: string | undefined,
    target: ExecutionGrantTarget, action: ExecutionAction, grant?: ExecutionGrantAuthority): boolean {
    return this.checkTurn(hasScope, actorId, target, action, grant, false);
  }

  observeTurn(hasScope: Parameters<typeof createTurnAuthorizer>[1], actorId: string | undefined,
    target: ExecutionGrantTarget, action: ExecutionAction, grant?: ExecutionGrantAuthority): boolean {
    return this.checkTurn(hasScope, actorId, target, action, grant, true);
  }

  private checkTurn(hasScope: Parameters<typeof createTurnAuthorizer>[1], actorId: string | undefined,
    target: ExecutionGrantTarget, action: ExecutionAction, grant: ExecutionGrantAuthority | undefined, readOnly: boolean): boolean {
    if (grant ? grant.actorId !== actorId : !actorId || actorId.startsWith('actor_')) return false;
    return observedParticipant(this.db, 'execution-issuer-check', () => {
      const scope = (tokenId: string, permission: Parameters<typeof hasScope>[1]) =>
        observedParticipant(this.db, 'execution-issuer-check', () => hasScope(tokenId, permission)) === true;
      return grant
        ? grant.actorId === actorId && scope(grant.issuerTokenId, 'execution:delegate')
          && this.checkGrant(grant, grant.issuerTokenId, target, action, readOnly)
        : !!actorId && !actorId.startsWith('actor_') && scope(actorId, 'messages:send')
          && (action !== 'messages:mirror' || actorId === 'local:daily' || scope(actorId, 'messages:mirror'));
    });
  }

  private issuerAllows(tokenId: string, action: ExecutionAction): boolean {
    return observedParticipant(this.db, 'execution-issuer-check', () => this.issuerAuthorized(tokenId, action)) === true;
  }

  // Trusted boundary only: the future authenticated delegation endpoint must
  // establish hub/principal/grant provenance, not copy arbitrary browser JSON.
  // Same binding is immutable; renewal cannot change its target or permissions.
  issue(binding: ExecutionGrantBinding, actions: ExecutionAction[], expiresAt: number): ExecutionGrantRef {
    validateBinding(binding);
    if (!Array.isArray(actions) || !actions.length || actions.length > EXECUTION_ACTIONS.length
      || actions.some(action => !EXECUTION_ACTIONS.includes(action)) || new Set(actions).size !== actions.length) throw new ExecutionGrantInvalid('Invalid execution actions');
    const now = this.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 60_000) throw new ExecutionGrantInvalid('Execution lease exceeds bound');
    if (actions.some(action => !this.issuerAllows(binding.issuerTokenId, action))) throw new ExecutionIssuerDenied('Execution issuer is not authorized');
    const identity = JSON.stringify([binding.issuerTokenId, binding.hubId, binding.principalId, binding.grantKey, binding.version]);
    const lineage = JSON.stringify([binding.issuerTokenId, binding.hubId, binding.principalId, binding.grantKey]);
    const actorId = `actor_${createHash('sha256').update(JSON.stringify([binding.issuerTokenId, binding.hubId, binding.principalId])).digest('hex')}`;
    const policy = JSON.stringify([...actions].sort());
    const existing = this.db.prepare('SELECT * FROM connector_execution_grants WHERE binding = ?').get(identity) as Row | undefined;
    if (existing) {
      if (existing.expires_at <= now || now < existing.issued_at) this.revoke(binding.issuerTokenId, existing.id);
      if (existing.revoked || existing.expires_at <= now || now < existing.issued_at
        || existing.runtime !== binding.runtime || existing.session_key !== binding.sessionKey || existing.actions !== policy) throw new ExecutionGrantConflict('Execution grant binding is stale or conflicts');
      // Anchor rollback detection at the latest renewal, not only first issue.
      this.db.prepare('UPDATE connector_execution_grants SET expires_at = max(expires_at, ?), issued_at = ? WHERE id = ?')
        .run(expiresAt, now, existing.id);
      return { id: existing.id, actorId: existing.actor_id };
    }
    const latest = this.db.prepare('SELECT max(version) AS version FROM connector_execution_grants WHERE lineage = ?').get(lineage) as { version: number | null };
    if (latest.version !== null && latest.version >= binding.version) throw new ExecutionGrantConflict('Execution grant version is stale');
    const id = randomUUID();
    observedTransaction(this.db, 'execution-grant-change', () => {
      const inserted = this.db.prepare(`INSERT INTO connector_execution_grants
        (id, binding, lineage, version, actor_id, issuer_token_id, runtime, session_key, actions, issued_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM connector_execution_grants) < ?
        AND NOT EXISTS(SELECT 1 FROM connector_execution_grants WHERE lineage = ? AND version >= ?)`)
        .run(id, identity, lineage, binding.version, actorId, binding.issuerTokenId, binding.runtime, binding.sessionKey, policy, now, expiresAt, this.maxRows, lineage, binding.version);
      if (!inserted.changes) throw new ExecutionGrantCapacity('Execution grant capacity reached or version is stale');
      this.db.prepare('UPDATE connector_execution_grants SET revoked = 1 WHERE lineage = ? AND version < ?').run(lineage, binding.version);
    });
    return { id, actorId };
  }

  authorize(ref: ExecutionGrantRef, issuerTokenId: string, target: ExecutionGrantTarget, action: ExecutionAction) {
    return this.checkGrant(ref, issuerTokenId, target, action, false);
  }

  private checkGrant(ref: ExecutionGrantRef, issuerTokenId: string, target: ExecutionGrantTarget,
    action: ExecutionAction, readOnly: boolean) {
    if (isOwnerOnlyRuntimeResource(target)) return false;
    const row = this.db.prepare('SELECT * FROM connector_execution_grants WHERE id = ?').get(ref.id) as Row | undefined;
    if (!row || row.revoked || row.issuer_token_id !== issuerTokenId || row.actor_id !== ref.actorId
      || row.runtime !== target.runtime || row.session_key !== target.sessionKey) return false;
    const now = this.now();
    if (now >= row.expires_at || now < row.issued_at) {
      // Observed expiry/clock rollback cannot revive following a later clock
      // correction or process restart. Unknown command outcomes are untouched.
      if (!readOnly) this.revoke(issuerTokenId, ref.id);
      return false;
    }
    return (JSON.parse(row.actions) as ExecutionAction[]).includes(action) && this.issuerAllows(issuerTokenId, action);
  }

  // Metadata lookup is deliberately independent of lease liveness: a trusted
  // issuer may recover the outcome of already accepted work after revocation.
  // Callers must still check current read scope; writes additionally authorize.
  resolve(id: string, issuerTokenId: string, hubId: string, target: ExecutionGrantTarget): ExecutionGrantAuthority | undefined {
    if (isOwnerOnlyRuntimeResource(target)) return undefined;
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = this.db.prepare('SELECT * FROM connector_execution_grants WHERE id = ?').get(id) as Row | undefined;
    if (!row || !row.actor_id || row.issuer_token_id !== issuerTokenId || row.runtime !== target.runtime
      || row.session_key !== target.sessionKey || JSON.parse(row.binding)[1] !== hubId) return undefined;
    return { id: row.id, actorId: row.actor_id, issuerTokenId };
  }

  usage(ids: string[], issuerTokenId: string, hubId: string,
    pending: (target: ExecutionGrantTarget, grant: ExecutionGrantAuthority) => boolean) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new ExecutionGrantInvalid('Invalid execution usage batch');
    // Resolve all provenance before touching the queue; no caller-supplied
    // runtime/session/actor can select another issuer's pending work.
    const rows = ids.map(id => {
      const row = this.db.prepare('SELECT * FROM connector_execution_grants WHERE id = ?').get(id) as Row | undefined;
      if (!row || !row.actor_id || row.issuer_token_id !== issuerTokenId || JSON.parse(row.binding)[1] !== hubId) {
        throw new ExecutionIssuerDenied('Execution usage is not authorized');
      }
      return row;
    });
    return rows.map(row => {
      const target = { runtime: row.runtime as ExecutionGrantTarget['runtime'], sessionKey: row.session_key };
      const authority = { id: row.id, actorId: row.actor_id, issuerTokenId };
      return { id: row.id, needed: this.authorize(authority, issuerTokenId, target, 'messages:send')
        && observedParticipant(this.db, 'execution-issuer-check', () => pending(target, authority)) === true };
    });
  }

  revoke(issuerTokenId: string, id: string) {
    return this.db.prepare('UPDATE connector_execution_grants SET revoked = 1 WHERE id = ? AND issuer_token_id = ? AND revoked = 0')
      .run(id, issuerTokenId).changes === 1;
  }

  // Revoke-before-issue is a durable version barrier. It also works when an
  // issuance ACK was lost and the Hub has never learned the random grant ID.
  revokeVersion(binding: ExecutionGrantBinding) {
    validateBinding(binding);
    const identity = JSON.stringify([binding.issuerTokenId, binding.hubId, binding.principalId, binding.grantKey, binding.version]);
    const lineage = JSON.stringify([binding.issuerTokenId, binding.hubId, binding.principalId, binding.grantKey]);
    observedTransaction(this.db, 'execution-grant-change', () => {
      const latest = this.db.prepare('SELECT max(version) AS version FROM connector_execution_grants WHERE lineage = ?').get(lineage) as { version: number | null };
      // A newer version already blocks all older issues; do not consume a row
      // for duplicate/late revocations, and never revoke that newer authority.
      if (latest.version === null || latest.version < binding.version) {
        const inserted = this.db.prepare(`INSERT INTO connector_execution_grants
          (id, binding, lineage, version, actor_id, issuer_token_id, runtime, session_key, actions, issued_at, expires_at, revoked)
          SELECT ?, ?, ?, ?, '', ?, ?, ?, '[]', ?, 0, 1 WHERE (SELECT count(*) FROM connector_execution_grants) < ?`)
          .run(randomUUID(), identity, lineage, binding.version, binding.issuerTokenId, binding.runtime, binding.sessionKey, this.now(), this.maxRows);
        if (!inserted.changes) throw new ExecutionGrantCapacity('Execution grant capacity reached');
      }
      this.db.prepare('UPDATE connector_execution_grants SET revoked = 1 WHERE lineage = ? AND version <= ?').run(lineage, binding.version);
    });
  }
}

function validateBinding(binding: ExecutionGrantBinding) {
  for (const value of [binding.issuerTokenId, binding.hubId, binding.principalId, binding.grantKey, binding.sessionKey]) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\u0000-\u001f]/.test(value)) throw new ExecutionGrantInvalid('Invalid execution binding');
  }
  if (!['codex', 'openclaw'].includes(binding.runtime) || !Number.isSafeInteger(binding.version) || binding.version < 1) throw new ExecutionGrantInvalid('Invalid execution binding');
  if (isOwnerOnlyRuntimeResource(binding)) throw new ExecutionGrantInvalid('Invalid execution binding');
}

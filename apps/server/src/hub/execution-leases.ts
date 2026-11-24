import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { isOwnerOnlyRuntimeResource, sessionRuntimeId } from '@agentopsdeck/shared';
import { EXECUTION_ACTIONS, type ExecutionAction, type ExecutionGrantRef } from '../connector/execution-grants.js';
import { isNodeId } from '../connector/node-identity.js';
import type { NodeGrantProof, NodeGrants } from './node-grants.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';

type UsagePage = Array<{ lease: ExecutionLease; version: number }>;
export type ExecutionUsageAdmission = (bytes: number, write: () => Promise<UsagePage>) => Promise<UsagePage>;

export type ExecutionLease = {
  id: number; grantKey: string; version: number; nodeId: string; issuerId: string;
  proof: NodeGrantProof; actions: ExecutionAction[]; expiresAt: number;
  state: 'pending' | 'active' | 'revoking' | 'revoked'; ref?: ExecutionGrantRef;
};
type Row = {
  id: number; grant_key: string; version: number; node_id: string; issuer_id: string;
  proof: string; actions: string; expires_at: number; state: ExecutionLease['state']; ref: string | null;
};

/** Durable delegation intents, not Agent commands. Persist before HTTP so a
 * lost issue ACK can be revoked by version after restart without its random ref.
 * Caller supplies an explicitly configured issuer ID (not a bearer secret).
 * No timer: runtime composition will own bounded reconciliation and lease use.
 */
export class HubExecutionLeases {
  constructor(private readonly db: DatabaseSync, private readonly grants: NodeGrants,
    private readonly now = Date.now, private readonly maxRows = 10_000,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly asyncStorageAdmission?: ExecutionUsageAdmission) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_execution_leases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, grant_key TEXT NOT NULL, version INTEGER NOT NULL,
      node_id TEXT NOT NULL, issuer_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, connection_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      proof TEXT NOT NULL, actions TEXT NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'revoking', 'revoked')), ref TEXT,
      UNIQUE(grant_key, version)
    );
    CREATE INDEX IF NOT EXISTS hub_execution_lease_grant ON hub_execution_leases(grant_id, state);
    CREATE INDEX IF NOT EXISTS hub_execution_lease_node ON hub_execution_leases(owner_id, connection_id, state);
    CREATE INDEX IF NOT EXISTS hub_execution_lease_state ON hub_execution_leases(state, id);
    CREATE INDEX IF NOT EXISTS hub_execution_queue_actor ON hub_execution_leases
      (owner_id, connection_id, principal_id, node_id, json_extract(proof, '$.resource.sessionKey'), issuer_id, id DESC) WHERE ref IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS hub_execution_grant_changed AFTER UPDATE ON node_grants
      WHEN NEW.version != OLD.version OR NEW.revoked != OLD.revoked BEGIN
      UPDATE hub_execution_leases SET state = 'revoking' WHERE grant_id = OLD.id AND state IN ('pending', 'active');
    END;
    CREATE TRIGGER IF NOT EXISTS hub_execution_node_changed AFTER UPDATE ON env_connections
      WHEN NEW.authority_version != OLD.authority_version BEGIN
      UPDATE hub_execution_leases SET state = 'revoking' WHERE owner_id = OLD.owner_user_id
        AND connection_id = OLD.id AND state IN ('pending', 'active');
    END;
    CREATE TRIGGER IF NOT EXISTS hub_execution_grant_deleted BEFORE DELETE ON node_grants BEGIN
      UPDATE hub_execution_leases SET state = 'revoking' WHERE grant_id = OLD.id AND state IN ('pending', 'active');
    END;
    CREATE TRIGGER IF NOT EXISTS hub_execution_node_deleted BEFORE DELETE ON env_connections BEGIN
      UPDATE hub_execution_leases SET state = 'revoking' WHERE owner_id = OLD.owner_user_id
        AND connection_id = OLD.id AND state IN ('pending', 'active');
    END;`);
    observedSavepoint(db, 'execution-usage-migration', () => {
      const columns = db.prepare('PRAGMA table_info(hub_execution_leases)').all() as Array<{ name: string }>;
      const missing = ['usage_version', 'usage_pending', 'usage_after'].filter(name => !columns.some(column => column.name === name));
      for (const name of missing) db.exec(`ALTER TABLE hub_execution_leases ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS hub_execution_usage_due ON hub_execution_leases(usage_pending, usage_after, id);
      CREATE INDEX IF NOT EXISTS command_receipt_authority ON command_receipts(authority_id, state);
      CREATE TRIGGER IF NOT EXISTS hub_execution_command_claimed AFTER INSERT ON command_receipts
      WHEN new.authority_id IS NOT NULL BEGIN
        UPDATE hub_execution_leases SET usage_version = usage_version + 1, usage_pending = 1, usage_after = 0
          WHERE id = new.authority_id;
      END;`);
      // Upgrade receipts created before usage tracking. DDL and backfill commit
      // together; an ordinary reopen must not wake already quiet demand.
      if (missing.length) db.exec(`UPDATE hub_execution_leases SET usage_version = usage_version + 1,
        usage_pending = 1, usage_after = 0 WHERE EXISTS
          (SELECT 1 FROM command_receipts WHERE authority_id = hub_execution_leases.id)`);
    });
  }

  reserve(proof: NodeGrantProof, nodeId: string, issuerId: string, actions: ExecutionAction[]): ExecutionLease {
    if (!isNodeId(nodeId) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(issuerId)) throw new Error('Verified issuer binding required');
    // Agent selectors need a verified session->agent mapping; do not accept a
    // caller assertion here. Narrow first implementation is exact runtime/session.
    if (!proof.resource.sessionKey || proof.resource.agentId !== undefined
      || isOwnerOnlyRuntimeResource(proof.resource)
      || proof.resource.runtime !== sessionRuntimeId(proof.resource.sessionKey)
      || !Array.isArray(actions) || !actions.length || actions.length > EXECUTION_ACTIONS.length
      || new Set(actions).size !== actions.length || !actions.includes(proof.action as ExecutionAction)
      || actions.some(action => !EXECUTION_ACTIONS.includes(action))) throw new Error('Invalid execution policy');
    const node = this.db.prepare('SELECT node_id FROM env_connections WHERE owner_user_id = ? AND id = ?')
      .get(proof.ownerUserId, proof.connectionId) as { node_id: string | null } | undefined;
    if (node?.node_id !== nodeId || !this.authorized(proof, actions)) throw new Error('Execution policy is not current');
    const grantKey = createHash('sha256').update(JSON.stringify([proof.ownerUserId, proof.connectionId,
      nodeId, issuerId, proof.grantId, proof.userId, proof.resource.runtime, proof.resource.sessionKey])).digest('hex');
    const policy = JSON.stringify([...actions].sort()), now = this.now();
    const row = this.db.prepare('SELECT * FROM hub_execution_leases WHERE grant_key = ? ORDER BY version DESC LIMIT 1').get(grantKey) as Row | undefined;
    if (row && row.state !== 'revoked') {
      if (row.state === 'revoking') throw new Error('Execution revocation is pending');
      const previous = JSON.parse(row.proof) as NodeGrantProof;
      if (previous.version !== proof.version || previous.nodeVersion !== proof.nodeVersion || row.actions !== policy
        || row.expires_at <= now || row.expires_at > now + 60_000) {
        this.revoke(row.id);
        throw new Error('Execution lease must be reconciled before replacement');
      }
      return decode(row);
    }
    const version = (row?.version ?? 0) + 1;
    if (!Number.isSafeInteger(version)) throw new Error('Execution version exhausted');
    const result = this.db.prepare(`INSERT INTO hub_execution_leases
      (grant_key, version, node_id, issuer_id, grant_id, owner_id, connection_id, principal_id, proof, actions, expires_at, state)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending' WHERE (SELECT count(*) FROM hub_execution_leases) < ?`)
      .run(grantKey, version, nodeId, issuerId, proof.grantId, proof.ownerUserId, proof.connectionId, proof.userId,
        JSON.stringify(proof), policy, now + 60_000, this.maxRows);
    if (!result.changes) throw new Error('Execution lease capacity reached');
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number) {
    const row = this.db.prepare('SELECT * FROM hub_execution_leases WHERE id = ?').get(id) as Row | undefined;
    return row && decode(row);
  }

  // One historical issuer/actor at a time. The newest acknowledged ref for
  // that issuer reads its stable actor without acquiring or renewing a lease.
  nextQueueActor(target: { ownerUserId: string; connectionId: string; userId: string; sessionKey: string; nodeId: string }, afterIssuer = '') {
    const row = this.db.prepare(`SELECT * FROM hub_execution_leases WHERE owner_id = ? AND connection_id = ?
      AND principal_id = ? AND node_id = ? AND json_extract(proof, '$.resource.sessionKey') = ?
      AND issuer_id > ? AND ref IS NOT NULL ORDER BY issuer_id, id DESC LIMIT 1`)
      .get(target.ownerUserId, target.connectionId, target.userId, target.nodeId, target.sessionKey, afterIssuer) as Row | undefined;
    return row && decode(row);
  }

  authorized(proof: NodeGrantProof, actions: ExecutionAction[]) {
    return this.grants.revalidate(proof) && actions.every(action => this.grants.revalidate({ ...proof, action }));
  }

  // Before every issue/renew, including retries. The persisted deadline is an
  // upper bound on the last request, not proof that the Connector received it.
  prepareIssue(id: number) {
    const lease = this.get(id), now = this.now();
    if (!lease || !['pending', 'active'].includes(lease.state)) throw new Error('Execution lease is not issuable');
    if (!this.authorized(lease.proof, lease.actions) || lease.expiresAt <= now || lease.expiresAt > now + 60_000) {
      this.revoke(id); throw new Error('Execution lease is no longer current');
    }
    this.db.prepare("UPDATE hub_execution_leases SET expires_at = ?, state = 'pending' WHERE id = ?").run(now + 60_000, id);
    return this.get(id)!;
  }

  acknowledgeIssue(id: number, ref: ExecutionGrantRef, expiresAt: number) {
    const lease = this.get(id);
    if (!lease || !/^[0-9a-f-]{36}$/.test(ref?.id) || !/^actor_[0-9a-f]{64}$/.test(ref?.actorId)) throw new Error('Invalid execution acknowledgment');
    if (lease.ref && (lease.ref.id !== ref.id || lease.ref.actorId !== ref.actorId)) {
      this.revoke(id); throw new Error('Execution identity changed');
    }
    if (!this.authorized(lease.proof, lease.actions) || lease.expiresAt <= this.now() || lease.expiresAt > this.now() + 60_000) this.revoke(id);
    return this.db.prepare("UPDATE hub_execution_leases SET state = 'active', ref = ? WHERE id = ? AND expires_at = ? AND state IN ('pending', 'active')")
      .run(JSON.stringify(ref), id, expiresAt).changes > 0;
  }

  revoke(id: number) {
    this.db.prepare("UPDATE hub_execution_leases SET state = 'revoking' WHERE id = ? AND state IN ('pending', 'active')").run(id);
  }

  acknowledgeRevoke(id: number, throughVersion: number) {
    return this.db.prepare("UPDATE hub_execution_leases SET state = 'revoked' WHERE id = ? AND version = ? AND state = 'revoking'")
      .run(id, throughVersion).changes > 0;
  }

  revocations(after = 0, limit = 32) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('Invalid reconciliation page');
    return (this.db.prepare("SELECT * FROM hub_execution_leases WHERE state = 'revoking' AND id > ? ORDER BY id LIMIT ?")
      .all(after, limit) as Row[]).map(decode);
  }

  // Reserve a bounded page before HTTP. Receipt insertion atomically wakes a
  // lease and changes its generation, so an old "unused" reply cannot erase a
  // concurrently claimed command. No payloads or duplicate command journal.
  usageDue(limit = 16, beforeReservation?: (at: number) => void) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid usage page');
    return observedSavepoint(this.db, 'execution-usage-reserve', () => {
      const now = this.now();
      // Worker-local guard, never serialized. Inspect the exact due cutoff
      // inside the original savepoint before materializing or charging rows.
      beforeReservation?.(now);
      const rows = this.db.prepare(`SELECT * FROM hub_execution_leases
        WHERE usage_pending = 1 AND usage_after <= ? AND state IN ('active', 'pending') AND ref IS NOT NULL
        ORDER BY usage_after, id LIMIT ?`).all(now, limit) as Array<Row & { usage_version: number }>;
      // Decode the complete bounded page before charging any retry. One owner,
      // one atomic reservation: no partially delayed page on a later fault.
      const page = rows.map(row => ({ lease: decode(row), version: row.usage_version }));
      const reserve = this.db.prepare('UPDATE hub_execution_leases SET usage_after = ? WHERE id = ?');
      for (const row of rows) reserve.run(now + 15_000, row.id);
      return page;
    }, this.diagnostics);
  }

  usageQuiet(id: number, version: number) {
    // Unknown receipts may be in transit when the Connector snapshot is taken.
    // Keep probing them until known or expired, without renewing absent work.
    return !!this.db.prepare(`UPDATE hub_execution_leases SET usage_pending = 0
      WHERE id = ? AND usage_version = ? AND NOT EXISTS
        (SELECT 1 FROM command_receipts WHERE authority_id = ? AND state = 'outcome_unknown')`)
      .run(id, version, id).changes;
  }

  /** Only capacity coordination yields. Shared business SQL stays in the
   * original owner and reserves the whole page synchronously/atomically. */
  async usageDueAsync(limit = 16, check: () => void = () => {}, beforeReservation?: (at: number) => void) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid usage page');
    const trace = this.diagnostics.start('execution-usage-admission');
    let failed = true, changed = false, step = 1;
    const warning = setTimeout(() => trace.reportPending({ pending: 1, step, unknown: Number(changed) }), 30_000);
    warning.unref();
    const ready = () => {
      check(); requireConnectionReady(this.db);
      if (!this.db.isOpen || this.db.isTransaction) throw new Error('Usage reservation requires its ready original owner');
    };
    const write = () => {
      ready(); step = 2;
      const page = this.usageDue(limit, beforeReservation); changed = page.length > 0;
      trace.add('changed', Number(changed)); step = 3; return page;
    };
    try {
      ready();
      // Empty polls do not need a capacity-ledger write. This indexed read is
      // only a demand hint, never authority cached across the admission await:
      // the original callback re-reads and atomically reserves the actual page.
      const due = this.db.prepare(`SELECT 1 FROM hub_execution_leases
        WHERE usage_pending = 1 AND usage_after <= ? AND state IN ('active', 'pending') AND ref IS NOT NULL
        LIMIT 1`).get(this.now());
      if (!due) { ready(); failed = false; return []; }
      let page: UsagePage;
      if (!this.asyncStorageAdmission) page = write();
      else {
        const queued = performance.now(); let active = true, entered = false, reserved: UsagePage | undefined, releaseAt: number | undefined;
        try {
          await this.asyncStorageAdmission(65536 + limit * 4096, async () => {
            if (!active) throw new Error('Usage reservation admission ended');
            if (entered) throw new Error('Usage reservation callback already entered');
            entered = true; trace.add('queueMs', performance.now() - queued);
            try { reserved = write(); return reserved; }
            finally { releaseAt = performance.now(); }
          });
          if (!entered || !reserved) throw new Error('Usage reservation was not acknowledged');
          page = reserved;
        } finally {
          active = false;
          if (!entered) trace.add('queueMs', performance.now() - queued);
          if (releaseAt !== undefined) trace.add('releaseMs', performance.now() - releaseAt);
        }
      }
      // A durable reservation is not permission from a retired owner. Lost
      // release ACK is never cause to repeat SQL or start unconfirmed probes.
      ready(); failed = false; return page;
    } catch (error) { trace.add(changed ? 'unknown' : 'deferred', 1); throw error; }
    finally { clearTimeout(warning); trace.finish(failed); }
  }
}

function decode(row: Row): ExecutionLease {
  return { id: row.id, grantKey: row.grant_key, version: row.version, nodeId: row.node_id, issuerId: row.issuer_id,
    proof: JSON.parse(row.proof), actions: JSON.parse(row.actions), expiresAt: row.expires_at, state: row.state,
    ...(row.ref ? { ref: JSON.parse(row.ref) } : {}) };
}

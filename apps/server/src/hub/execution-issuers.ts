import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import type { ExecutionLease } from './execution-leases.js';
import { ConnectorClient } from './connector-client.js';
import type { Dispatch } from '../connector/transport.js';
import { HubExecutionEffects, type ExecutionEffectOperation } from './execution-effects.js';
import { isNodeId } from '../connector/node-identity.js';

type IssuerRow = {
  id: string; connection_id: string; node_id: string; issuer_id: string;
  authority_version: number; connector_url: string; kind: 'local' | 'remote'; retired: number; creation_allowed: number;
};
type NodeRow = { node_id: string | null; authority_version: number; connector_url: string; kind: 'local' | 'remote' };
export type IssuerConfigurationTarget = { nodeId: string; version: number; origin: string; kind: 'local' | 'remote' };
// CASE bounds are evaluated in SQLite before transferring a value to JS. A
// damaged TEXT flag must never be projected as a truthy capability or loaded
// unboundedly just to reject it afterwards. Do not select unrelated columns.
const boundedText = (field: string, bytes: number) => `CASE WHEN typeof(${field})='text'
  AND length(CAST(${field} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${field} END AS ${field}`;
const boundedVersion = `CASE WHEN typeof(authority_version)='integer'
  AND authority_version BETWEEN 1 AND 9007199254740991 THEN authority_version END AS authority_version`;
const issuerColumns = [boundedText('id', 512), boundedText('connection_id', 16_384), boundedText('node_id', 128),
  boundedText('issuer_id', 128), boundedText('connector_url', 4096), boundedText('kind', 6), boundedVersion,
  ...['retired', 'creation_allowed'].map(field => `CASE WHEN typeof(${field})='integer'
    AND ${field} IN (0,1) THEN ${field} END AS ${field}`)].join(',');
type Vault = { read: (id: string) => string | undefined; write: (id: string, token: string) => void };
type Local = { connectionId: string; dispatch: Dispatch };
export type ExecutionIssuerSnapshot = { origin: string; token: string; kind: 'local' | 'remote';
  connectionId: string; nodeId: string; issuerId: string; version: number };

/** Retain encrypted old issuer credentials only for pinned revoke/command reads.
 * Current issuer commands use one exact target. No ordinary-token fallback,
 * arbitrary proxy, or background timer.
 */
export class HubExecutionIssuers extends HubExecutionEffects {
  private readonly configuring = new Map<string, Promise<{ issuerId: string; nodeId: string; version: number }>>();
  private readonly abort = new AbortController();
  private closing?: Promise<void>;
  constructor(private readonly db: DatabaseSync, private readonly hubId: string, private readonly vault: Vault,
    private readonly maxRows = 1_000) {
    super();
    db.exec(`CREATE TABLE IF NOT EXISTS hub_execution_issuers (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, connection_id TEXT NOT NULL, node_id TEXT NOT NULL,
      issuer_id TEXT NOT NULL, authority_version INTEGER NOT NULL, connector_url TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('local', 'remote')), retired INTEGER NOT NULL DEFAULT 0,
      UNIQUE(owner_id, connection_id, authority_version)
    );
    CREATE TRIGGER IF NOT EXISTS hub_execution_issuer_node_changed AFTER UPDATE ON env_connections
      WHEN NEW.authority_version != OLD.authority_version BEGIN
      UPDATE hub_execution_issuers SET retired = 1 WHERE owner_id = OLD.owner_user_id AND connection_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS hub_execution_issuer_node_deleted BEFORE DELETE ON env_connections BEGIN
      UPDATE hub_execution_issuers SET retired = 1 WHERE owner_id = OLD.owner_user_id AND connection_id = OLD.id;
    END;`);
    const columns = this.db.prepare('PRAGMA table_info(hub_execution_issuers)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'creation_allowed')) this.db.exec('ALTER TABLE hub_execution_issuers ADD COLUMN creation_allowed INTEGER NOT NULL DEFAULT 0');
  }

  current(ownerId: string, connectionId: string) {
    const node = this.node(ownerId, connectionId);
    if (!node?.node_id) return undefined;
    const row = this.issuer('owner_id = ? AND connection_id = ? AND authority_version = ? AND retired = 0',
      [ownerId, connectionId, node.authority_version]);
    if (row && (row.node_id !== node.node_id || row.connector_url !== node.connector_url || row.kind !== node.kind)) {
      throw new Error('Execution issuer binding mismatch');
    }
    return row && { issuerId: row.issuer_id, nodeId: row.node_id, version: row.authority_version,
      ...(row.creation_allowed === 1 ? { creationAllowed: true as const } : {}) };
  }

  configure(ownerId: string, connectionId: string, token: string, authorize: () => void,
    local?: Local, signal?: AbortSignal, requireCreation = false) {
    const key = JSON.stringify([ownerId, connectionId]);
    if (this.abort.signal.aborted) return Promise.reject(new Error('Execution issuer setup closed'));
    if (this.configuring.has(key) || this.configuring.size >= 32) return Promise.reject(new Error('Execution issuer setup already busy'));
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const flight = Promise.resolve().then(() => this.configureVerified(ownerId, connectionId, token, authorize, local, combined, requireCreation))
      .finally(() => { this.configuring.delete(key); });
    this.configuring.set(key, flight);
    return flight;
  }

  stopAndDrain(): void | Promise<void> {
    this.abort.abort(new Error('Execution issuer setup closed'));
    if (!this.configuring.size) return;
    return this.closing ??= Promise.allSettled([...this.configuring.values()]).then(() => {});
  }

  close(): Promise<void> { return this.closing ??= this.stopAndDrain() ?? Promise.resolve(); }

  private async configureVerified(ownerId: string, connectionId: string, token: string, authorize: () => void,
    local?: Local, signal?: AbortSignal, requireCreation = false) {
    signal?.throwIfAborted();
    authorize();
    if (typeof token !== 'string' || !token.length || token.length > 4096 || /\s/.test(token)) throw new Error('Invalid issuer credential');
    const node = this.node(ownerId, connectionId);
    if (!node?.node_id) throw new Error('Verified enabled Connector required');
    const client = new ConnectorClient(node.connector_url, token, this.dispatch(node.kind, connectionId, local),
      10_000, 8192, { nodeId: node.node_id, authorize });
    const identity = await client.json<{ nodeId: string; hubId: string; issuerTokenId: string }>(
      '/execution-grants/issuer', signal ? { signal } : {});
    signal?.throwIfAborted();
    authorize();
    if (!identity || identity.nodeId !== node.node_id || identity.hubId !== this.hubId
      || typeof identity.issuerTokenId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(identity.issuerTokenId)) {
      throw new Error('Execution issuer binding mismatch');
    }
    let creationAllowed = false;
    try {
      const capability = await client.json<{ nodeId: string; hubId: string; issuerTokenId: string; creationAllowed: boolean }>(
        '/execution-grants/issuer/creation', signal ? { signal } : {});
      creationAllowed = capability.nodeId === node.node_id && capability.hubId === this.hubId
        && capability.issuerTokenId === identity.issuerTokenId && capability.creationAllowed === true;
    } catch {}
    signal?.throwIfAborted(); authorize();
    if (requireCreation && !creationAllowed) throw new Error('Creation capability could not be verified');
    return this.installConfiguration(ownerId, connectionId, token, {
      nodeId: node.node_id, version: node.authority_version, origin: node.connector_url, kind: node.kind,
    }, identity.issuerTokenId, creationAllowed);
  }

  configurationTarget(ownerId: string, connectionId: string): IssuerConfigurationTarget | undefined {
    const node = this.node(ownerId, connectionId);
    return node?.node_id ? { nodeId: node.node_id, version: node.authority_version,
      origin: node.connector_url, kind: node.kind } : undefined;
  }

  /** Private owner command only. Network receipts are checked by the original
   * executor; the sole owner rechecks the complete target and commits once. */
  installConfiguration(ownerId: string, connectionId: string, token: string, target: IssuerConfigurationTarget,
    issuerId: string, creationAllowed: boolean) {
    if (typeof token !== 'string' || !token.length || token.length > 4096 || /\s/.test(token)
      || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(issuerId)) throw new Error('Invalid issuer configuration');
    const current = this.configurationTarget(ownerId, connectionId);
    if (!current || current.nodeId !== target.nodeId || current.version !== target.version
      || current.origin !== target.origin || current.kind !== target.kind) throw new Error('Connector authority changed');
    // CAS and vault write share the policy transaction: failure cannot retire
    // working credentials, revoke leases, or leave a half-installed credential.
    observedSavepoint(this.db, 'execution-issuer-change', () => {
      if ((this.db.prepare('SELECT count(*) AS count FROM hub_execution_issuers').get() as { count: number }).count >= this.maxRows) {
        throw new Error('Execution issuer capacity reached');
      }
      const changed = this.db.prepare(`UPDATE env_connections SET authority_version = authority_version + 1
        WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL AND status <> 'disabled'
          AND authority_version = ? AND node_id = ?`)
        .run(ownerId, connectionId, target.version, target.nodeId);
      if (!changed.changes) throw new Error('Connector authority changed during issuer verification');
      const id = randomUUID();
      this.vault.write(id, token);
      this.db.prepare(`INSERT INTO hub_execution_issuers
        (id, owner_id, connection_id, node_id, issuer_id, authority_version, connector_url, kind, creation_allowed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, connectionId, target.nodeId,
        issuerId, target.version + 1, target.origin, target.kind, Number(creationAllowed));
      this.advanceOwnerBindings(ownerId, connectionId, target.version, target.version + 1);
    });
    return this.current(ownerId, connectionId)!;
  }

  /** Retired rows count: a late/unknown install ACK must not revoke an issuer
   * that was installed and then rotated before cleanup could observe it. */
  configurationWasInstalled(ownerId: string, connectionId: string, issuerId: string) {
    return !!this.db.prepare(`SELECT 1 FROM hub_execution_issuers
      WHERE owner_id = ? AND connection_id = ? AND issuer_id = ? LIMIT 1`).get(ownerId, connectionId, issuerId);
  }

  disable(ownerId: string, connectionId: string) {
    const current = this.current(ownerId, connectionId);
    if (!current) return false;
    // Existing node-generation triggers retire issuers and revoke leases in the
    // same SQLite statement. Historical credentials are deliberately retained.
    return observedSavepoint(this.db, 'execution-issuer-change', () => {
      const changed = !!this.db.prepare(`UPDATE env_connections SET authority_version = authority_version + 1
        WHERE owner_user_id = ? AND id = ? AND authority_version = ?`)
        .run(ownerId, connectionId, current.version).changes;
      if (changed) this.advanceOwnerBindings(ownerId, connectionId, current.version, current.version + 1);
      return changed;
    });
  }

  clientFor(lease: ExecutionLease, local?: Local) {
    return this.client(lease, local);
  }

  /** Private owner-channel snapshot for the exact original creation authority.
   * Never expose it through HTTP or diagnostics. Effects stay in ConnectorClient. */
  creationSnapshot(ownerId: string, connectionId: string, version: number): ExecutionIssuerSnapshot {
    const current = this.current(ownerId, connectionId);
    if (current?.version !== version || current.creationAllowed !== true) throw new Error('Creation issuer unavailable');
    const row = this.issuer(`owner_id = ? AND connection_id = ?
      AND authority_version = ? AND retired = 0 AND creation_allowed = 1`, [ownerId, connectionId, version]);
    const token = row && this.vault.read(row.id);
    if (!row || !token) throw new Error('Creation issuer unavailable');
    return { origin: row.connector_url, token, kind: row.kind, connectionId: row.connection_id,
      nodeId: row.node_id, issuerId: row.issuer_id, version: row.authority_version };
  }

  creationClient(ownerId: string, connectionId: string, version: number, authorize: () => void, local?: Local) {
    authorize();
    const current = this.current(ownerId, connectionId);
    if (current?.version !== version || current.creationAllowed !== true) throw new Error('Creation issuer unavailable');
    const row = this.issuer(`owner_id = ? AND connection_id = ?
      AND authority_version = ? AND retired = 0 AND creation_allowed = 1`, [ownerId, connectionId, version]);
    const token = row && this.vault.read(row.id);
    if (!row || !token) throw new Error('Creation issuer unavailable');
    return new ConnectorClient(row.connector_url, token, this.dispatch(row.kind, connectionId, local), 30_000, 128 * 1024, {
      nodeId: row.node_id, authorize,
      request: (path, method) => {
        authorize();
        const current = this.current(ownerId, connectionId);
        if (current?.version !== version || current.creationAllowed !== true) throw new Error('Creation issuer retired');
        if (!(method === 'POST' && path === '/agents/codex/sessions')
          && !(method === 'GET' && /^\/agents\/codex\/sessions\/creation-commands\/[A-Za-z0-9._:-]{1,200}$/.test(path))) {
          throw new Error('Creation issuer is restricted to Codex creation and receipts');
        }
      },
    });
  }

  // A historical credential gets one exact read, never a general-purpose
  // proxy. The trusted caller resolves lease/key from its persisted receipt.
  /** Internal single-owner read. Never expose this credential snapshot through HTTP. */
  snapshotFor(lease: ExecutionLease): ExecutionIssuerSnapshot {
    const where = 'owner_id = ? AND connection_id = ? AND authority_version = ? AND node_id = ? AND issuer_id = ?';
    const args = [lease.proof.ownerUserId, lease.proof.connectionId, lease.proof.nodeVersion, lease.nodeId, lease.issuerId];
    const row = this.issuer(where, args);
    if (!row) throw new Error('Execution issuer credential unavailable');
    const token = this.vault.read(row.id);
    if (!token) throw new Error('Execution issuer credential unavailable');
    return { origin: row.connector_url, token, kind: row.kind, connectionId: row.connection_id,
      nodeId: row.node_id, issuerId: row.issuer_id, version: row.authority_version };
  }

  protected client(lease: ExecutionLease, local?: Local, operation?: ExecutionEffectOperation) {
    const row = this.snapshotFor(lease);
    return new ConnectorClient(row.origin, row.token, this.dispatch(row.kind, row.connectionId, local), 10_000, operation ? 128 * 1024 : 8192, {
      nodeId: row.nodeId,
      ...(operation ? { authorize: operation.authorize } : {}),
      request: (path, method) => {
        if (operation) {
          if (method !== operation.method || path !== operation.path) throw new Error('Issuer client is restricted to one command operation');
          if (method !== 'GET' && this.current(lease.proof.ownerUserId, row.connectionId)?.version !== row.version) throw new Error('Execution issuer retired');
          return;
        }
        if (method !== 'POST' || !['/execution-grants', '/execution-grants/revoke', '/execution-grants/usage'].includes(path)) {
          throw new Error('Issuer client is restricted to lease synchronization');
        }
        if (path !== '/execution-grants/revoke' && this.current(lease.proof.ownerUserId, row.connectionId)?.version !== row.version) {
          throw new Error('Execution issuer retired');
        }
      },
    });
  }

  private issuer(where: string, args: Array<string | number>) {
    const row = this.db.prepare(`SELECT ${issuerColumns} FROM hub_execution_issuers WHERE ${where}`).get(...args) as IssuerRow | undefined;
    if (row && (typeof row.id !== 'string' || typeof row.connection_id !== 'string' || !isNodeId(row.node_id)
      || typeof row.issuer_id !== 'string' || typeof row.connector_url !== 'string' || !['local', 'remote'].includes(row.kind)
      || !Number.isSafeInteger(row.authority_version) || row.authority_version < 1
      || ![0, 1].includes(row.retired) || ![0, 1].includes(row.creation_allowed))) {
      throw new Error('Execution issuer credential unavailable');
    }
    return row;
  }

  private node(ownerId: string, connectionId: string) {
    const row = this.db.prepare(`SELECT ${boundedText('node_id', 128)}, ${boundedVersion},
      ${boundedText('connector_url', 4096)}, ${boundedText('kind', 6)}, node_id IS NULL AS unpinned FROM env_connections
      WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL AND status <> 'disabled'`)
      .get(ownerId, connectionId) as (NodeRow & { unpinned: number }) | undefined;
    if (!row || row.unpinned === 1) return undefined;
    if (!isNodeId(row.node_id) || !Number.isSafeInteger(row.authority_version) || row.authority_version < 1
      || typeof row.connector_url !== 'string' || !['local', 'remote'].includes(row.kind)) {
      throw new Error('Execution issuer Connector unavailable');
    }
    return row;
  }

  private hasTable(name: string) {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  private advanceOwnerBindings(ownerId: string, connectionId: string, fromVersion: number, toVersion: number) {
    if (this.hasTable('hub_workspace_board_file_bindings')) {
      const resources = (this.db.prepare(`SELECT DISTINCT resource_id AS resourceId
        FROM hub_workspace_board_file_bindings
        WHERE user_id = ? AND connection_id = ? AND authority = ? AND state != 'revoked'`)
        .all(ownerId, connectionId, fromVersion) as Array<{ resourceId: string }>);
      if (resources.length) {
        this.db.prepare(`UPDATE hub_workspace_board_file_bindings SET authority = ?
          WHERE user_id = ? AND connection_id = ? AND authority = ? AND state != 'revoked'`)
          .run(toVersion, ownerId, connectionId, fromVersion);
        if (this.hasTable('hub_workspace_board_file_versions')) {
          const bump = this.db.prepare(`INSERT INTO hub_workspace_board_file_versions VALUES (?, ?, 1)
            ON CONFLICT(user_id, resource_id) DO UPDATE SET revision = revision + 1`);
          for (const row of resources) bump.run(ownerId, row.resourceId);
        }
      }
    }
    if (this.hasTable('hub_workspace_card_file_bindings')) {
      const resources = (this.db.prepare(`SELECT DISTINCT resource_id AS resourceId
        FROM hub_workspace_card_file_bindings
        WHERE user_id = ? AND connection_id = ? AND authority = ? AND state != 'revoked'`)
        .all(ownerId, connectionId, fromVersion) as Array<{ resourceId: string }>);
      if (resources.length) {
        this.db.prepare(`UPDATE hub_workspace_card_file_bindings SET authority = ?
          WHERE user_id = ? AND connection_id = ? AND authority = ? AND state != 'revoked'`)
          .run(toVersion, ownerId, connectionId, fromVersion);
        if (this.hasTable('hub_workspace_card_file_versions')) {
          const bump = this.db.prepare(`INSERT INTO hub_workspace_card_file_versions VALUES (?, ?, 1)
            ON CONFLICT(user_id, resource_id) DO UPDATE SET revision = revision + 1`);
          for (const row of resources) bump.run(ownerId, row.resourceId);
        }
      }
    }
    if (this.hasTable('hub_board_bindings')) {
      this.db.prepare(`UPDATE hub_board_bindings SET authority = ?
        WHERE owner = ? AND connection_id = ? AND authority = ? AND state != 'revoked'`)
        .run(toVersion, ownerId, connectionId, fromVersion);
    }
  }

  private dispatch(kind: 'local' | 'remote', connectionId: string, local?: Local) {
    if (kind === 'remote') return undefined;
    if (!local || connectionId !== local.connectionId) throw new Error('Local issuer transport unavailable');
    return local.dispatch;
  }
}

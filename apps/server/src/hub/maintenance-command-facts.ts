import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CommandConflict, type CommandReceipts, type CommandReceipt } from '../commands/receipts.js';
import { isNodeId } from '../connector/node-identity.js';
import type { MaintenanceTarget } from './maintenance-commands.js';

type Binding = MaintenanceTarget & { version: 1; nodeId: string; kind: 'local' | 'remote'; origin: string; authority: number };
type Connection = { node_id: string | null; kind: 'local' | 'remote'; connector_url: string; authority_version: number };
export type MaintenanceVault = { current: (connectionId: string, ownerId: string) => string | undefined;
  read: (receiptId: string) => string | undefined; write: (receiptId: string, token: string) => void };
/** Private owner-channel descriptor. Local tokens and dispatch NEVER cross this channel. */
export type MaintenanceEffect = { kind: 'local' | 'remote'; nodeId: string; origin: string;
  credential?: string; delivery: string; digest: string };
export class MaintenanceAuthorityUnavailable extends Error {
  constructor(readonly status: 403 | 404 | 409 | 503 = 503, message = 'Original maintenance authority unavailable') { super(message); }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const maintenanceBoundary = (target: Pick<MaintenanceTarget, 'operation'>) => ['pause', 'resume'].includes(target.operation) ? 'maintenance' : 'update';
export function validMaintenancePayload(operation: MaintenanceTarget['operation'], value: unknown): value is Record<string, unknown> {
  const fields = operation === 'apply' ? ['version', 'revision', 'manifestSha256'] : operation === 'resume' ? ['fenceId'] : [];
  const segment = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9._-]+$/.test(v) && !v.includes('..');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 8192
    || Object.keys(value).some(k => !fields.includes(k))) return false;
  const v = value as Record<string, unknown>;
  return operation === 'apply' ? segment(v.version) && (v.revision === undefined || segment(v.revision))
    && typeof v.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(v.manifestSha256)
    : operation !== 'resume' || typeof v.fenceId === 'string' && /^[a-f0-9-]{36}$/.test(v.fenceId);
}

/** Original receipt, immutable provenance and encrypted vault, in ONE database.
 * No HTTP, dispatch callback, synthetic principal or second intent table. */
export class HubMaintenanceCommandFacts {
  constructor(private readonly db: DatabaseSync, private readonly receipts: CommandReceipts,
    private readonly vault: MaintenanceVault, private readonly localConnectionId?: string) {}
  scope(target: MaintenanceTarget) {
    if (!['apply', 'rollback', 'pause', 'resume'].includes(target.operation) || [target.userId, target.ownerUserId, target.connectionId]
      .some(v => typeof v !== 'string' || !v || v.includes('\0') || Buffer.byteLength(v) > 512)) throw new CommandConflict('Invalid maintenance target');
    return JSON.stringify([maintenanceBoundary(target), JSON.stringify([target.userId, target.ownerUserId, target.connectionId, target.operation])]);
  }
  private current(target: MaintenanceTarget) {
    return this.db.prepare(`SELECT node_id, kind, connector_url, authority_version FROM env_connections
      WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL AND status <> 'disabled'`)
      .get(target.connectionId, target.ownerUserId) as Connection | undefined;
  }
  get(target: MaintenanceTarget, key: string) { return this.receipts.get(this.scope(target), key); }
  prepare(target: MaintenanceTarget): string | null {
    this.scope(target);
    const current = this.current(target);
    return current ? digest([current, this.vault.current(target.connectionId, target.ownerUserId)]) : null;
  }
  claim(target: MaintenanceTarget, key: string, payload: Record<string, unknown>, pin: string | null,
    authorize: () => void, localConnectionId: string | null | undefined = this.localConnectionId) {
    if (!validMaintenancePayload(target.operation, payload)) throw new CommandConflict('Invalid maintenance payload');
    const scope = this.scope(target);
    const check = () => {
      authorize();
      if (this.receipts.get(scope, key)) return;
      const current = this.current(target);
      if (!current) throw new MaintenanceAuthorityUnavailable(404, 'Verified maintenance target unavailable');
      if (!isNodeId(current.node_id)) throw new MaintenanceAuthorityUnavailable(409, 'Verified maintenance node required');
      if (!pin || this.prepare(target) !== pin) throw new MaintenanceAuthorityUnavailable();
    };
    return this.receipts.claimAsync(scope, key, payload, true, undefined, undefined, id => {
      check();
      const connection = this.current(target)!;
      if (connection.kind === 'local' && (target.ownerUserId !== 'default' || localConnectionId !== target.connectionId)) throw new MaintenanceAuthorityUnavailable(503, 'Local maintenance runtime unavailable');
      const token = connection.kind === 'remote' ? this.vault.current(target.connectionId, target.ownerUserId) : undefined;
      if (connection.kind === 'remote' && (!token || Buffer.byteLength(token) > 8192)) throw new MaintenanceAuthorityUnavailable(503, 'Maintenance credential unavailable');
      if (token) this.vault.write(id, token);
      const metadata: Binding = { ...target, version: 1, nodeId: connection.node_id!, kind: connection.kind,
        origin: connection.connector_url, authority: connection.authority_version };
      return { metadata, retainedBytes: token ? Buffer.byteLength(token) * 2 + 1024 : 0 };
    }, false, check, check);
  }
  private binding(target: MaintenanceTarget, key: string): Binding | undefined {
    const v = this.receipts.binding(this.scope(target), key);
    if (!v || v.version !== 1 || v.userId !== target.userId || v.ownerUserId !== target.ownerUserId
      || v.connectionId !== target.connectionId || v.operation !== target.operation || !isNodeId(v.nodeId)
      || !['local', 'remote'].includes(String(v.kind)) || typeof v.origin !== 'string'
      || !Number.isSafeInteger(v.authority) || Number(v.authority) < 1) return undefined;
    return v as Binding;
  }
  effect(target: MaintenanceTarget, key: string, write: boolean, localConnectionId: string | null | undefined = this.localConnectionId): MaintenanceEffect {
    const scope = this.scope(target), receipt = this.receipts.get(scope, key), binding = this.binding(target, key);
    if (!receipt || !binding) throw new MaintenanceAuthorityUnavailable();
    const token = binding.kind === 'remote' ? this.vault.read(receipt.id) : undefined;
    if (binding.kind === 'local' ? binding.ownerUserId !== 'default' || binding.connectionId !== localConnectionId : !token) throw new MaintenanceAuthorityUnavailable();
    if (write) {
      const current = this.current(target);
      if (!current || current.node_id !== binding.nodeId || current.authority_version !== binding.authority
        || current.kind !== binding.kind || current.connector_url !== binding.origin
        || binding.kind === 'remote' && this.vault.current(target.connectionId, target.ownerUserId) !== token) throw new MaintenanceAuthorityUnavailable();
    }
    const delivery = this.receipts.deliveryKey(scope, key);
    return { kind: binding.kind, nodeId: binding.nodeId, origin: binding.origin, ...(token ? { credential: token } : {}),
      delivery, digest: digest([binding, token, delivery]) };
  }
  observed(target: MaintenanceTarget, key: string, upstream: CommandReceipt) {
    // Settlement is still the original exact delivery-key/status/state rule.
    return this.receipts.settleFromReceipt(this.scope(target), key, upstream);
  }
}

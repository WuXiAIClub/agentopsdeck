import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConnectorLifecycleJob, ConnectorLifecycleReceipt } from '@agentopsdeck/shared';
import { CommandConflict, type CommandReceipts } from '../commands/receipts.js';
import { validMaintenanceJob, type MaintenanceJob } from '../lifecycle/connector-maintenance.js';
import { parseLifecycleEndpoints, type LifecycleEndpoint, type LifecycleStatus } from './lifecycle-client.js';

export type LifecycleTarget = { userId: string; connectionId: string; operation: 'restart' | 'upgrade' };
type Connection = { node_id: string | null; connector_url: string; authority_version: number; kind: string };
type Binding = LifecycleTarget & { version: 1; nodeId: string; origin: string; connectorOrigin: string; authority: number };
type Vault = { current: (connection: string, owner: string) => string | undefined;
  read: (receipt: string) => string | undefined; write: (receipt: string, credential: string) => void };
/** Private worker-channel descriptor, never an HTTP response or diagnostic. */
export type LifecycleEffect = { nodeId: string; origin: string; credential: string; digest: string; delivery?: string };
export class LifecycleAuthorityUnavailable extends Error {
  constructor() { super('Independent Connector maintenance unavailable'); }
}
export const lifecycleUnavailable = () => new LifecycleAuthorityUnavailable();
export const lifecycleDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const lifecyclePublicJob = (job: MaintenanceJob): ConnectorLifecycleJob => {
  if (job.operation === 'recover' || job.stage === 'recover') throw lifecycleUnavailable();
  return { id: job.id, nodeId: job.nodeId, operation: job.operation, stage: job.stage,
    createdAt: job.createdAt, deadline: job.deadline, revision: job.revision, ...(job.reason ? { reason: job.reason } : {}) };
};
export function lifecyclePublicStatus(status: LifecycleStatus) {
  const operations = status.operations.map(operation => {
    if (operation === 'recover') throw lifecycleUnavailable();
    return operation;
  });
  return { configured: true as const, nodeId: status.nodeId, operations, blocked: status.blocked,
    automaticUpdates: false as const, workerState: status.workerState, ...(status.job ? { job: lifecyclePublicJob(status.job) } : {}) };
}

/** Original receipt scope, immutable binding and vault in their ONE database.
 * Shared by the original executor and fixed worker domain; no network here. */
export class HubLifecycleCommandFacts {
  private readonly endpoints: LifecycleEndpoint[];
  constructor(private readonly db: DatabaseSync, private readonly receipts: CommandReceipts,
    private readonly vault: Vault, endpoints: readonly LifecycleEndpoint[] = []) {
    this.endpoints = parseLifecycleEndpoints(JSON.stringify(endpoints));
  }
  private current(userId: string, connectionId: string) {
    return this.db.prepare(`SELECT node_id, connector_url, authority_version, kind FROM env_connections
      WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL AND status <> 'disabled'`)
      .get(connectionId, userId) as Connection | undefined;
  }
  private endpoint(userId: string, connectionId: string) {
    return this.endpoints.find(endpoint => endpoint.ownerUserId === userId && endpoint.connectionId === connectionId);
  }
  scope(target: LifecycleTarget) {
    if (!['restart', 'upgrade'].includes(target.operation) || [target.userId, target.connectionId]
      .some(value => typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value))) throw new CommandConflict('Invalid lifecycle target');
    return JSON.stringify(['lifecycle', JSON.stringify([target.userId, target.connectionId, target.operation])]);
  }
  get(target: LifecycleTarget, key: string) { return this.receipts.get(this.scope(target), key); }
  prepare(target: LifecycleTarget): string | null {
    this.scope(target);
    const connection = this.current(target.userId, target.connectionId);
    return connection ? lifecycleDigest([connection, this.vault.current(target.connectionId, target.userId)]) : null;
  }
  claim(target: LifecycleTarget, key: string, expected: string | null, authorize: () => void) {
    const scope = this.scope(target);
    const check = () => {
      authorize();
      // Historical reads need no new connection/endpoint/credential authority.
      if (!this.receipts.get(scope, key) && (!expected || this.prepare(target) !== expected)) throw lifecycleUnavailable();
    };
    return this.receipts.claimAsync(scope, key, { operation: target.operation }, true, undefined, undefined, id => {
      authorize();
      const connection = this.current(target.userId, target.connectionId), endpoint = this.endpoint(target.userId, target.connectionId);
      const token = this.vault.current(target.connectionId, target.userId);
      if (!connection || connection.kind !== 'remote' || !endpoint || connection.node_id !== endpoint.nodeId || !token || token.length > 8192) throw lifecycleUnavailable();
      this.vault.write(id, token);
      const metadata: Binding = { ...target, version: 1, nodeId: endpoint.nodeId, origin: endpoint.origin,
        connectorOrigin: connection.connector_url, authority: connection.authority_version };
      return { metadata, retainedBytes: Buffer.byteLength(token) * 2 + 1024 };
    }, false, check, check);
  }
  status(userId: string, connectionId: string): LifecycleEffect | null {
    const endpoint = this.endpoint(userId, connectionId);
    if (!endpoint) return null;
    const connection = this.current(userId, connectionId), credential = this.vault.current(connectionId, userId);
    if (!connection || connection.kind !== 'remote' || connection.node_id !== endpoint.nodeId || !credential) throw lifecycleUnavailable();
    return { nodeId: endpoint.nodeId, origin: endpoint.origin, credential,
      digest: lifecycleDigest([connection, endpoint, credential]) };
  }
  effect(target: LifecycleTarget, key: string, write: boolean): LifecycleEffect {
    const scope = this.scope(target), receipt = this.receipts.get(scope, key), value = this.receipts.binding(scope, key);
    if (!receipt || !value || value.version !== 1 || value.userId !== target.userId || value.connectionId !== target.connectionId
      || value.operation !== target.operation || typeof value.nodeId !== 'string' || typeof value.origin !== 'string'
      || typeof value.connectorOrigin !== 'string' || !Number.isSafeInteger(value.authority)) throw lifecycleUnavailable();
    const binding = value as Binding, credential = this.vault.read(receipt.id);
    if (!credential) throw lifecycleUnavailable();
    if (write) {
      const current = this.current(target.userId, target.connectionId), endpoint = this.endpoint(target.userId, target.connectionId);
      if (!current || current.kind !== 'remote' || current.node_id !== binding.nodeId || current.authority_version !== binding.authority
        || current.connector_url !== binding.connectorOrigin || endpoint?.nodeId !== binding.nodeId || endpoint.origin !== binding.origin
        || this.vault.current(target.connectionId, target.userId) !== credential) throw lifecycleUnavailable();
    }
    const delivery = this.receipts.deliveryKey(scope, key);
    return { nodeId: binding.nodeId, origin: binding.origin, credential, delivery,
      digest: lifecycleDigest([binding, credential, delivery, write]) };
  }
  observed(target: LifecycleTarget, key: string, job: MaintenanceJob): ConnectorLifecycleReceipt {
    const effect = this.effect(target, key, false);
    // Bind untrusted ACKs again inside the owner, not just at the network client.
    if (!validMaintenanceJob(job) || job.nodeId !== effect.nodeId || job.operation !== target.operation
      || job.id !== `maintenance:${lifecycleDigest([effect.nodeId, job.actorId, effect.delivery])}`) throw lifecycleUnavailable();
    const publicValue = lifecyclePublicJob(job);
    const command = this.receipts.settle(this.scope(target), key, { status: 202, body: { lifecycle: publicValue } });
    return { command, job: publicValue, observationUnavailable: false };
  }
}

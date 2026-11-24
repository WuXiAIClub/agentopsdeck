import type { CommandQueueObservation, QueuedCommandPage } from '@agentopsdeck/shared';
import type { CommandReceipt } from '../commands/receipts.js';
import type { Dispatch } from '../connector/transport.js';
import { EXECUTION_GRANT_HEADER } from '../connector/execution-authority.js';
import type { ConnectorClient } from './connector-client.js';
import type { ExecutionLease } from './execution-leases.js';

export type ExecutionEffectAuthorize = () => void | Promise<void>;
export type ExecutionEffectLocal = { connectionId: string; dispatch: Dispatch };
type Local = ExecutionEffectLocal;
export type ExecutionEffectOperation = { path: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; authorize: ExecutionEffectAuthorize };

/** Original wire contract, shared by both composition paths. No SQL or generic
 * proxy. The concrete owner must pin the one operation and historical issuer. */
export abstract class HubExecutionEffects {
  protected abstract client(lease: ExecutionLease, local?: ExecutionEffectLocal,
    operation?: ExecutionEffectOperation): ConnectorClient | Promise<ConnectorClient>;

  async receiptFor(lease: ExecutionLease, key: string, authorize: ExecutionEffectAuthorize, local?: Local, signal?: AbortSignal) {
    await authorize();
    if (!lease.ref || !lease.proof.resource.sessionKey || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
      throw new Error('Historical command authority unavailable');
    }
    const path = `/sessions/${encodeURIComponent(lease.proof.resource.sessionKey)}/commands/${encodeURIComponent(key)}`;
    const client = await this.client(lease, local, { path, method: 'GET', authorize });
    const result = await client.jsonOriginal<{ command: CommandReceipt }>(path, {
      headers: { [EXECUTION_GRANT_HEADER]: lease.ref.id }, ...(signal ? { signal } : {}),
    });
    return result.command;
  }

  async queueFor(lease: ExecutionLease, key: string, authorize: ExecutionEffectAuthorize, local?: Local, signal?: AbortSignal): Promise<CommandQueueObservation> {
    await authorize();
    if (!lease.ref || !lease.proof.resource.sessionKey || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new Error('Historical command authority unavailable');
    const path = `/sessions/${encodeURIComponent(lease.proof.resource.sessionKey)}/commands/${encodeURIComponent(key)}/queue`;
    const result = await (await this.client(lease, local, { path, method: 'GET', authorize })).jsonOriginal<{ commandKey?: unknown; queue?: Partial<CommandQueueObservation> }>(path, {
      headers: { [EXECUTION_GRANT_HEADER]: lease.ref.id }, ...(signal ? { signal } : {}),
    });
    if (result.commandKey !== key) throw new Error('Invalid command queue identity');
    const queue = result.queue;
    if (queue?.presence === 'absent' || queue?.presence === 'unknown') return { presence: queue.presence };
    if (queue?.presence !== 'present' || !['queued', 'dispatching', 'outcome_unknown', 'blocked'].includes(queue.state ?? '')
      || !Number.isSafeInteger(queue.createdAt) || queue.createdAt! < 0) throw new Error('Invalid command queue observation');
    if (queue.version !== undefined && (typeof queue.version !== 'string' || !/^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(queue.version))) {
      throw new Error('Invalid command queue version');
    }
    // Never forward upstream payload/actor/credential fields or delivery IDs.
    return { presence: 'present', state: queue.state!, createdAt: queue.createdAt!, ...(queue.version !== undefined ? { version: queue.version } : {}) };
  }

  async messageFor(lease: ExecutionLease, key: string, payload: Record<string, unknown>, authorize: ExecutionEffectAuthorize,
    local?: Local, signal?: AbortSignal): Promise<CommandReceipt | undefined> {
    await authorize();
    if (!lease.ref || !lease.proof.resource.sessionKey || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new Error('Execution command authority unavailable');
    const path = `/sessions/${encodeURIComponent(lease.proof.resource.sessionKey)}/messages`;
    const client = await this.client(lease, local, { path, method: 'POST', authorize });
    const result = await client.jsonResponseOriginal<Record<string, unknown>>(path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, [EXECUTION_GRANT_HEADER]: lease.ref.id },
      body: JSON.stringify({ ...payload, idempotencyKey: key }), ...(signal ? { signal } : {}) });
    if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) return undefined;
    const { command, ...body } = result.body;
    if (!command || typeof command !== 'object' || Array.isArray(command)) return undefined;
    // Connector POST returns receipt metadata alongside the result body. Keep
    // the same coherent-key/state validation as historical GET recovery.
    return { ...command as CommandReceipt, result: { status: result.status, body } };
  }

  async queueMutationFor(lease: ExecutionLease, commandKey: string, mutationKey: string,
    change: { method: 'PATCH' | 'DELETE'; version: string; text: string } | undefined,
    authorize: ExecutionEffectAuthorize, local?: Local, signal?: AbortSignal): Promise<CommandReceipt | undefined> {
    await authorize();
    if (!lease.ref || !lease.proof.resource.sessionKey || ![commandKey, mutationKey].every(key => /^[A-Za-z0-9._:-]{1,200}$/.test(key))) {
      throw new Error('Historical queue command authority unavailable');
    }
    const base = `/sessions/${encodeURIComponent(lease.proof.resource.sessionKey)}/commands/${encodeURIComponent(commandKey)}/queue`;
    const path = change ? base : `${base}/commands/${encodeURIComponent(mutationKey)}`, method = change?.method ?? 'GET';
    const headers = { [EXECUTION_GRANT_HEADER]: lease.ref.id, ...(change ? {
      'idempotency-key': mutationKey, 'if-match': JSON.stringify(change.version), 'content-type': 'application/json',
    } : {}) };
    const client = await this.client(lease, local, { path, method, authorize });
    if (!change) return (await client.jsonOriginal<{ command?: CommandReceipt }>(path, { headers, ...(signal ? { signal } : {}) })).command;
    const result = await client.jsonResponseOriginal<{ ok?: boolean; command?: CommandReceipt }>(path, { method, headers,
      ...(method === 'PATCH' ? { body: JSON.stringify({ message: change.text }) } : {}), ...(signal ? { signal } : {}) });
    return result.body.command ? { ...result.body.command, result: { status: result.status, body: { ok: result.body.ok } } } : undefined;
  }

  async queuePageFor(lease: ExecutionLease, cursor: string, authorize: ExecutionEffectAuthorize, local?: Local, signal?: AbortSignal): Promise<QueuedCommandPage> {
    await authorize();
    if (!lease.ref || !lease.proof.resource.sessionKey || !/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new Error('Invalid queue page authority');
    const path = `/sessions/${encodeURIComponent(lease.proof.resource.sessionKey)}/queue/commands?cursor=${cursor}`;
    const result = await (await this.client(lease, local, { path, method: 'GET', authorize })).jsonOriginal<QueuedCommandPage>(path, {
      headers: { [EXECUTION_GRANT_HEADER]: lease.ref.id }, ...(signal ? { signal } : {}),
    });
    if (!result || !Array.isArray(result.items) || result.items.length > 64) throw new Error('Invalid queue page');
    let previous = Number(cursor);
    const keys = new Set<string>();
    const items = result.items.map(item => {
      if (!item || (item.commandKey !== null && (typeof item.commandKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(item.commandKey)))
        || !['queued', 'dispatching', 'outcome_unknown', 'blocked'].includes(item.state)
        || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || typeof item.version !== 'string'
        || !/^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(item.version)) throw new Error('Invalid queue page item');
      const sequence = Number(item.version.split(':')[0]);
      if (!Number.isSafeInteger(sequence) || sequence <= previous) throw new Error('Invalid queue page order');
      if (item.commandKey !== null) {
        if (keys.has(item.commandKey)) throw new Error('Duplicate queue command');
        keys.add(item.commandKey);
      }
      previous = sequence;
      return { commandKey: item.commandKey, state: item.state, createdAt: item.createdAt, version: item.version };
    });
    if (result.nextCursor !== null && (items.length !== 64 || result.nextCursor !== String(previous))) throw new Error('Invalid queue page cursor');
    return { items, nextCursor: result.nextCursor };
  }

}

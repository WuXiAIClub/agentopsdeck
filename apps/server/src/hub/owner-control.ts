import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { CommandReceipt } from '../commands/receipts.js';
import { decodeHubSessionId, encodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import type { HubStore } from './hub-store.js';
import type { ConnectorClientResolver } from './connector-client.js';
import { readSessionSettingsResult } from '@agentopsdeck/shared';
import { requestConnectorClient } from './request-connector-client.js';
import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import type { AsyncHubOwnerControls } from './async-owner-control.js';
import type { Awaitable } from '../auth/route-persistence.js';
import type { OwnerControlTarget } from './member-owner-control-domain.js';
import type { ConnectorClient } from './connector-client.js';
import { HubMemberRequestError } from './async-member-request.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { weixinRequestBinding } from './weixin-bridge.js';

export type OwnerControlPort = {
  owner: string; session: ReturnType<typeof decodeHubSessionId>; authority: number; nodeId: string | undefined;
  scope: string; upstream: string;
  check(): Awaitable<void>; bound(key: string): Awaitable<void>;
  get(key: string): Awaitable<CommandReceipt | undefined>; deliveryKey(key: string): Awaitable<string>;
  client(): Promise<OwnerControlClient>; claim(key: string, payload: unknown): Promise<{ fresh: boolean; receipt: CommandReceipt }>;
  settle(key: string, receipt: CommandReceipt | undefined): Awaitable<CommandReceipt>; recover(key: string): Promise<CommandReceipt>;
  cleanup(key: string): Awaitable<void>;
};
export type OwnerControlClient = Pick<ConnectorClient, 'json' | 'jsonResponse' | 'weixinActionOriginal'>;
export type AsyncOwnerControlPort = Pick<AsyncHubOwnerControls, 'open'> & Partial<Pick<AsyncHubOwnerControls, 'close'>>;
export type OwnerControlRequestDeps = (Parameters<typeof ownerControl>[1] & {
  mode?: 'legacy';
  asyncOwnerControl?: AsyncOwnerControlPort;
  internalRequests?: Pick<WeakMap<Request, unknown>, 'has'>;
}) | {
  mode: 'async'; controls: Pick<AsyncHubOwnerControls, 'openCurrent'>;
  store?: never; client?: never; owner?: never; asyncOwnerControl?: never; internalRequests?: never;
};
export type OwnerControlHttpDeps = OwnerControlRequestDeps & {
  error: (c: Context, error: unknown) => Response;
  diagnostics?: import('../diagnostics/performance.js').PerformanceDiagnostics;
};
export async function requestOwnerControl(c: Context, deps: OwnerControlRequestDeps,
  operation: OwnerControlTarget['operation']): Promise<OwnerControlPort> {
  // Private exact-Request membership selects the original internal actor.
  // This is not a header credential, clone capability or error fallback.
  if (deps.mode !== 'async' && (!deps.asyncOwnerControl || deps.internalRequests?.has(c.req.raw) && !weixinRequestBinding(c.req.raw))) return ownerControl(c, deps, operation);
  const sessionId = c.req.param('hubSessionId'), session = decodeHubSessionId(sessionId ?? ''), messageId = c.req.param('messageId');
  const target: OwnerControlTarget = operation === 'create'
    ? { operation, connectionId: c.req.param('connectionId')!, agentId: c.req.param('agentId')! }
    : { operation, connectionId: session?.connectionId ?? '', ...(sessionId ? { sessionId } : {}),
      ...(messageId ? { messageId } : {}) };
  try {
    const port = deps.mode === 'async' ? await deps.controls.openCurrent(c.req.raw, target)
      : await deps.asyncOwnerControl!.open(c.req.raw, deps.owner(c), target);
    // All async boundaries (not only opening) must preserve the HTTP status.
    // Never fall through to a legacy resolver after a failed worker operation.
    const wrap = <A extends unknown[], R>(fn: (...args: A) => Awaitable<R>) => async (...args: A): Promise<R> => {
      try {
        if (deps.mode !== 'async' && deps.owner(c) !== port.owner) throw new HubMemberRequestError(403);
        const value = await fn(...args);
        if (deps.mode !== 'async' && deps.owner(c) !== port.owner) throw new HubMemberRequestError(403);
        return value;
      }
      catch (error) {
        if (error instanceof HubMemberRequestError) throw new HTTPException(error.status as ContentfulStatusCode, { message: 'Control authority unavailable' });
        throw error;
      }
    };
    return { ...port, check: wrap(port.check), bound: wrap(port.bound), get: wrap(port.get),
      deliveryKey: wrap(port.deliveryKey), client: wrap(port.client), claim: wrap(port.claim),
      settle: wrap(port.settle), recover: wrap(port.recover), cleanup: wrap(port.cleanup) };
  }
  catch (error) {
    if (error instanceof HubMemberRequestError) throw new HTTPException(error.status as ContentfulStatusCode, { message: 'Control authority unavailable' });
    throw error; // Never downgrade a configured async port to the sync owner.
  }
}

// Owner controls reuse connection generations and bounded command receipts.
// This request-local binding is not a worker, lease or second control queue.
export function ownerControl(c: Context, deps: {
  store: HubStore; client: ConnectorClientResolver; owner: (c: Context) => string;
  asyncConnectorClient?: AsyncConnectorClientResolver;
}, operation: OwnerControlTarget['operation'], creation?: { connectionId: string; agentId: string }) {
  const receipts = deps.store.commands;
  const owner = deps.owner(c), sessionId = c.req.param('hubSessionId');
  const session = decodeHubSessionId(sessionId ?? '');
  const connectionId = operation === 'create' ? creation?.connectionId ?? c.req.param('connectionId') : session?.connectionId;
  const agentId = creation?.agentId ?? c.req.param('agentId');
  const connection = connectionId && deps.store.getConnection(connectionId, owner);
  const authority = connection && deps.store.connectionAuthority(connection.id, owner);
  if (!connection || connection.status === 'disabled' || !authority) throw new HTTPException(404, { message: 'Control target not found' });
  const scope = JSON.stringify(operation === 'message' ? [owner, sessionId] : operation === 'create'
    ? ['create', JSON.stringify(['owner-session-create-v1', owner, connectionId, agentId])]
    : operation === 'settings' ? ['settings', JSON.stringify(['owner-session-settings-v1', owner, sessionId])]
    : operation === 'compact' ? ['compact', JSON.stringify(['owner-session-compact-v1', owner, sessionId])]
    : operation === 'queue'
    ? ['owner-queue-mutation-v1', owner, sessionId, c.req.param('messageId')]
    : ['owner-session-delete-v1', owner, sessionId]);
  const upstream = operation === 'create' ? `/agents/${encodeURIComponent(agentId!)}/sessions`
    : `/sessions/${encodeURIComponent(session!.remoteSessionKey)}${operation === 'queue'
    ? `/queue${c.req.param('messageId') ? `/${encodeURIComponent(c.req.param('messageId')!)}` : ''}` : ''}`;
  const check = () => {
    if (deps.owner(c) !== owner || deps.store.connectionAuthority(connection.id, owner) !== authority) {
      throw new HTTPException(403, { message: 'Control authority changed' });
    }
  };
  const client = async () => {
    check();
    const result = await requestConnectorClient({ connectorClient: deps.client,
      ...(deps.asyncConnectorClient ? { asyncConnectorClient: deps.asyncConnectorClient } : {}) },
      c.req.raw, connection.id, false, owner);
    // Receipt authority was pinned before this wait. Opening a new generation
    // cannot migrate its old key or authorize a second native mutation.
    check();
    return result;
  };
  const bound = (key: string) => {
    check();
    // Here authority_id is an original connection generation, not a delegated
    // lease. Unknown receipts never migrate to a replacement node/credential.
    if (operation !== 'message' && receipts.authorityId(scope, key) !== authority) throw new HTTPException(409, { message: 'Control receipt belongs to an earlier node authority' });
  };
  const settle = (key: string, receipt: CommandReceipt | undefined) => {
    if (operation === 'message') return receipts.settleFromReceipt(scope, key, receipt);
    const result = receipt?.result;
    if (!result || !result.body || typeof result.body !== 'object') return receipts.get(scope, key)!;
    if (operation === 'compact' && receipt.state === 'accepted' && result.status === 200) {
      const { runId } = result.body;
      if (result.body.ok !== true || result.body.status !== 'compacting' || typeof runId !== 'string'
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)) return receipts.get(scope, key)!;
      return receipts.settleFromReceipt(scope, key, { ...receipt, result: { status: 200, body: { ok: true, status: 'compacting', runId } } });
    }
    if (operation === 'settings' && receipt.state === 'accepted' && result.status === 200) {
      const native = readSessionSettingsResult(result.body, session!.remoteSessionKey);
      return native ? receipts.settleFromReceipt(scope, key, { ...receipt, result: {
        status: 200, body: { ...native, sessionKey: sessionId },
      } }) : receipts.get(scope, key)!;
    }
    if (operation === 'create' && receipt.state === 'accepted' && result.status === 201) {
      const nativeKey = result.body.key;
      if (typeof nativeKey !== 'string' || !connection.nodeId) return receipts.get(scope, key)!;
      try {
        const body = { key: encodeHubSessionId(connection.id, nativeKey), remoteSessionKey: nativeKey, sessionRef: sessionRef(connection.nodeId, nativeKey) };
        return receipts.settleFromReceipt(scope, key, { ...receipt, result: { status: 201, body } });
      } catch { return receipts.get(scope, key)!; }
    }
    const safe = (operation === 'queue' || operation === 'delete') && receipt.state === 'accepted' && result.status === 200 && result.body.ok === true
      ? { status: 200, body: operation === 'queue' ? { ok: true } : { ok: true, status: 'delete_accepted' } }
      : receipt.state === 'rejected' && result.status >= 400 && result.status < 500
        ? { status: result.status, body: { error: operation === 'compact' ? 'Compaction rejected' : operation === 'queue' ? 'Queue mutation rejected' : operation === 'create' ? 'Creation rejected' : operation === 'settings' ? 'Settings rejected' : 'Deletion rejected' } } : undefined;
    return safe ? receipts.settleFromReceipt(scope, key, { ...receipt, result: safe }) : receipts.get(scope, key)!;
  };
  const recover = async (key: string) => {
    bound(key);
    const receipt = receipts.get(scope, key)!;
    if (receipt.state !== 'outcome_unknown') return receipt;
    try {
      const commandPath = operation === 'compact' ? 'compact-commands' : operation === 'queue' || operation === 'message' ? 'commands' : operation === 'create' ? 'creation-commands' : operation === 'settings' ? 'settings-commands' : 'deletion-commands';
      const body = await (await client()).json<{ command?: CommandReceipt }>(`${upstream}/${commandPath}/${encodeURIComponent(receipts.deliveryKey(scope, key))}`, { signal: c.req.raw.signal });
      bound(key);
      // Releasing starts is a separate audited fact on BOTH original nodes;
      // do not turn it into an ACK, persist a remote assertion, or replay PATCH.
      if (operation === 'settings' && body.command?.state === 'outcome_unknown'
        && body.command.settingsStartReleased === true
        && body.command.key === receipts.deliveryKey(scope, key)
        && typeof body.command.id === 'string' && body.command.id.length > 0 && body.command.id.length <= 200
        && receipts.settingsStartReleased(scope, key)) {
        return { ...receipt, settingsStartReleased: true as const };
      }
      return settle(key, body.command);
    } catch { bound(key); return receipts.get(scope, key)!; }
  };
  const claim = async (key: string, payload: unknown) => {
    const admissionCheck = () => { c.req.raw.signal.throwIfAborted(); check(); };
    const result = await receipts.claimAsync(scope, key, payload, true, operation === 'message' ? undefined : authority,
      undefined, undefined, false, admissionCheck, admissionCheck);
    // Promise delivery is another boundary; never carry admission authority
    // into dispatch after cancellation or a changed connection generation.
    admissionCheck();
    return result;
  };
  return { owner, session, authority, check, claim, nodeId: connection.nodeId, scope, upstream, client, bound, settle, recover,
    get: (key: string) => { check(); return receipts.get(scope, key); },
    deliveryKey: (key: string) => { bound(key); return receipts.deliveryKey(scope, key); },
    cleanup: (key: string) => { bound(key); if (receipts.get(scope, key)?.state === 'accepted') deps.store.removeSessionPreferences(sessionId!, owner); } };
}

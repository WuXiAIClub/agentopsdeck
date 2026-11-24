import { createHash } from 'node:crypto';
import type { SharedSessionAccessHints } from '@agentopsdeck/shared';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { isNodeId } from '../connector/node-identity.js';
import type { HubStore, HubDeliveryEvent } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { NodeAction, NodeGrantProof } from './node-grants.js';
import { validHubNodeGrantProof } from './member-connector-access-domain.js';
import { executeHubExecutionCommand, validHubExecutionCommand } from './member-execution-command-domain.js';
import { decodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import { resolveExplicitChannelRoute } from '../messages/channel-route.js';
import { validDeliveryPage, type DeliveryPage } from './delivery-reader-protocol.js';

export const HUB_SHARED_READ_BYTES = 128 * 1024;
export const HUB_SHARED_READ_RESULT_BYTES = 1024 * 1024;
type Target = { ownerUserId: string; sessionId: string };
type Permission = 'media:read' | 'events:read';
export type HubSharedReadCommand = { action: 'open'; target: Target }
  | ({ target: Target; read: NodeGrantProof } & (
    { action: 'check' } | { action: 'hints' } | { action: 'permission'; permission: Permission; proof?: NodeGrantProof }
    | { action: 'cursor'; events: NodeGrantProof }
    | { action: 'page'; events: NodeGrantProof; cursor: string | null; domain: string | null }));
type Data = { error: 403 | 404 | 409 }
  | { action: 'open'; userId: string; nodeId: string; read: NodeGrantProof; events: boolean }
  | { action: 'check'; ok: true }
  | { action: 'permission'; proof: NodeGrantProof }
  | { action: 'hints'; hints: SharedSessionAccessHints }
  | { action: 'cursor'; cursor: string | null }
  | { action: 'page'; page: Omit<DeliveryPage, 'cursor'> & { cursor: string | null } };
export type HubSharedReadResult = null | { binding: string; data: Data };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const cursor = (v: unknown): v is string | null => v === null || typeof v === 'string' && v.length <= 4096 && !/[\0\r\n]/.test(v);
export const hubSharedReadBinding = (c: HubSharedReadCommand) => createHash('sha256').update(JSON.stringify(c)).digest('hex');

export function validHubSharedReadCommand(v: unknown): v is HubSharedReadCommand {
  if (!object(v)) return false;
  if (v.action === 'open') return fields(v, ['action','target']) && validHubExecutionCommand(v);
  if (!validHubExecutionCommand({ action: 'check', target: v.target, read: v.read })) return false;
  const base = ['action','target','read'];
  if (v.action === 'check' || v.action === 'hints') return fields(v, base);
  if (v.action === 'permission') return fields(v, [...base, 'permission'], ['proof'])
    && ['media:read','events:read'].includes(String(v.permission))
    && (v.proof === undefined || validHubNodeGrantProof(v.proof) && v.proof.action === v.permission);
  if (!validHubNodeGrantProof(v.events) || v.events.action !== 'events:read') return false;
  if (v.action === 'cursor') return fields(v, [...base,'events']);
  return v.action === 'page' && fields(v, [...base,'events','cursor','domain']) && cursor(v.cursor) && cursor(v.domain);
}

/** Projection happens BEFORE data leaves SQL ownership, not just in the HTTP
 * renderer. No owner message payload, another session or workspace metadata
 * is a shared-stream result. The durable journal/cursor remains the original. */
export function sharedReadEvent(event: Omit<HubDeliveryEvent, 'id'> & { id?: string }, target: Target, nodeId: string) {
  const decoded = decodeHubSessionId(target.sessionId)!;
  if (event.envConnectionId !== decoded.connectionId) return undefined;
  if (!event.remoteSessionKey && ['stream.reset','stream.status'].includes(event.type)) {
    const payload = event.payload as { connection?: unknown } | undefined;
    return { type: event.type, ts: event.ts, sessionKey: target.sessionId,
      payload: event.type === 'stream.reset' ? { reason: 'source_changed' }
        : { connection: payload?.connection === 'unauthorized' ? 'unauthorized' : 'disconnected' } };
  }
  const ref = sessionRef(nodeId, decoded.remoteSessionKey)!;
  if (event.remoteSessionKey !== decoded.remoteSessionKey || event.sessionRef?.nodeId !== ref.nodeId
    || event.sessionRef.runtimeId !== ref.runtimeId || event.sessionRef.nativeSessionKey !== ref.nativeSessionKey) return undefined;
  return { type: 'session.invalidated', ts: event.ts, sessionKey: target.sessionId, sessionRef: ref,
    sourceCursor: event.remoteEventId, payload: { invalidation: true } };
}

function validData(v: unknown): v is Data {
  if (!object(v)) return false;
  if (fields(v, ['error'])) return [403,404,409].includes(Number(v.error)) && typeof v.error === 'number';
  if (v.action === 'open') return fields(v, ['action','userId','nodeId','read','events'])
    && typeof v.userId === 'string' && v.userId.length > 0 && v.userId.length <= 4096
    && isNodeId(v.nodeId) && validHubNodeGrantProof(v.read) && v.read.action === 'messages:read' && typeof v.events === 'boolean';
  if (v.action === 'check') return fields(v, ['action','ok']) && v.ok === true;
  if (v.action === 'permission') return fields(v, ['action','proof']) && validHubNodeGrantProof(v.proof)
    && ['media:read','events:read'].includes(v.proof.action);
  if (v.action === 'hints') return fields(v, ['action','hints']) && object(v.hints)
    && fields(v.hints, ['messagesSend','messagesMirror','eventsRead'], ['sessionsShare'])
    && Object.values(v.hints).every(x => typeof x === 'boolean');
  if (v.action === 'cursor') return fields(v, ['action','cursor']) && cursor(v.cursor);
  if (v.action !== 'page' || !fields(v, ['action','page']) || !object(v.page) || !cursor(v.page.cursor)
    || !validDeliveryPage({ ...v.page, cursor: v.page.cursor ?? undefined })) return false;
  return (v.page.events as HubDeliveryEvent[]).every(e => {
    if (!fields(e as unknown as Record<string, unknown>, ['id','envConnectionId','type','ts','payload'],
      ['remoteSessionKey','remoteEventId','sessionRef'])) return false;
    if (!object(e.payload)) return false;
    if (e.type === 'session.invalidated') return fields(e.payload, ['invalidation']) && e.payload.invalidation === true
      && typeof e.remoteSessionKey === 'string' && !!e.sessionRef && Object.keys(e.sessionRef).length === 3
      && isNodeId(e.sessionRef.nodeId) && (() => {
        try { const ref = sessionRef(e.sessionRef.nodeId, e.remoteSessionKey)!;
          return ref.runtimeId === e.sessionRef.runtimeId && ref.nativeSessionKey === e.sessionRef.nativeSessionKey;
        } catch { return false; }
      })();
    return !e.remoteSessionKey && !e.sessionRef && !e.remoteEventId && (e.type === 'stream.reset'
      ? fields(e.payload, ['reason']) && e.payload.reason === 'source_changed'
      : e.type === 'stream.status' && fields(e.payload, ['connection']) && ['unauthorized','disconnected'].includes(String(e.payload.connection)));
  });
}
export function validHubSharedReadResult(v: unknown): v is HubSharedReadResult {
  return v === null || object(v) && fields(v, ['binding','data']) && typeof v.binding === 'string'
    && /^[a-f0-9]{64}$/.test(v.binding) && validData(v.data);
}
export function validHubSharedReadReply(c: HubSharedReadCommand, v: unknown): v is HubSharedReadResult {
  if (!validHubSharedReadResult(v)) return false;
  if (!v) return true;
  if (v.binding !== hubSharedReadBinding(c)) return false;
  const data = v.data;
  if ('error' in data) return true;
  if (data.action !== c.action) return false;
  const d = decodeHubSessionId(c.target.sessionId)!;
  const proof = data.action === 'open' ? data.read : data.action === 'permission' ? data.proof : undefined;
  if (proof && (proof.ownerUserId !== c.target.ownerUserId || proof.connectionId !== d.connectionId
    || proof.resource.sessionKey !== d.remoteSessionKey || proof.resource.runtime !== sessionRuntimeId(d.remoteSessionKey)
    || (c.action !== 'open' && proof.userId !== c.read.userId))) return false;
  if (data.action === 'open') return data.read.userId === data.userId;
  if (data.action === 'permission') return c.action === 'permission' && data.proof.action === c.permission
    && (!c.proof || JSON.stringify(data.proof) === JSON.stringify(c.proof));
  if (data.action === 'page') return c.action === 'page' && data.page.events.every(e =>
    e.envConnectionId === d.connectionId && (!e.remoteSessionKey || e.remoteSessionKey === d.remoteSessionKey));
  return true;
}

/** Original identity savepoint owns every permission and projection. This
 * domain cannot dispatch execution or create a replacement authorization. */
export function executeHubSharedRead(owner: HubStore, actor: HubPrincipal, c: HubSharedReadCommand): HubSharedReadResult {
  if (!validHubSharedReadCommand(c)) throw Error('hub_shared_read_unavailable');
  const reply = (data: Data): Exclude<HubSharedReadResult, null> => ({ binding: hubSharedReadBinding(c), data });
  const access = executeHubExecutionCommand(owner, actor, c.action === 'open' ? c
    : { action: 'check', target: c.target, read: c.read });
  if ('error' in access) return reply({ error: access.error === 401 ? 403 : access.error });
  const decoded = decodeHubSessionId(c.target.sessionId)!;
  const connection = owner.getConnection(decoded.connectionId, c.target.ownerUserId)!;
  if (access.action === 'open') return reply({ action: 'open', userId: actor.userId, nodeId: access.nodeId,
    read: access.read, events: connection.capabilities.includes('events') });
  if (c.action === 'open') throw Error('hub_shared_read_unavailable');
  const resource = c.read.resource, policy = { userId: actor.userId, ownerUserId: c.target.ownerUserId,
    connectionId: connection.id, administrator: actor.admin };
  const validate = (p: NodeGrantProof, action: NodeAction) => p.action === action && p.userId === actor.userId
    && p.ownerUserId === policy.ownerUserId && p.connectionId === policy.connectionId && (!p.administrator || actor.admin)
    && p.resource.runtime === resource.runtime && p.resource.sessionKey === resource.sessionKey
    && p.resource.agentId === resource.agentId && owner.grants.revalidate(p);
  const authorize = (action: NodeAction) => owner.grants.authorize(policy, action, resource);
  if (c.action === 'check') return reply({ action: c.action, ok: true });
  if (c.action === 'permission') {
    const proof = c.proof ?? authorize(c.permission);
    return proof && validate(proof, c.permission) ? reply({ action: c.action, proof }) : reply({ error: 403 });
  }
  if (c.action === 'hints') {
    const send = authorize('messages:send'), share = authorize('sessions:share');
    const ref = sessionRef(connection.nodeId, decoded.remoteSessionKey)!;
    return reply({ action: c.action, hints: { messagesSend: !!send,
      messagesMirror: ref.runtimeId === 'openclaw' && !!resolveExplicitChannelRoute(decoded.remoteSessionKey, '')
        && !!send && owner.grants.revalidate({ ...send, action: 'messages:mirror' }),
      eventsRead: connection.capabilities.includes('events') && !!authorize('events:read'),
      ...(share ? { sessionsShare: owner.grants.ownedSession(share) } : {}) } });
  }
  if (!connection.capabilities.includes('events') || !validate(c.events, 'events:read')) return reply({ error: 403 });
  if (c.action === 'cursor') return reply({ action: c.action, cursor: owner.latestDeliveryCursor(c.target.ownerUserId) ?? null });
  const page = owner.deliveryPage(c.cursor ?? undefined, new Map(c.domain === null ? [] : [[connection.id, c.domain]]), c.target.ownerUserId);
  const events: HubDeliveryEvent[] = [];
  for (const event of page.events) {
    const projected = sharedReadEvent(event, c.target, connection.nodeId!);
    if (!projected) continue;
    events.push({ id: event.id, envConnectionId: connection.id, type: projected.type, ts: projected.ts, payload: projected.payload,
      ...(projected.type === 'session.invalidated' ? { remoteSessionKey: decoded.remoteSessionKey,
        ...(event.remoteEventId ? { remoteEventId: event.remoteEventId } : {}), sessionRef: sessionRef(connection.nodeId, decoded.remoteSessionKey)! } : {}) });
  }
  return reply({ action: c.action, page: { ...page, cursor: page.cursor ?? null, events } });
}

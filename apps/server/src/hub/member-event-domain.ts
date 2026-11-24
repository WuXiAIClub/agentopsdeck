import type { HubStore, HubDeliveryEvent } from './hub-store.js';
import type { HubMemberEvidence } from './member-owner-domain.js';
import { types } from 'node:util';
import { isAgentRuntimeId } from '@agentopsdeck/shared';
import { isNodeId } from '../connector/node-identity.js';
import { sessionRef } from './session-ref.js';
import { encodeHubSessionId } from './session-id.js';

// Internal typed owner commands only, not an HTTP event-writing capability.
// Original credentials/scope and durable connection generation are rechecked;
// no caller-supplied principal or `authorized: true` is accepted.
export const HUB_EVENT_RPC_BYTES = 768 * 1024;
export const HUB_EVENT_RPC_NODES = 256 * 1024;
/** Event payloads originate in JSON, not the smaller member settings protocol.
 * An iterative descriptor-only encoder keeps the original JSON event shape
 * without the settings encoder's depth-32 / 8192-array restrictions. It does
 * not invoke getters, Proxy traps, toJSON or caller callbacks. Other commands
 * continue using their existing stricter serializer and admission budgets. */
export function encodeHubEventJson(value: unknown): string {
  type Task = { value: unknown } | { token: string } | { leave: object };
  const stack: Task[] = [{ value }], active = new Set<object>(), output: string[] = [];
  let bytes = 0, nodes = 0;
  const fail = (): never => { throw Error('hub_event_invalid'); };
  const emit = (token: string) => {
    bytes += Buffer.byteLength(token);
    if (bytes > HUB_EVENT_RPC_BYTES) fail();
    output.push(token);
  };
  while (stack.length) {
    const task = stack.pop()!;
    if ('token' in task) { emit(task.token); continue; }
    if ('leave' in task) { active.delete(task.leave); continue; }
    if (++nodes > HUB_EVENT_RPC_NODES) fail();
    const current = task.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean' || typeof current === 'number') {
      // JSON.stringify maps non-finite payload numbers to null, as did the
      // original event writer. Invalid command fields are still refused later.
      emit(JSON.stringify(current)); continue;
    }
    if (!current || typeof current !== 'object' || types.isProxy(current) || active.has(current)) return fail();
    const array = Array.isArray(current), prototype = Object.getPrototypeOf(current);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail();
    const keys = Reflect.ownKeys(current);
    if (keys.length > HUB_EVENT_RPC_NODES + 1 || keys.some(key => typeof key !== 'string')) fail();
    const entries: [string, unknown][] = [];
    if (array) {
      const length = Object.getOwnPropertyDescriptor(current, 'length')!.value as number;
      if (length > HUB_EVENT_RPC_NODES || keys.some(key => key !== 'length'
        && (!/^(0|[1-9][0-9]*)$/.test(String(key)) || Number(key) >= length))) fail();
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (descriptor && !Object.hasOwn(descriptor, 'value')) fail();
        entries.push(['', descriptor?.value === undefined ? null : descriptor.value]);
      }
    } else {
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (!Object.hasOwn(descriptor, 'value')) fail();
        if (!descriptor.enumerable) continue;
        if (descriptor.value !== undefined) entries.push([key, descriptor.value]);
      }
    }
    active.add(current);
    emit(array ? '[' : '{');
    stack.push({ leave: current }, { token: array ? ']' : '}' });
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]!;
      stack.push({ value: child });
      if (!array) stack.push({ token: JSON.stringify(key) + ':' });
      if (index > 0) stack.push({ token: ',' });
    }
  }
  return output.join('');
}
type WireEvent = Omit<HubDeliveryEvent, 'id' | 'payload'> & { payload?: unknown };
export type HubEventCommand = {
  connectionId: string; connectionVersion: number; domain: string;
  event: WireEvent; cursor?: string; liveSince?: number;
};
export type HubEventProof = { evidence: HubMemberEvidence; expectedScope: string; command: HubEventCommand };
export type HubEventResult = { appended: boolean } | null;
export class HubEventAuthorityDenied extends Error {
  constructor() { super('hub_event_authority_denied'); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum = 4096): value is string => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const eventFields = ['envConnectionId','envConnectionLabel','hubSessionId','sessionKey','remoteSessionKey','remoteEventId','type','ts','payload','agentId','sessionRef'];
/** Preserve JSON's omission of optional undefined fields without executing
 * getters, proxies or toJSON. Nested payload copying is still performed by
 * the descriptor-safe member-owner serializer before any worker admission. */
export function hubEventWire(event: Omit<HubDeliveryEvent, 'id'>): WireEvent {
  if (!event || typeof event !== 'object' || types.isProxy(event)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(event))) throw Error('hub_event_invalid');
  const result: Record<string,unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(event)) {
    if (typeof key !== 'string' || !eventFields.includes(key)) throw Error('hub_event_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(event,key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value')) throw Error('hub_event_invalid');
    if (descriptor.value !== undefined) result[key] = descriptor.value;
    else if (['envConnectionId','type','ts'].includes(key)) throw Error('hub_event_invalid');
  }
  return result as WireEvent;
}
export function validHubEventCommand(value: unknown): value is HubEventCommand {
  if (!object(value) || Object.keys(value).some(key => !['connectionId','connectionVersion','domain','event','cursor','liveSince'].includes(key))
    || !text(value.connectionId) || !Number.isSafeInteger(value.connectionVersion) || Number(value.connectionVersion) < 0
    || typeof value.domain !== 'string' || !/^[a-f0-9]{64}$/.test(value.domain)
    // SSE ids may contain tabs; preserve the original parser's no-NUL rule.
    || value.cursor !== undefined && (typeof value.cursor !== 'string' || Buffer.byteLength(value.cursor) > 256*1024 || value.cursor.includes('\0'))
    || value.liveSince !== undefined && (!Number.isSafeInteger(value.liveSince) || Number(value.liveSince) < 0)) return false;
  const e = value.event;
  return object(e) && Object.keys(e).every(key => eventFields.includes(key))
    && e.envConnectionId === value.connectionId && typeof e.type === 'string' && /^[\w.:-]{1,100}$/.test(e.type)
    && typeof e.ts === 'number' && Number.isFinite(e.ts)
    // The original wrapper preserves empty labels, keys and agent ids. The
    // original 256KiB serialized event bound remains in appendDelivery.
    && ['envConnectionLabel','hubSessionId','sessionKey','remoteSessionKey','agentId','remoteEventId'].every(key => e[key] === undefined || typeof e[key] === 'string')
    && (e.sessionRef === undefined || object(e.sessionRef) && Object.keys(e.sessionRef).length === 3
      && Object.keys(e.sessionRef).every(key => ['nodeId','runtimeId','nativeSessionKey'].includes(key))
      && isNodeId(e.sessionRef.nodeId) && isAgentRuntimeId(e.sessionRef.runtimeId) && text(e.sessionRef.nativeSessionKey));
}
export function validHubEventResult(value: unknown): value is HubEventResult {
  return value === null || object(value) && Object.keys(value).length === 1 && typeof value.appended === 'boolean';
}

export function executeHubEventCommand(owner: HubStore, request: Request, proof: HubEventProof): HubEventResult {
  let denied = false;
  const current = () => {
    if (denied) throw new HubEventAuthorityDenied();
    const principal = owner.identities.commandPrincipal(request);
    const connection = principal && owner.getConnection(proof.command.connectionId, principal.userId);
    if (!principal || owner.identities.recoveryScope(principal) !== proof.expectedScope
      || !connection || connection.status === 'disabled' || !connection.capabilities.includes('events')
      || owner.connectionAuthority(connection.id,principal.userId) !== proof.command.connectionVersion) {
      denied = true; throw new HubEventAuthorityDenied();
    }
    // Optional legacy fields may be absent. When present, they must describe
    // this durable connection and its remote key, not a different session.
    const event = proof.command.event, remote = event.remoteSessionKey;
    const alias = remote ? encodeHubSessionId(connection.id, remote) : undefined;
    if (event.hubSessionId !== undefined && event.hubSessionId !== alias
      || event.sessionKey !== undefined && event.sessionKey !== alias) throw Error('hub_event_invalid');
    if (event.sessionRef !== undefined) {
      const canonical = remote ? sessionRef(connection.nodeId, remote) : undefined;
      if (!canonical || canonical.nodeId !== event.sessionRef.nodeId
        || canonical.runtimeId !== event.sessionRef.runtimeId
        || canonical.nativeSessionKey !== event.sessionRef.nativeSessionKey) throw Error('hub_event_invalid');
    }
    return principal;
  };
  try {
    const principal = current(), c = proof.command;
    // Only this callback stays inside the ORIGINAL worker/store. The complete
    // event+completion+cursor+retention transaction still has one COMMIT.
    const appended = owner.appendDelivery({...c.event,payload:c.event.payload},c.domain,c.cursor,principal.userId,c.liveSince,() => { current(); });
    current(); // A post-COMMIT denial cannot roll back or replay the effect.
    return { appended };
  } catch (error) { if (error instanceof HubEventAuthorityDenied) return null; throw error; }
}

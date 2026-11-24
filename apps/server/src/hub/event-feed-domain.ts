import type { DatabaseSync } from 'node:sqlite';
import type { HubConnection, HubStore } from './hub-store.js';
import { readConnections } from './connection-read.js';
import { CONNECTION_BYTE_LIMIT, validConnectionRows } from './connection-read-protocol.js';
import { validConnectionEpoch } from './member-connection-change-domain.js';
import { validHubEventCommand } from './member-event-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';

// Private background service domain, NOT a member/HTTP command. A capability
// minted by the original owner fixes ownerUserId before accepting any command.
// No Cookie, administrator principal, SQL or arbitrary method is serializable.
export const HUB_EVENT_FEED_COMMAND_BYTES = 1024 * 1024;
export const HUB_EVENT_FEED_RESULT_BYTES = 2 * CONNECTION_BYTE_LIMIT + 65_536;
type Target = { id: string; epoch: number };
export type HubEventFeedCommand = { action: 'directory' } | { action: 'gap' }
  | { action: 'open'; id: string }
  | ({ action: 'check' } & Target)
  | ({ action: 'cursor'; domain: string } & Target)
  | ({ action: 'append'; domain: string; eventJson: string; cursor?: string; liveSince?: number } & Target);
export type HubEventFeedInput = { ownerUserId: string; command: HubEventFeedCommand };
export type HubEventFeedResult = { ownerUserId: string } & (
  { action: 'directory'; body: string } | { action: 'gap'; ok: true }
  | { action: 'open'; id: string; target: null | { connection: HubConnection; epoch: number; token: string | null } }
  | ({ action: 'check'; ok: boolean } & Target)
  | ({ action: 'cursor'; domain: string; ok: boolean; cursor: string | null } & Target)
  | ({ action: 'append'; domain: string; ok: boolean; appended: boolean } & Target));
export type HubEventFeedOwner = { command(command: HubEventFeedCommand): Promise<HubEventFeedResult> };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
export const validEventFeedOwner = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 16_384 && !/[\x00-\x1f\x7f]/.test(v);
const domain = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const cursor = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 256 * 1024 && !v.includes('\0');
export function validHubEventFeedCommand(v: unknown): v is HubEventFeedCommand {
  if (!object(v)) return false;
  if (v.action === 'directory' || v.action === 'gap') return fields(v, ['action']);
  if (!validEventFeedOwner(v.id)) return false;
  if (v.action === 'open') return fields(v, ['action', 'id']);
  if (!validConnectionEpoch(v.epoch)) return false;
  if (v.action === 'check') return fields(v, ['action', 'id', 'epoch']);
  if (!domain(v.domain)) return false;
  if (v.action === 'cursor') return fields(v, ['action', 'id', 'epoch', 'domain']);
  if (v.action !== 'append' || !fields(v, ['action','id','epoch','domain','eventJson',
    ...(v.cursor === undefined ? [] : ['cursor']), ...(v.liveSince === undefined ? [] : ['liveSince'])])
    || typeof v.eventJson !== 'string' || Buffer.byteLength(v.eventJson) > 256 * 1024
    || v.cursor !== undefined && !cursor(v.cursor)
    || v.liveSince !== undefined && (!Number.isSafeInteger(v.liveSince) || Number(v.liveSince) < 0)) return false;
  try { return validHubEventCommand({ connectionId: v.id, connectionVersion: v.epoch, domain: v.domain,
    event: JSON.parse(v.eventJson), ...(v.cursor === undefined ? {} : { cursor: v.cursor }),
    ...(v.liveSince === undefined ? {} : { liveSince: v.liveSince }) }); } catch { return false; }
}
export function validHubEventFeedInput(v: unknown): v is HubEventFeedInput {
  return object(v) && fields(v, ['ownerUserId', 'command']) && validEventFeedOwner(v.ownerUserId) && validHubEventFeedCommand(v.command);
}
export function validHubEventFeedResult(v: unknown): v is HubEventFeedResult {
  try {
    if (!object(v) || !validEventFeedOwner(v.ownerUserId)) return false;
    const base = ['ownerUserId','action'];
    if (v.action === 'directory') return fields(v, [...base,'body']) && typeof v.body === 'string'
      && Buffer.byteLength(v.body) <= CONNECTION_BYTE_LIMIT && validConnectionRows(JSON.parse(v.body), v.ownerUserId);
    if (v.action === 'gap') return fields(v, [...base,'ok']) && v.ok === true;
    if (!validEventFeedOwner(v.id)) return false;
    if (v.action === 'open') {
      if (!fields(v, [...base,'id','target'])) return false;
      const t = v.target;
      return t === null || object(t) && fields(t, ['connection','epoch','token']) && validConnectionEpoch(t.epoch)
        && validConnectionRows([t.connection], v.ownerUserId) && object(t.connection) && t.connection.id === v.id
        && t.connection.status !== 'disabled' && Array.isArray(t.connection.capabilities) && t.connection.capabilities.includes('events')
        && (t.connection.kind === 'local' ? t.token === null : typeof t.token === 'string' && !!t.token && Buffer.byteLength(t.token) <= 16_384);
    }
    if (!validConnectionEpoch(v.epoch) || typeof v.ok !== 'boolean') return false;
    if (v.action === 'check') return fields(v, [...base,'id','epoch','ok']);
    if (!domain(v.domain)) return false;
    if (v.action === 'cursor') return fields(v, [...base,'id','epoch','domain','ok','cursor'])
      && (v.cursor === null || v.ok && cursor(v.cursor));
    return v.action === 'append' && fields(v, [...base,'id','epoch','domain','ok','appended'])
      && typeof v.appended === 'boolean' && (v.ok || !v.appended);
  } catch { return false; }
}
export function validHubEventFeedReply(input: HubEventFeedInput, v: unknown): v is HubEventFeedResult {
  if (!validHubEventFeedResult(v) || v.ownerUserId !== input.ownerUserId || v.action !== input.command.action) return false;
  const c = input.command;
  if (c.action === 'directory' || c.action === 'gap') return true;
  if (!('id' in v) || v.id !== c.id) return false;
  if (c.action === 'open') return true;
  return 'epoch' in v && v.epoch === c.epoch && (c.action === 'check' || 'domain' in v && v.domain === c.domain);
}

/** Executes on the one original owner. Snapshot reads and the append's own
 * transaction never split current generation from cursor/completion admission. */
export function executeHubEventFeed(db: DatabaseSync, owner: HubStore, input: HubEventFeedInput): HubEventFeedResult {
  requireConnectionReady(db);
  if (!validHubEventFeedInput(input)) throw Error('hub_event_feed_unavailable');
  const { ownerUserId, command: c } = input;
  const current = (id: string, epoch?: number) => {
    if (!owner.getUser(ownerUserId)) return;
    const connection = owner.getConnection(id, ownerUserId), version = owner.connectionAuthority(id, ownerUserId);
    if (!connection || connection.status === 'disabled' || !connection.capabilities.includes('events')
      || !validConnectionEpoch(version) || epoch !== undefined && version !== epoch) return;
    return { connection, epoch: version };
  };
  if (c.action === 'append') {
    const event = JSON.parse(c.eventJson), target = current(c.id, c.epoch);
    if (!target) return { ownerUserId, action: c.action, id: c.id, epoch: c.epoch, domain: c.domain, ok: false, appended: false };
    const remote = event.remoteSessionKey, alias = remote ? encodeHubSessionId(c.id, remote) : undefined;
    if (event.hubSessionId !== undefined && event.hubSessionId !== alias || event.sessionKey !== undefined && event.sessionKey !== alias)
      throw Error('hub_event_feed_unavailable');
    if (event.sessionRef !== undefined) {
      const ref = remote ? sessionRef(target.connection.nodeId, remote) : undefined;
      if (!ref || event.sessionRef.nodeId !== ref.nodeId || event.sessionRef.runtimeId !== ref.runtimeId
        || event.sessionRef.nativeSessionKey !== ref.nativeSessionKey) throw Error('hub_event_feed_unavailable');
    }
    const appended = owner.appendDelivery(event, c.domain, c.cursor, ownerUserId, c.liveSince, () => {
      if (!current(c.id, c.epoch)) throw Error('hub_event_feed_unavailable');
    });
    return { ownerUserId, action: c.action, id: c.id, epoch: c.epoch, domain: c.domain, ok: true, appended };
  }
  // Like append, gap owns its complete write transaction. A read savepoint
  // would make markGap reject an outer transaction once completion tables exist.
  if (c.action === 'gap') { owner.completions.markGap(ownerUserId); return { ownerUserId, action: c.action, ok: true }; }
  return observedSavepoint(db, 'hub-event-feed-command', () => {
    if (c.action === 'directory') {
      if (!owner.getUser(ownerUserId)) throw Error('hub_event_feed_unavailable');
      return { ownerUserId, action: c.action, body: JSON.stringify(readConnections(db, ownerUserId)) };
    }
    const t = current(c.id, c.action === 'open' ? undefined : c.epoch);
    if (c.action === 'open') {
      const token = !t || t.connection.kind === 'local' ? null : owner.getCredentialToken(c.id, ownerUserId) ?? null;
      return { ownerUserId, action: c.action, id: c.id, target: !t || t.connection.kind !== 'local' && !token ? null : { ...t, token } };
    }
    if (c.action === 'check') return { ownerUserId, action: c.action, id: c.id, epoch: c.epoch, ok: !!t };
    return { ownerUserId, action: c.action, id: c.id, epoch: c.epoch, domain: c.domain, ok: !!t,
      cursor: t ? owner.upstreamCursor(c.id, c.domain, ownerUserId) ?? null : null };
  });
}

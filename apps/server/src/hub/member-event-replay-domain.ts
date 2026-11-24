import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { isWorkspaceRevisionReadRejected } from './workspace-revision-read.js';
import { validDeliveryRead, validDeliveryPage, validWorkspaceRevisions,
  type DeliveryPage, type WorkspaceRevisions } from './delivery-reader-protocol.js';

export const HUB_EVENT_REPLAY_COMMAND_BYTES = 2 * 1024 * 1024;
// Workspace revision snapshots retain their existing 8MiB bound. The envelope
// is JSON text so arbitrary legacy event depth is not a settings DTO limit.
export const HUB_EVENT_REPLAY_RESULT_BYTES = 20 * 1024 * 1024;
export function hubEventReplayResultBytes(command: unknown): number {
  if (!validHubEventReplayCommand(command)) return HUB_EVENT_REPLAY_RESULT_BYTES;
  if (command.action === 'cursor') return 32 * 1024;
  if (command.action === 'page') return 2 * 524288 + 65536;
  return HUB_EVENT_REPLAY_RESULT_BYTES;
}
export type HubEventReplayCommand = { action: 'cursor' } | { action: 'revisions' }
  | { action: 'page'; cursor: string | null; domains: [string, string][] };
export type HubEventReplayData = { action: 'cursor'; cursor: string | null }
  | { action: 'revisions'; revisions: WorkspaceRevisions }
  | { action: 'revisions'; rejected: true }
  | { action: 'page'; page: Omit<DeliveryPage, 'cursor'> & { cursor: string | null } };
export type HubEventReplayResult = { body: string } | null;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const cursor = (v: unknown) => v === null || typeof v === 'string' && v.length <= 4096 && !/[\0\r\n]/.test(v);

export function validHubEventReplayCommand(value: unknown): value is HubEventReplayCommand {
  if (!record(value)) return false;
  if (value.action === 'cursor' || value.action === 'revisions') return Object.keys(value).length === 1;
  return value.action === 'page' && Object.keys(value).length === 3
    && Object.keys(value).every(k => ['action', 'cursor', 'domains'].includes(k)) && cursor(value.cursor)
    && validDeliveryRead({ owner: 'protocol-validation', cursor: value.cursor ?? undefined, domains: value.domains });
}

export function decodeHubEventReplay(value: Exclude<HubEventReplayResult, null>): HubEventReplayData {
  if (!record(value) || Object.keys(value).length !== 1 || typeof value.body !== 'string'
    || Buffer.byteLength(value.body) > HUB_EVENT_REPLAY_RESULT_BYTES) throw Error('hub_event_replay_unavailable');
  const data: unknown = JSON.parse(value.body);
  if (!record(data) || Object.keys(data).length !== 2) throw Error('hub_event_replay_unavailable');
  const command = data.action === 'page' ? { action: 'page', cursor: null, domains: [] } : { action: data.action };
  if (!validHubEventReplayCommand(command)
    || Buffer.byteLength(JSON.stringify(value)) > hubEventReplayResultBytes(command)) throw Error('hub_event_replay_unavailable');
  if (data.action === 'cursor' && Object.hasOwn(data, 'cursor') && cursor(data.cursor)) return data as HubEventReplayData;
  if (data.action === 'revisions' && validWorkspaceRevisions(data.revisions)) return data as HubEventReplayData;
  if (data.action === 'revisions' && data.rejected === true) return data as HubEventReplayData;
  if (data.action === 'page' && record(data.page) && cursor(data.page.cursor)
    && validDeliveryPage({ ...data.page, cursor: data.page.cursor ?? undefined })) return data as HubEventReplayData;
  throw Error('hub_event_replay_unavailable');
}

export function validHubEventReplayResult(value: unknown): value is HubEventReplayResult {
  if (value === null) return true;
  try { decodeHubEventReplay(value as Exclude<HubEventReplayResult, null>); return true; } catch { return false; }
}

export function validHubEventReplayReply(command: HubEventReplayCommand, value: unknown): boolean {
  if (!validHubEventReplayResult(value)) return false;
  if (value === null) return true;
  const data = decodeHubEventReplay(value);
  if (data.action !== command.action) return false;
  if (data.action === 'page' && command.action === 'page') {
    const ids = new Set(command.domains.map(([id]) => id));
    return data.page.events.every(event => ids.has(event.envConnectionId));
  }
  return true;
}

/** Called only in the original identity savepoint. Scope is derived from the
 * current principal, never the display/filter DTO or a supplied owner ID. */
export function readHubEventReplay(owner: HubStore, principal: HubPrincipal,
  command: HubEventReplayCommand): HubEventReplayResult {
  const user = principal.userId;
  let data: HubEventReplayData;
  if (command.action === 'cursor') data = { action: 'cursor', cursor: owner.latestDeliveryCursor(user) ?? null };
  else if (command.action === 'revisions') {
    try { data = { action: 'revisions', revisions: owner.eventWorkspaceRevisions(user) }; }
    catch (error) {
      // Only this original completed display refusal may keep chat alive.
      // Unknown SQL/owner/identity failures must still fail the whole command.
      if (!isWorkspaceRevisionReadRejected(error)) throw error;
      data = { action: 'revisions', rejected: true };
    }
  }
  else {
    const domains = new Map(command.domains.filter(([id]) => {
      const connection = owner.getConnection(id, user);
      return connection && connection.status !== 'disabled' && connection.capabilities.includes('events');
    }));
    const page = owner.deliveryPage(command.cursor ?? undefined, domains, user);
    data = { action: 'page', page: { ...page, cursor: page.cursor ?? null } };
  }
  const result = { body: JSON.stringify(data) };
  if (!validHubEventReplayReply(command, result)) throw Error('hub_event_replay_unavailable');
  return result;
}

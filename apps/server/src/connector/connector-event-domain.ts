import type { DeckEvent, DeckEventType } from '@agentopsdeck/shared';
import type { ConnectorEventLog } from './event-log.js';

// Internal projection commands, not an HTTP authorization port. Execution facts
// must still append inside their ORIGINAL shared transaction in this owner.
// Never split a fact/receipt commit into a separate eventProjectionAppend RPC.
type Empty = Record<string, never>;
export type ConnectorEventReplay = { cursor: string; known: boolean; events: DeckEvent[] };
export type ConnectorEventCommands = {
  eventReplay: { input: { after: string | null }; output: ConnectorEventReplay };
  eventProjectionAppend: { input: { events: DeckEvent[] }; output: { cursor: string | null } };
  eventProjectionReset: { input: Empty; output: string };
  eventProjectionRecover: { input: Empty; output: { recovered: boolean; cursor: string | null } };
};
export const connectorEventSteps = Object.freeze({
  eventReplay: 92, eventProjectionAppend: 93, eventProjectionReset: 94, eventProjectionRecover: 95,
});
export type ConnectorEventKind = keyof ConnectorEventCommands;
export const isConnectorEventKind = (kind: string): kind is ConnectorEventKind => Object.hasOwn(connectorEventSteps, kind);
export const CONNECTOR_EVENT_COMMAND_BYTES = 512 * 1024;
export const CONNECTOR_EVENT_BATCH_LIMIT = 4096;
const eventTypes: readonly DeckEventType[] = ['stream.reset', 'stream.status', 'session.updated', 'interaction.updated',
  'session.stale_active_run_reconciled', 'message.created', 'message.updated', 'run.updated', 'run.completed',
  'tool.started', 'tool.completed', 'tool.failed', 'queued_message.created', 'queued_message.sent', 'queued_message.failed',
  'gateway.status_changed', 'channel.status_changed', 'cron.failure'];
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && required.every(key => Object.hasOwn(v, key))
  && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const text = (v: unknown) => typeof v === 'string' && !v.includes('\0') && Buffer.byteLength(v) <= 4096;
function cursor(v: unknown): { epoch: string; seq: number } | undefined {
  if (typeof v !== 'string' || v.length > 57) return;
  const match = /^ce1_([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}):(0|[1-9]\d{0,15})$/.exec(v);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return;
  return { epoch: match[1]!, seq: Number(match[2]) };
}
function event(v: unknown): v is DeckEvent {
  return fields(v, ['id', 'type', 'ts', 'payload'], ['sessionKey', 'agentId']) && text(v.id)
    && eventTypes.includes(v.type as DeckEventType) && Number.isSafeInteger(v.ts) && Number(v.ts) >= 0
    && (!Object.hasOwn(v, 'sessionKey') || text(v.sessionKey)) && (!Object.hasOwn(v, 'agentId') || text(v.agentId));
}
// Call only on the descriptor-safe JSON copy produced by the owner envelope.
export function validConnectorEventInput(kind: ConnectorEventKind, v: unknown): boolean {
  if (!isConnectorEventKind(kind)) return false;
  // Old/expired/malformed-but-bounded client cursors request an explicit reset,
  // not a storage failure. Preserve the existing SSE compatibility contract.
  if (kind === 'eventReplay') return fields(v, ['after']) && (v.after === null || text(v.after));
  if (kind === 'eventProjectionAppend') return fields(v, ['events']) && Array.isArray(v.events)
    && v.events.length >= 1 && v.events.length <= CONNECTOR_EVENT_BATCH_LIMIT && v.events.every(event)
    && Buffer.byteLength(JSON.stringify(v)) <= CONNECTOR_EVENT_COMMAND_BYTES;
  return fields(v, []);
}
export function validConnectorEventOutput(kind: ConnectorEventKind, v: unknown): boolean {
  if (!isConnectorEventKind(kind)) return false;
  if (kind === 'eventProjectionReset') return cursor(v)?.seq === 0;
  if (kind === 'eventProjectionAppend') return fields(v, ['cursor']) && (v.cursor === null || !!cursor(v.cursor));
  if (kind === 'eventProjectionRecover') return fields(v, ['recovered', 'cursor']) && typeof v.recovered === 'boolean'
    && (v.cursor === null ? !v.recovered : !!cursor(v.cursor)) && (!v.recovered || cursor(v.cursor)?.seq === 0);
  if (!fields(v, ['cursor', 'known', 'events']) || !cursor(v.cursor) || typeof v.known !== 'boolean'
    || !Array.isArray(v.events) || v.events.length > 64 || !v.known && v.events.length !== 0) return false;
  const head = cursor(v.cursor)!;
  let previous: number | undefined;
  let bytes = 0;
  for (const value of v.events) {
    if (!event(value)) return false;
    const current = cursor(value.id), size = Buffer.byteLength(JSON.stringify(value));
    if (!current || current.epoch !== head.epoch || current.seq > head.seq || current.seq === 0
      || previous !== undefined && current.seq !== previous + 1 || size > 128 * 1024) return false;
    previous = current.seq; bytes += size;
  }
  return bytes <= 512 * 1024;
}
/** Validate AGAIN against the original requested cursor before publishing.
 * A valid page from another epoch/request must not acknowledge this request. */
export function connectorEventReplayMatches(after: string | null, value: ConnectorEventReplay): boolean {
  if (!validConnectorEventOutput('eventReplay', value)) return false;
  if (after === null) return value.known && !value.events.length;
  if (!value.known) return true; // Explicit reset, not proof of delivered rows.
  const requested = cursor(after), head = cursor(value.cursor)!;
  if (!requested) return false;
  if (requested.epoch !== head.epoch || requested.seq > head.seq) return false;
  if (!value.events.length) return requested.seq === head.seq;
  return cursor(value.events[0]!.id)?.seq === requested.seq + 1;
}
export function executeConnectorEvent<K extends ConnectorEventKind>(kind: K,
  input: ConnectorEventCommands[K]['input'], log: ConnectorEventLog): ConnectorEventCommands[K]['output'] {
  if (!validConnectorEventInput(kind, input)) throw Error('connector_storage_unavailable');
  let value: unknown;
  switch (kind) {
    case 'eventReplay': {
      const after = (input as ConnectorEventCommands['eventReplay']['input']).after;
      // No await between head, retention check and bounded rows. The worker
      // owns one connection; this is one observation, not three racy RPCs.
      const latest = log.latestEventId(), known = after === null || log.hasEvent(after);
      value = { cursor: latest, known, events: known && after !== null ? log.getEventsSince(after) : [] };
      if (!connectorEventReplayMatches(after, value as ConnectorEventReplay)) throw Error('connector_storage_unavailable');
      break;
    }
    case 'eventProjectionAppend':
      value = { cursor: log.appendBatch((input as ConnectorEventCommands['eventProjectionAppend']['input']).events)?.id ?? null };
      break;
    case 'eventProjectionReset': log.beginEpoch(); value = log.latestEventId(); break;
    case 'eventProjectionRecover': {
      const recovered = log.recoverProjection();
      let latest: string | null = null;
      try { latest = log.latestEventId(); } catch { /* Unavailable remains closed, never replace this writer. */ }
      value = { recovered, cursor: latest }; break;
    }
  }
  if (!validConnectorEventOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorEventCommands[K]['output'];
}

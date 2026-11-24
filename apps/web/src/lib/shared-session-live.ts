import type { ChatMessage, SessionExecutionSnapshot, SharedSessionAccessHints, SessionHistoryStatus } from '@agentopsdeck/shared';
import { createReconnectingEventStream, type StreamConnection } from './event-stream.js';
import { createMessageSnapshotGate, createQueuedRefresh } from './refresh-control.js';
import { sessionAddress, type SharedSessionTarget } from './session-address.js';

export type SharedHistorySnapshot = {
  messages: ChatMessage[]; updatedAt: number; sourceCursor?: string; historyStatus?: SessionHistoryStatus; hiddenCount?: number; access?: SharedSessionAccessHints; limits?: { maxMessageChars: number };
};
export type SnapshotSync = 'loading' | 'ready' | 'stale' | 'unavailable';
export type SharedLiveState = {
  history?: SharedHistorySnapshot | undefined;
  execution?: SessionExecutionSnapshot | undefined;
  historySync: SnapshotSync;
  executionSync: SnapshotSync;
  transport: StreamConnection;
  source: 'unknown' | 'disconnected' | 'unauthorized';
  denied: boolean;
  access?: SharedSessionAccessHints | undefined;
};

/** One exact resource per lifecycle. Two bounded snapshot lanes, one existing
 * reconnecting stream, no polling/cache/command dispatch. SSE is never text or
 * completion authority, and its replay ID is never a projection watermark. */
export function createSharedSessionLive(options: {
  target: SharedSessionTarget;
  scope: () => unknown;
  url: () => string;
  history: (signal: AbortSignal) => Promise<SharedHistorySnapshot>;
  execution: (signal: AbortSignal) => Promise<SessionExecutionSnapshot>;
  onChange: (state: SharedLiveState) => void;
  createSource?: (url: string) => EventSource;
}) {
  const key = sessionAddress(options.target).key;
  const scope = options.scope();
  let active = false, started = false, streamAllowed = false;
  let state: SharedLiveState = { historySync: 'loading', executionSync: 'loading', transport: 'connecting', source: 'unknown', denied: false };
  const controller = new AbortController();
  const live = () => active && scope === options.scope();
  const publish = (patch: Partial<SharedLiveState>) => {
    if (!live()) return;
    state = { ...state, ...patch };
    options.onChange(state);
  };
  const historyGate = createMessageSnapshotGate(options.scope);
  const executionGate = createMessageSnapshotGate(options.scope);
  const missingLanes = new Set<'history' | 'execution'>();
  const deny = () => {
    publish({ denied: true, access: undefined, history: undefined, execution: undefined, historySync: 'unavailable', executionSync: 'unavailable' });
    stop();
  };
  function lane<T extends { sourceCursor?: string }>(gate: typeof historyGate, read: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => Partial<SharedLiveState>, syncKey: 'historySync' | 'executionSync', dataKey: 'history' | 'execution', access?: (value: T) => void,
    displayOnly?: (value: T) => boolean, sessionVerified?: (value: T) => boolean) {
    const refresh = createQueuedRefresh(async () => {
      if (!live()) return;
      const request = gate.begin(key);
      try {
        const value = await read(controller.signal);
        if (!live() || !request()) return;
        const patch = apply(value);
        missingLanes.delete(dataKey);
        // Policy freshness is independent of the Connector projection cursor:
        // a lagging history page must not keep a revoked event/send hint alive.
        access?.(value);
        if (displayOnly?.(value)) {
          // Connector's freshly authorized recent projection may deliberately
          // omit a cursor. It is readable text, not execution/send authority.
          // Keep the applied watermark (accept rejects a missing cursor after
          // a verified snapshot), while retaining its bounded catch-up hint.
          request.accept(undefined);
          publish({ ...patch, [syncKey]: 'stale' });
          return;
        }
        if (!(sessionVerified?.(value) ? request.acceptSession() : request.accept(value.sourceCursor))) { publish({ [syncKey]: 'stale' }); return; }
        publish({ ...patch, [syncKey]: gate.isCaughtUp() ? 'ready' : 'stale' });
      } catch (error) {
        if (!live() || !request()) return;
        const status = (error as { status?: number } | undefined)?.status;
        if (status === 401 || status === 403 || (error instanceof Error && error.name === 'AuthRequiredError')) { deny(); return; }
        if (status === 404) missingLanes.add(dataKey);
        else missingLanes.delete(dataKey);
        if (missingLanes.size === 2) { deny(); return; }
        // A missing projection is not an idle fact. A missing resource must not
        // retain that lane's private cached content either (404 masks denial).
        publish({ [syncKey]: 'unavailable', ...(status === 404 ? { [dataKey]: undefined } : {}) });
        if (status === 404 && dataKey === 'history') updateAccess(undefined);
      }
    });
    gate.subscribe(() => { if (live()) void refresh.run(); });
    return refresh;
  }
  const history = lane(historyGate, options.history, value => {
    if (value.historyStatus === 'cached' && value.sourceCursor !== undefined) throw new Error('Display-only history cannot carry an authority cursor');
    if (value.historyStatus === 'verified-session' && value.sourceCursor !== undefined) throw new Error('Session proof cannot carry a global cursor');
    return { history: { ...value, messages: value.messages.map(message => ({ ...message, sessionKey: key })) } };
  }, 'historySync', 'history', value => updateAccess(value.access), value => value.historyStatus === 'cached', value => value.historyStatus === 'verified-session');
  const execution = lane(executionGate, options.execution, value => {
    if (value.sessionKey !== options.target.sessionId) throw new Error('Shared execution identity mismatch');
    return { execution: { ...value, sessionKey: key } };
  }, 'executionSync', 'execution');
  const refresh = () => {
    if (!live()) return;
    void history.run(); void execution.run();
  };
  const stream = createReconnectingEventStream({
    url: options.url,
    ...(options.createSource ? { createSource: options.createSource } : {}),
    eventTypes: ['session.invalidated', 'stream.reset', 'stream.status'],
    onOpen: refresh,
    onConnection: transport => {
      publish({ transport });
      // An SSE close can be a revoked proof. Exact reads determine that; socket
      // failure itself is not permission to erase/complete an active run.
      if (transport === 'reconnecting') refresh();
    },
    onMessage: message => {
      if (!live()) return;
      let event: { type?: string; sessionKey?: string; sourceCursor?: unknown; payload?: { connection?: string } };
      try { event = JSON.parse(message.data); } catch { return; }
      if (!event || typeof event !== 'object' || event.type !== message.type) return;
      // Hub cursor-expiry resets have no resource field; this feed itself is
      // exact-scoped. All other frames must match the remote Hub session ID.
      if (event.sessionKey !== options.target.sessionId && !(message.type === 'stream.reset' && event.sessionKey === undefined)) return;
      if (message.type === 'stream.reset') {
        historyGate.invalidate(); executionGate.invalidate();
        publish({ historySync: 'stale', executionSync: 'stale', source: 'unknown' });
        refresh();
      } else if (message.type === 'stream.status') {
        publish({ source: event.payload?.connection === 'unauthorized' ? 'unauthorized' : 'disconnected', historySync: 'stale', executionSync: 'stale' });
        refresh();
      } else if (message.type === 'session.invalidated') {
        publish({ source: 'unknown' }); // Replayed events do not prove node liveness.
        if (historyGate.observe(event.sourceCursor, key)) { publish({ historySync: 'stale' }); void history.run(); }
        if (executionGate.observe(event.sourceCursor, key)) { publish({ executionSync: 'stale' }); void execution.run(); }
      }
    },
  });
  function updateAccess(value: SharedSessionAccessHints | undefined) {
    // Older/malformed servers do not implicitly enable execution or a retrying
    // stream. No second permissions request or polling lane is introduced.
    const access = { messagesSend: value?.messagesSend === true, eventsRead: value?.eventsRead === true,
      messagesMirror: value?.messagesSend === true && value?.messagesMirror === true,
      ...(value?.sessionsShare === true ? { sessionsShare: true } : {}) };
    publish({ access });
    if (access.eventsRead === streamAllowed) return;
    streamAllowed = access.eventsRead;
    if (streamAllowed) stream.start(); else stream.stop();
  }
  function stop() {
    active = false;
    controller.abort(); historyGate.invalidate(); executionGate.invalidate();
    stream.stop();
  }
  return {
    start() { if (!started) { started = active = true; refresh(); } },
    refresh,
    ensureConnected() { if (live() && streamAllowed) stream.wake(); },
    stop,
  };
}

import { browserDiagnostics } from './browser-diagnostics.js';
export type StreamConnection = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

type RecoveryReason = 'url' | 'create' | 'error' | 'closed' | 'silent' | 'close' | 'connected';
type RecoveryEntry = { sequence: number; reason: RecoveryReason; attempts: number; retryMs: number };
const recoveryEntries: RecoveryEntry[] = [];
let recoverySequence = 0;
function recordRecovery(reason: RecoveryReason, attempts: number, retryMs = 0) {
  browserDiagnostics.record(reason === 'connected' ? 'stream-connected' : 'stream-retry', { attempts, retryMs });
  recoveryEntries.push({ sequence: ++recoverySequence, reason, attempts, retryMs });
  if (recoveryEntries.length > 128) recoveryEntries.shift();
  // Only finite codes/numbers: never URLs, credentials, cursors or exceptions.
}
const recoveryDiagnostics = {
  read: () => recoveryEntries.map(entry => ({ ...entry })),
  clear: () => { recoveryEntries.length = 0; },
};
export const readEventStreamDiagnostics = recoveryDiagnostics.read;
export const clearEventStreamDiagnostics = recoveryDiagnostics.clear;
if (typeof window !== 'undefined') (window as Window & {
  __agentopsdeckEventStreamDiagnostics?: typeof recoveryDiagnostics;
}).__agentopsdeckEventStreamDiagnostics = recoveryDiagnostics;

// Own reconnection explicitly: EventSource does not retry every HTTP failure
// (for example a proxy 503 can leave readyState=CLOSED indefinitely).
export function createReconnectingEventStream(options: {
  url: () => string;
  eventTypes: readonly string[];
  onMessage: (message: MessageEvent<string>) => void;
  onConnection: (connection: StreamConnection) => void;
  onOpen: () => void;
  createSource?: (url: string) => EventSource;
  now?: () => number;
}) {
  let source: EventSource | undefined;
  let active = false;
  let attempts = 0;
  let cursor = '';
  let lastSeen = 0;
  let healthySince: number | undefined;
  let generation = 0, connecting = false;
  const now = options.now ?? (() => performance.now());
  const isSilent = (thresholdMs = 45_000) => now() - lastSeen >= thresholdMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let warning: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const clearWarning = () => { clearTimeout(warning); warning = undefined; };
  let connection: StreamConnection = 'connecting';
  const setConnection = (next: StreamConnection) => {
    if (connection === next) return;
    connection = next;
    options.onConnection(next);
  };
  const closeSource = (previous?: EventSource) => {
    try { previous?.close(); } catch { recordRecovery('close', attempts); }
  };
  const disposeSource = () => {
    generation++;
    const previous = source;
    source = undefined;
    clearTimeout(watchdog);
    watchdog = undefined; healthySince = undefined;
    closeSource(previous);
  };
  const fail = (reason: RecoveryReason) => {
    if (!active) return;
    disposeSource();
    const ticket = generation;
    if (connection !== 'disconnected') setConnection('reconnecting');
    if (!active || generation !== ticket) return;
    warning ??= setTimeout(() => { warning = undefined; if (active) setConnection('disconnected'); }, 10_000);
    if (retry === undefined) {
      // attempts stays in [0, 5]; the delay cap also covers its final value.
      const retryMs = Math.min(15_000, 1_000 * 2 ** attempts);
      if (attempts < 5) attempts++;
      recordRecovery(reason, attempts, retryMs);
      retry = setTimeout(() => { retry = undefined; connect(); }, retryMs);
    }
  };
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (!active) return;
      if (isSilent()) fail('silent');
      else armWatchdog();
    }, 15_000);
  };
  const connect = () => {
    if (!active || source || connecting) return;
    connecting = true;
    const ticket = generation;
    let current: EventSource;
    let reason: RecoveryReason = 'url';
    try {
      const base = options.url();
      if (!active || generation !== ticket) return;
      const url = cursor ? `${base}${base.includes('?') ? '&' : '?'}lastEventId=${encodeURIComponent(cursor)}` : base;
      reason = 'create';
      current = (options.createSource ?? ((url) => new EventSource(url, { withCredentials: true })))(url);
      if (!active || generation !== ticket) { closeSource(current); return; }
    } catch { if (active && generation === ticket) fail(reason); return; }
    finally {
      connecting = false;
      // A callback may stop and start while its original factory is on stack.
      // Finish unwinding before constructing the new scope's source.
      if (active && generation !== ticket && !source && retry === undefined) queueMicrotask(connect);
    }
    source = current;
    lastSeen = now();
    const live = () => active && source === current;
    const markConnected = () => {
      if (!live()) return;
      lastSeen = now();
      healthySince ??= lastSeen;
      // A 200/open/first heartbeat is not proof of a stable connection. Keep
      // exponential backoff for open-then-drop loops until healthy traffic.
      if (lastSeen - healthySince >= 10_000) attempts = 0;
      clearWarning();
      if (connection !== 'connected') {
        recordRecovery('connected', attempts);
        setConnection('connected');
        if (live()) options.onOpen();
      }
    };
    const receive = (message: MessageEvent<string>) => {
      markConnected();
      if (!live()) return;
      if (message.lastEventId || message.type === 'stream.reset') cursor = message.lastEventId;
      options.onMessage(message);
    };
    current.onopen = markConnected;
    current.onerror = () => { if (live()) fail('error'); };
    current.onmessage = receive;
    for (const type of options.eventTypes) current.addEventListener(type, receive as EventListener);
    current.addEventListener('heartbeat', markConnected);
    armWatchdog();
  };
  return {
    start() { if (!active) { active = true; setConnection('connecting'); connect(); } },
    ensureConnected() {
      if (!active) return;
      // Session changes / returning to the tab can discover a silently closed
      // stream. Never tear down a healthy shared connection on navigation.
      if (source?.readyState === 2) fail('closed');
      else if (source && isSilent()) fail('silent');
      if (!source && retry === undefined) connect();
    },
    wake() {
      if (!active) return;
      // Foreground resume after app switch / iOS suspension: bypass pending
      // retry timers and detect half-open sockets that missed a 10s heartbeat.
      const dead = source?.readyState === 2;
      const stale = Boolean(source && (isSilent(15_000) || (source.readyState === 0 && isSilent(5_000))));
      if (dead || stale) {
        disposeSource();
        if (connection !== 'disconnected') setConnection('reconnecting');
        warning ??= setTimeout(() => { warning = undefined; if (active) setConnection('disconnected'); }, 10_000);
      }
      if (!source) {
        clearTimeout(retry); retry = undefined;
        attempts = 0;
        connect();
      }
    },
    stop() {
      active = false;
      clearTimeout(retry); retry = undefined;
      clearWarning();
      disposeSource();
      attempts = 0;
      cursor = '';
      setConnection('connecting');
    },
  };
}

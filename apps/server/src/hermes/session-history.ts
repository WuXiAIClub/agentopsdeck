import type { ChatMessage } from '@agentopsdeck/shared';
import type { HermesHistorySnapshot } from './journal.js';
import type { HermesHistoryRow } from './history.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Awaitable<T> = T | Promise<T>;
export type HermesHistoryPort = {
  snapshot(key: string): Awaitable<HermesHistorySnapshot | null>;
  attached(snapshot: HermesHistorySnapshot, stored: string): Awaitable<HermesHistorySnapshot | null>;
  commit(snapshot: HermesHistorySnapshot, rows: HermesHistoryRow[]): Awaitable<HermesHistorySnapshot | null>;
  projection(snapshot: HermesHistorySnapshot): Awaitable<ChatMessage[] | null>;
};

/** Original native effect stays in its executor. The snapshot is only an
 * optimistic write fence, never authorization to send, recover or replay. */
export async function attachHermesSession(key: string, port: HermesHistoryPort,
  native: (snapshot: HermesHistorySnapshot) => Promise<{ live: string; stored: string }>, current: () => boolean): Promise<string> {
  const snapshot = await port.snapshot(key);
  if (!snapshot || snapshot.unknown || current() !== true) throw Error('Hermes session is protected');
  const identity = await native(snapshot);
  if (current() !== true) throw Error('Hermes connection changed during attachment');
  const committed = await port.attached(snapshot, identity.stored);
  if (!committed || current() !== true) throw Error('Hermes attachment snapshot changed');
  return identity.live;
}

export async function refreshHermesHistory(key: string, port: HermesHistoryPort,
  native: { attach(): Promise<string>; history(live: string): Promise<HermesHistoryRow[]>; current(): boolean },
  publish: (messages: ChatMessage[]) => void, diagnostics: PerformanceDiagnostics = performanceDiagnostics): Promise<'committed' | 'cached' | 'stale'> {
  const trace = guardedTrace(diagnostics, 'hermes-history-sync'); let failed = false;
  try {
    const initial = await port.snapshot(key);
    if (!initial) return 'stale';
    if (initial.unknown) return 'cached';
    if (native.current() !== true) return 'stale';
    trace.add('step', 1);
    const live = await native.attach();
    // Attachment itself may rotate an unstarted stored identity. Capture the
    // new fence BEFORE history I/O, not after it has already become stale.
    const snapshot = await port.snapshot(key);
    if (!snapshot || snapshot.unknown || native.current() !== true) return 'stale';
    const rows = structuredClone(await native.history(live));
    if (native.current() !== true) return 'stale';
    trace.add('step', 2);
    const committed = await port.commit(snapshot, rows);
    if (!committed || native.current() !== true) return 'stale';
    const messages = await port.projection(committed);
    if (!messages || native.current() !== true) return 'stale';
    publish(messages); trace.add('settled', 1); return 'committed';
  } catch (error) { failed = true; throw error; }
  finally { trace.finish(failed); }
}

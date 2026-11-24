import type { ChatMessage } from '@agentopsdeck/shared';
import type { HermesExecution } from './journal.js';
import type { HermesHistoryRow } from './history.js';
import type { HermesHistoryPort } from './session-history.js';
import { record } from './protocol.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export type HermesTerminalPhase = 'completed' | 'failed' | 'interrupted';
type Awaitable<T> = T | Promise<T>;
export type HermesTerminalPort = {
  terminal(execution: HermesExecution, phase: HermesTerminalPhase, stored: string, rows: HermesHistoryRow[]): Awaitable<boolean>;
  read(key: string): Awaitable<HermesExecution | null>;
};
export type HermesTerminalNative = {
  current(): boolean;
  snapshot(live: string): Promise<unknown>;
  history(live: string): Promise<HermesHistoryRow[]>;
};

export function hermesTerminalReceiptMatches(original: HermesExecution, settled: HermesExecution | null, phase: HermesExecution['phase']): settled is HermesExecution {
  return !!settled && settled.phase === phase && settled.row === original.row
    && settled.updated >= original.updated && ['key', 'id', 'live', 'epoch', 'at'].every(field =>
      settled[field as keyof HermesExecution] === original[field as keyof HermesExecution])
    && JSON.stringify(settled.members) === JSON.stringify(original.members)
    && JSON.stringify(settled.batch) === JSON.stringify(original.batch);
}
const same = hermesTerminalReceiptMatches;

/** Shared by the original runtime and the sole-owner facade. Native effects
 * remain in their executor. No prompt, mutation retry or unknown recovery. */
export async function settleHermesTerminal(execution: HermesExecution, phase: HermesTerminalPhase,
  port: HermesTerminalPort, history: Pick<HermesHistoryPort, 'snapshot' | 'projection'>,
  native: HermesTerminalNative, diagnostics: PerformanceDiagnostics = performanceDiagnostics,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 100))
): Promise<{ execution: HermesExecution; messages: ChatMessage[] }> {
  const trace = guardedTrace(diagnostics, 'hermes-terminal-settlement');
  const expected = structuredClone(execution);
  let failed = true;
  const current = () => {
    if (native.current() !== true || !same(expected, execution, 'running')) throw Error('Hermes terminal execution changed');
  };
  try {
    current();
    if (expected.phase !== 'running' || !Number.isSafeInteger(expected.row) || expected.row! <= 0
      || !['completed', 'failed', 'interrupted'].includes(phase)) throw Error('Hermes terminal lineage missing');
    trace.add('step', 1);
    let stored: string | undefined;
    // The native complete event can precede its worker's finally cleanup.
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await native.snapshot(expected.live); current();
      if (!record(snapshot) || snapshot.session_id !== expected.live
        || typeof snapshot.session_key !== 'string' || !snapshot.session_key || snapshot.session_key.length > 256
        || /[\x00-\x1f\x7f]/.test(snapshot.session_key)
        || record(snapshot.info) && snapshot.info.stored_session_id && snapshot.info.stored_session_id !== snapshot.session_key) {
        throw Error('Hermes terminal snapshot identity changed');
      }
      const retainedFailure = phase === 'failed' && record(snapshot.inflight)
        && snapshot.inflight.status === 'error' && snapshot.inflight.streaming === false;
      if (snapshot.queued || snapshot.hydrating || snapshot.auto_continue || snapshot.pending_approval || snapshot.pending_connection
        || Array.isArray(snapshot.open_requests) && snapshot.open_requests.length) throw Error('Hermes terminal has unmanaged work');
      if (snapshot.status === 'idle' && snapshot.running === false && (!snapshot.inflight || retainedFailure)) {
        stored = snapshot.session_key; break;
      }
      if (attempt < 49) { await pause(); current(); }
    }
    if (!stored) throw Error('Hermes terminal did not settle');
    trace.add('step', 2);
    const rows = structuredClone(await native.history(expected.live)); current();
    if (!rows.some(row => row.role === 'user' && row.row_id === expected.row)) throw Error('Hermes terminal input lineage changed');
    trace.add('step', 3);
    if (await port.terminal(expected, phase, stored, rows) !== true) throw Error('Hermes terminal commit not confirmed');
    current();
    const settled = await port.read(expected.key); current();
    if (!same(expected, settled, phase)) throw Error('Hermes terminal receipt changed');
    const snapshot = await history.snapshot(expected.key); current();
    if (!snapshot || snapshot.key !== expected.key || snapshot.unknown || snapshot.stored !== stored) throw Error('Hermes terminal history changed');
    trace.add('step', 4);
    const messages = await history.projection(snapshot); current();
    if (!messages) throw Error('Hermes terminal projection changed');
    // Reading the same terminal receipt and revision AGAIN closes the gap
    // between the original receipt read and the last paginated history read.
    const confirmed = await port.read(expected.key); current();
    const finalSnapshot = await history.snapshot(expected.key); current();
    if (!same(expected, confirmed, phase) || confirmed.updated !== settled.updated
      || !finalSnapshot || finalSnapshot.key !== expected.key || finalSnapshot.stored !== stored || finalSnapshot.unknown
      || finalSnapshot.digest !== snapshot.digest) throw Error('Hermes terminal projection superseded');
    trace.add('settled', 1); failed = false;
    return { execution: confirmed, messages };
  } finally { trace.finish(failed); }
}

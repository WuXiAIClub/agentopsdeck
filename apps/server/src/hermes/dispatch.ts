import { randomUUID } from 'node:crypto';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HermesDispatchPlan } from './dispatch-admission.js';
import type { HermesExecution } from './journal.js';
import type { HermesHistoryRow } from './history.js';
import { record } from './protocol.js';

export type HermesDispatchPort = {
  plan(key: string): Promise<HermesDispatchPlan | 'blocked' | null>;
  claim(plan: HermesDispatchPlan, live: string, epoch: string, id: string): Promise<HermesExecution | null>;
  nativeReady(execution: HermesExecution): Promise<boolean>;
  admitted(execution: HermesExecution): Promise<boolean>;
  unknown(execution: HermesExecution): Promise<unknown>;
  preparationFailed?(key: string, head: string): Promise<boolean>;
};
export type HermesDispatchNative = { available(): boolean; epoch(): string | undefined;
  attach(key: string): Promise<string>; history(live: string): Promise<HermesHistoryRow[]>;
  submit(live: string, text: string): Promise<unknown> };
export type HermesDispatchResult = 'not_started' | 'blocked' | 'admitted' | 'unknown';

/** One shared consumer of original journal commands, including the real runtime.
 * There is no retry: durable claim precedes exactly one native submit. */
export async function dispatchHermes(key: string, port: HermesDispatchPort, native: HermesDispatchNative,
  events: { claimed(execution: HermesExecution): void; admitted(execution: HermesExecution, rows: HermesHistoryRow[]): Promise<void> },
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): Promise<HermesDispatchResult> {
  const epoch = native.epoch();
  const available = () => !!epoch && native.available() === true && native.epoch() === epoch;
  if (!available()) return 'not_started';
  const trace = guardedTrace(diagnostics, 'hermes-async-dispatch');
  let execution: HermesExecution | undefined, head: string | undefined, failed = false;
  try {
    trace.add('step', 1);
    const eligible = await port.plan(key);
    if (!eligible || !available()) return 'not_started';
    if (eligible === 'blocked') return 'blocked';
    head = eligible.members[0];
    const live = await native.attach(key);
    if (!available()) return 'not_started';
    const before = structuredClone(await native.history(live));
    if (!available()) return 'not_started';
    // Native preparation can change an unstarted session's stored identity,
    // and queued edits/new messages can arrive during either await. Preserve
    // the original runtime's fresh FIFO selection after preparation, rather
    // than silently abandoning a now-stale plan and stranding the queue.
    const selected = await port.plan(key);
    if (!selected || !available()) return 'not_started';
    if (selected === 'blocked') return 'blocked';
    const plan = structuredClone(selected);
    trace.add('step', 2);
    execution = await port.claim(plan, live, epoch!, randomUUID()) ?? undefined;
    if (!execution) return 'not_started';
    events.claimed(execution);
    if (!available() || execution.phase !== 'starting') throw Error('Hermes claim no longer current');
    // Neither plan nor claim is a permission lease. No async preparation may
    // be inserted between this fresh worker check and the original submission.
    if (await port.nativeReady(execution) !== true || !available() || execution.phase !== 'starting') throw Error('Hermes dispatch authority changed');
    trace.add('step', 3);
    const ack = await native.submit(live, plan.text);
    if (!record(ack) || ack.status !== 'streaming' || !available() || execution.phase !== 'starting') throw Error('Unconfirmed Hermes admission');
    const after = structuredClone(await native.history(live));
    if (!available() || execution.phase !== 'starting') throw Error('Hermes disconnected during admission');
    // Only durable append-only row identity proves the original input. Never
    // infer acceptance from equal prompt text or timestamps.
    const oldUsers = before.filter(row => row.role === 'user'), newUsers = after.filter(row => row.role === 'user');
    if (newUsers.length !== oldUsers.length + 1 || newUsers.some(row => !Number.isSafeInteger(row.row_id) || row.row_id! <= 0)
      || new Set(newUsers.map(row => row.row_id)).size !== newUsers.length
      || oldUsers.some((row, index) => row.row_id === undefined || row.row_id !== newUsers[index]!.row_id)) throw Error('Ambiguous Hermes durable input identity');
    const admitted: HermesExecution = { ...execution, row: newUsers.at(-1)!.row_id!, phase: 'running', updated: Date.now() };
    // Keep the local phase starting until the awaited original commit succeeds:
    // terminal events arriving during IPC must stay in the early-event buffer.
    if (await port.admitted(admitted) !== true || !available() || execution.phase !== 'starting') throw Error('Hermes original admission no longer current');
    Object.assign(execution, admitted);
    trace.add('step', 4); trace.add('admitted', 1);
    await events.admitted(execution, after);
    failed = false;
    return 'admitted';
  } catch (error) {
    failed = true;
    if (!execution) {
      if (head && await port.preparationFailed?.(key, head) === true) return 'blocked';
      throw error;
    }
    try { await port.unknown(execution); } catch { /* Original durable claim stays protected; never requeue. */ }
    trace.add('classificationUnknown', 1);
    return 'unknown';
  } finally { trace.finish(failed); }
}

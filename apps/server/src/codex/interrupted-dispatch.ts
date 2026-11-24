import { visitRollout, type RolloutSource } from './rollout-projection.js';

export class InterruptedDispatchUnconfirmed extends Error {
  constructor() {
    super('Native tool cleanup is unconfirmed: the code-execution wrapper was interrupted; dispatched tools may still be running. Do not resend the command.');
  }
}

/** An aborted code-execution wrapper is not proof that the native commands
 * it dispatched were cancelled. In particular, commandExecution may arrive
 * AFTER turn/completed and an empty backgroundTerminals snapshot. Never infer
 * quiescence from a delay, the wrapper's user-facing output, or parsed JS input.
 *
 * This conservative guard intentionally does not auto-recover such a turn.
 * Recovery needs native dispatch completion evidence that this protocol does
 * not currently expose, or a separately verified operator recovery workflow.
 */
export function requireInterruptedDispatchSettled(rollout: string, turn: { id: string; status: string }): void;
export function requireInterruptedDispatchSettled(rollout: RolloutSource, turn: { id: string; status: string }): void | Promise<void>;
export function requireInterruptedDispatchSettled(rollout: RolloutSource, turn: { id: string; status: string }): void | Promise<void> {
  if (turn.status !== 'interrupted') return;
  let currentTurn: string | undefined;
  const calls = new Set<string>(), outputs = new Map<string, unknown>();
  return visitRollout(rollout, line => {
    if (!line.trim()) return;
    let record: any;
    try { record = JSON.parse(line); } catch { return; }
    const payload = record?.payload;
    if (record?.type === 'turn_context' || (record?.type === 'event_msg' && payload?.type === 'task_started')) {
      currentTurn = typeof payload?.turn_id === 'string' ? payload.turn_id : currentTurn;
    }
    if (record?.type !== 'response_item' || currentTurn !== turn.id || typeof payload?.call_id !== 'string') return;
    if (['custom_tool_call', 'function_call'].includes(payload.type)
      && typeof payload.name === 'string' && payload.name.split('.').at(-1) === 'exec') calls.add(payload.call_id);
    if (['custom_tool_call_output', 'function_call_output'].includes(payload.type)) outputs.set(payload.call_id, payload.output);
  }, () => {
  for (const call of calls) {
    const output = outputs.get(call);
    if (!outputs.has(call) || (typeof output === 'string' && /^\s*aborted by user(?:\s|$)/i.test(output))) {
      throw new InterruptedDispatchUnconfirmed();
    }
  }
  });
}

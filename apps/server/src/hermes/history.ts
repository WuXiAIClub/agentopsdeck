import type { ChatMessage } from '@agentopsdeck/shared';
import { expandBatchMessage } from '../codex/queued-batch.js';
import type { HermesExecution, HermesSession } from './journal.js';

export type HermesHistoryRow = { row_id?: number; hidden?: boolean; role: ChatMessage['role']; text: string;
  timestamp: number; toolName?: string };

/** Original native history mapping, shared by the executor and sole SQL owner.
 * Native rows do not contain stable tool-call identities or tool outcomes. */
export function hermesHistory(session: HermesSession, bindings: Map<number, HermesExecution>, rows: HermesHistoryRow[]): ChatMessage[] {
  const key = session.key, tools = session.messages.filter(message => message.id.startsWith('hermes-tool:'));
  const matched = new Set<string>();
  let turn: HermesExecution | undefined, turnId = `hermes:${session.stored}:initial`, toolIndex = 0, timestamp = 0;
  const messages = rows.flatMap((row, index): ChatMessage[] => {
    if (row.hidden) return [];
    if (row.role === 'user') {
      turn = row.row_id ? bindings.get(row.row_id) : undefined;
      turnId = turn?.id ?? `hermes:${session.stored}:${row.row_id ?? index}`; toolIndex = 0;
    }
    timestamp = row.timestamp || timestamp;
    if (row.role === 'tool') {
      const prior = tools.find(tool => tool.turnId === turnId && tool.toolPhase === 'call'
        && tool.toolName === row.toolName && !matched.has(tool.id));
      const id = `hermes-history-tool:${turnId}:${toolIndex++}`;
      if (prior) { matched.add(prior.id); return []; }
      return [{ id, sessionKey: key, turnId, role: 'tool', toolName: row.toolName ?? 'tool', toolCallId: id,
        toolPhase: 'result', text: `Tool: ${row.toolName ?? 'tool'}\nRecorded in native history; result unavailable`,
        status: 'sent', createdAt: timestamp }];
    }
    const execution = row.role === 'user' && row.row_id ? bindings.get(row.row_id) : undefined;
    const message: ChatMessage = { id: execution?.members[0] ?? `hermes:${session.stored}:${row.row_id ?? `snapshot:${index}`}`,
      sessionKey: key, turnId, role: row.role, text: row.text, status: 'sent', createdAt: timestamp };
    return execution?.batch ? expandBatchMessage(message, execution.batch) : [message];
  });
  return [...messages, ...tools].sort((a, b) => a.createdAt - b.createdAt);
}

export function hermesUnconfirmedTools(session: HermesSession, execution: HermesExecution): ChatMessage[] {
  return session.messages.filter(message => message.turnId === execution.id && message.toolPhase === 'call'
    && !session.messages.some(result => result.toolCallId === message.toolCallId && result.toolPhase === 'result'))
    .map(call => ({ ...call, id: call.id.replace(/:call$/, ':result'), toolPhase: 'result',
      text: `Tool: ${call.toolName}\nOutcome not confirmed`, status: 'outcome_unknown', createdAt: Date.now() }));
}

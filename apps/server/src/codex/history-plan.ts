import type { ChatMessage } from '@agentopsdeck/shared';
import type { CodexBatch } from './queued-batch.js';
import { expandBatchMessage } from './queued-batch.js';
import type { CodexStartupPayload } from './startup-recovery.js';
import type { QueuedTurn } from '../commands/turn-queue.js';
import type { CodexStartupMetadata } from '../connector/connector-codex-startup-domain.js';

/** DISPLAY-only, never a claim/permission/idle proof. No SQL during apply. */
export type CodexHistoryPlan = {
  messages: ChatMessage[];
  sourceIds: string[];
  queue: { entry: QueuedTurn<CodexStartupPayload>; metadata: Pick<CodexStartupMetadata, 'version' | 'headId' | 'executionCommandId'> }[];
};
export interface CodexHistoryReader {
  prepare(sessionKey: string, messages: ChatMessage[]): Promise<CodexHistoryPlan>;
  close(): Promise<void>;
}

export function expandCodexHistory(messages: ChatMessage[], readBatch: (runId: string) => CodexBatch | undefined) {
  const batches = new Map<string, { batch: CodexBatch; matches: number }>();
  const absent = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' || !message.turnId || absent.has(message.turnId)) continue;
    const batch = batches.get(message.turnId)?.batch ?? readBatch(message.turnId);
    if (!batch) { absent.add(message.turnId); continue; }
    const entry = batches.get(message.turnId) ?? { batch, matches: 0 };
    if (message.text.includes(batch.separator)) entry.matches++;
    batches.set(message.turnId, entry);
  }
  for (const entry of batches.values()) if (entry.matches !== 1) {
    // Count only; neither user text nor native identity belongs in this error.
    throw new Error(`Native batch history identity is ambiguous or missing (matches=${entry.matches})`);
  }
  const expanded = messages.flatMap(message => {
    const batch = message.role === 'user' && message.turnId ? batches.get(message.turnId)?.batch : undefined;
    return batch && message.text.includes(batch.separator) ? expandBatchMessage(message, batch) : [message];
  });
  if (new Set(expanded.map(message => message.id)).size !== expanded.length) throw new Error('Invalid Codex expanded history message identity');
  return expanded;
}

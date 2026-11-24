import type { ClaudeConfig } from './config.js';
import type { SdkExecution } from '../connector/sdk-execution-journal.js';
import type { ClaudeNativeTurn } from './dispatch-adapter.js';
import type { ClaudeProjectedMessage } from './message-projection.js';
import type { ClaudeTextStream, ClaudeStreamFinal } from './stream-projection.js';
import type { ClaudeToolDetail } from './tool-details.js';

export type ClaudeWorkerStart = { kind: 'start'; config: ClaudeConfig; execution: SdkExecution; text: string; context?: string; taskFiles?: string[]; interactionMode?: 'automatic' | 'interactive'; attachments?: import('../connector/sdk-attachment-input.js').SdkInputAttachment[] };
export type ClaudeWorkerCompact = import('../connector/sdk-compact-worker.js').CompactWorkerRequest<ClaudeConfig>;
export type ClaudeWorkerPreflightRequest = { kind: 'preflight'; config: ClaudeConfig };
export type ClaudeWorkerCompletionAck = { kind: 'finished-ack'; id: string; nativeSessionId: string };
export type ClaudeWorkerDeletion = import('../connector/private-worker-preflight.js').PrivateWorkerDeletion & { config: ClaudeConfig };
export type ClaudeHistoryIdentity = Awaited<ReturnType<ClaudeNativeTurn['historyIdentities']>>[number];
export const claudeWorkerFailureCodes = ['configuration', 'policy', 'credential', 'native', 'process-group', 'history', 'shutdown'] as const;
export type ClaudeWorkerFailureCode = typeof claudeWorkerFailureCodes[number];
export type ClaudeWorkerReply =
  | import('../commands/interaction-wire.js').InteractionWorkerFrame
  | import('../connector/sdk-compact-worker.js').CompactWorkerReply
  | { kind: 'delete-complete'; id: string; nativeSessionId: string }
  | { kind: 'preflight-complete' }
  | import('../connector/private-worker-preflight.js').PrivateWorkerPreflightFailure
  | { kind: 'event'; event: Record<string, unknown> }
  | { kind: 'interrupted' }
  | { kind: 'projection'; rows: ClaudeProjectedMessage[]; stream?: ClaudeStreamFinal; details?: ClaudeToolDetail[] }
  | { kind: 'stream'; snapshot: ClaudeTextStream }
  | { kind: 'metrics'; nativeSessionId: string; sample: import('../connector/sdk-metrics.js').SdkMetricSample }
  | { kind: 'finished'; history: ClaudeHistoryIdentity[]; streamError: boolean }
  | { kind: 'failed'; code?: ClaudeWorkerFailureCode };

/** Lifecycle transport deliberately excludes prompts, tool bodies, stderr,
 * costs and raw errors. Bounded text/tool projection is a separate layer. */
export function claudeLifecycleFrame(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid Claude event');
  const input = event as Record<string, unknown>, output: Record<string, unknown> = {};
  for (const name of ['type', 'subtype', 'session_id', 'uuid', 'parent_tool_use_id', 'user_message_uuid',
    'claude_code_version', 'task_id', 'status']) {
    if (input[name] === undefined) continue;
    if (input[name] !== null && (typeof input[name] !== 'string' || (input[name] as string).length > 512)) throw new Error('Invalid Claude event');
    output[name] = input[name];
  }
  for (const name of ['is_error', 'queued_turn_count']) if (input[name] !== undefined) {
    if (name === 'is_error' ? typeof input[name] !== 'boolean' : !Number.isSafeInteger(input[name])) throw new Error('Invalid Claude event');
    output[name] = input[name];
  }
  if (input.user_message_uuids !== undefined) {
    if (!Array.isArray(input.user_message_uuids) || input.user_message_uuids.length > 16
      || input.user_message_uuids.some(id => typeof id !== 'string' || id.length > 512)) throw new Error('Invalid Claude event');
    output.user_message_uuids = [...input.user_message_uuids];
  }
  if (input.message && typeof input.message === 'object') {
    const role = (input.message as Record<string, unknown>).role;
    if (typeof role === 'string' && role.length < 32) output.message = { role };
  }
  return output;
}

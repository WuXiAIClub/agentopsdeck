import type { SdkExecution } from '../connector/sdk-execution-journal.js';
import type { CopilotConfig } from './config.js';
import type { CopilotHistoryIdentity } from './dispatch-adapter.js';
import type { CopilotProjectedMessage } from './message-projection.js';
import type { CopilotTextStream } from './stream-projection.js';
import type { CopilotToolDetail } from './tool-details.js';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { BOARD_CONTEXT_MAX_CHARS } from '../connector/workspace-board-file-format.js';
import { validTurnFiles } from '../connector/sdk-turn-context.js';

export type CopilotWorkerStart = { kind: 'start'; config: CopilotConfig; execution: SdkExecution; text: string; context?: string; taskFiles?: string[]; interactionMode?: 'automatic' | 'interactive'; attachments?: import('../connector/sdk-attachment-input.js').SdkInputAttachment[] };
export type CopilotWorkerCompact = import('../connector/sdk-compact-worker.js').CompactWorkerRequest<CopilotConfig>;
export type CopilotWorkerPreflight = { kind: 'preflight'; config: CopilotConfig };
export type CopilotWorkerDeletion = import('../connector/private-worker-preflight.js').PrivateWorkerDeletion & { config: CopilotConfig };
export type CopilotWorkerReply =
  | import('../commands/interaction-wire.js').InteractionWorkerFrame
  | import('../connector/sdk-compact-worker.js').CompactWorkerReply
  | { kind: 'delete-complete'; id: string; nativeSessionId: string }
  | { kind: 'preflight-complete' }
  | { kind: 'verified'; sessionId: string; version: string; protocolVersion: number }
  | { kind: 'admitted'; messageId: string }
  | { kind: 'event'; event: CopilotLifecycleFrame }
  | { kind: 'projection'; row: CopilotProjectedMessage; detail?: CopilotToolDetail }
  | { kind: 'stream'; snapshot: CopilotTextStream }
  | { kind: 'metrics'; nativeSessionId: string; sample: import('../connector/sdk-metrics.js').SdkMetricSample }
  | { kind: 'interrupted' }
  | { kind: 'finished'; sessionId: string; history: CopilotHistoryIdentity[] }
  | { kind: 'failed' };
export type CopilotLifecycleFrame = { id: string; type: string; agentId?: string; data: Record<string, string | boolean> };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(v);
const denied = () => new Error('Invalid Copilot lifecycle frame');

/** Public session identity and native identity are independently allocated by
 * the journal. Only the latter is passed to the CLI or used as a file path. */
export function validateCopilotWorkerStart(request: CopilotWorkerStart): void {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (request.kind !== 'start' || !request.execution || request.execution.kind === 'compact' || !uuid.test(request.execution.id)
    || !uuid.test(request.execution.nativeSessionId) || typeof request.execution.key !== 'string'
    || !/^ghcp:[A-Za-z0-9_-]{1,512}$/.test(request.execution.key)
    || !['create', 'resume'].includes(request.execution.nativeMode) || typeof request.text !== 'string'
    || !request.text.trim() || request.text.length > MAX_MESSAGE_CHARS
    || request.context !== undefined && (typeof request.context !== 'string' || request.context.length > BOARD_CONTEXT_MAX_CHARS)
    || request.taskFiles !== undefined && !validTurnFiles(request.taskFiles)
    || request.interactionMode !== undefined && !['automatic', 'interactive'].includes(request.interactionMode)) throw denied();
}

/** Allowlist by event type, never recursively copy native objects. Prompts,
 * model output, tool bodies, stderr and raw errors use no lifecycle channel. */
export function copilotLifecycleFrame(value: unknown): CopilotLifecycleFrame {
  if (!record(value) || !identifier(value.id) || typeof value.type !== 'string'
    || !/^[a-z][a-z0-9_.]{0,127}$/.test(value.type) || !record(value.data)) throw denied();
  const output: CopilotLifecycleFrame = { id: value.id, type: value.type, data: {} };
  if (value.agentId !== undefined) {
    if (!identifier(value.agentId)) throw denied();
    output.agentId = value.agentId;
  }
  const names = value.type === 'user.message' ? ['messageId']
    : value.type === 'assistant.message' ? ['messageId', 'originatingMessageId']
    : value.type === 'tool.execution_start' || value.type === 'tool.execution_complete' ? ['toolCallId'] : [];
  for (const name of [...names, 'parentToolCallId']) {
    if (value.data[name] === undefined) continue;
    if (!identifier(value.data[name])) throw denied();
    output.data[name] = value.data[name];
  }
  const boolean = value.type === 'session.idle' ? 'aborted' : value.type === 'tool.execution_complete' ? 'success' : undefined;
  if (boolean && value.data[boolean] !== undefined) {
    if (typeof value.data[boolean] !== 'boolean') throw denied();
    output.data[boolean] = value.data[boolean];
  }
  return output;
}

/** Bounded identity envelope only; caller must separately bound native IO.
 * Do not call this validation a pagination or raw-history memory bound. */
export function copilotHistoryIdentities(events: unknown): CopilotHistoryIdentity[] {
  if (!Array.isArray(events) || events.length > 100_000) throw denied();
  const entries: CopilotHistoryIdentity[] = [];
  const ids = new Set<string>();
  for (const event of events) {
    if (!record(event)) throw denied();
    if (!['user.message', 'assistant.message'].includes(event.type as string)) continue;
    const frame = copilotLifecycleFrame(event);
    if (frame.agentId !== undefined || frame.data.parentToolCallId !== undefined) continue;
    if (!identifier(frame.data.messageId) || ids.has(frame.id) || entries.length >= 10_000) throw denied();
    ids.add(frame.id);
    entries.push({ id: frame.id, type: frame.type as CopilotHistoryIdentity['type'], messageId: frame.data.messageId,
      ...(typeof frame.data.originatingMessageId === 'string' ? { originatingMessageId: frame.data.originatingMessageId } : {}) });
  }
  return entries;
}

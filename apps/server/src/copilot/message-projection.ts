import { copilotLifecycleFrame, type CopilotLifecycleFrame } from './worker-protocol.js';
import { normalizeSourceFiles, type SourceFileChange } from '@agentopsdeck/shared';

export const COPILOT_MESSAGE_TEXT_LIMIT = 100_000;
export type CopilotMessageScope = { agentId?: string; parentToolCallId?: string };
export type CopilotProjectedMessage = CopilotMessageScope & {
  nativeEventId: string; role: 'user' | 'assistant' | 'tool'; messageId?: string;
  text: string; truncated: boolean; createdAt: number;
  toolCallId?: string; toolName?: string; toolPhase?: 'call' | 'result'; toolError?: boolean;
  sourceFiles?: SourceFileChange[];
};
export const copilotIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Invalid Copilot message projection');

/** Stable assistant identity across delta/final/reopen, not transient event
 * UUIDs. Child scope is part of the key, never flattened into the root. */
export function copilotMessageId(key: string, scope: CopilotMessageScope, role: string, identity: string) {
  const prefix = key.startsWith('antigravity:') ? 'antigravity-message' : 'ghcp-message';
  return `${prefix}:${Buffer.from(JSON.stringify([key, scope.agentId ?? null, scope.parentToolCallId ?? null, role, identity])).toString('base64url')}`;
}

export function projectCopilotMessage(value: unknown): CopilotProjectedMessage | undefined {
  const frame = copilotLifecycleFrame(value);
  if (!['user.message', 'assistant.message', 'tool.execution_start', 'tool.execution_complete'].includes(frame.type)) return;
  const event = value as { timestamp?: unknown; data: Record<string, unknown> };
  const time = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
  if (!Number.isSafeInteger(time) || time < 0) throw invalid();
  const base: CopilotMessageScope & { nativeEventId: string; createdAt: number } = {
    nativeEventId: frame.id, createdAt: time,
    ...(frame.agentId ? { agentId: frame.agentId } : {}),
    ...(typeof frame.data.parentToolCallId === 'string' ? { parentToolCallId: frame.data.parentToolCallId } : {}),
  };
  if (frame.type === 'user.message' || frame.type === 'assistant.message') {
    if (!copilotIdentifier(frame.data.messageId) || typeof event.data.content !== 'string') throw invalid();
    return { ...base, role: frame.type === 'user.message' ? 'user' : 'assistant', messageId: frame.data.messageId,
      text: event.data.content.slice(0, COPILOT_MESSAGE_TEXT_LIMIT), truncated: event.data.content.length > COPILOT_MESSAGE_TEXT_LIMIT };
  }
  if (!copilotIdentifier(frame.data.toolCallId)) throw invalid();
  if (frame.type === 'tool.execution_start') {
    if (typeof event.data.toolName !== 'string' || !/^[A-Za-z0-9_.:/-]{1,512}$/.test(event.data.toolName)) throw invalid();
    return { ...base, role: 'tool', toolCallId: frame.data.toolCallId, toolName: event.data.toolName,
      toolPhase: 'call', text: event.data.toolName, truncated: false };
  }
  if (typeof frame.data.success !== 'boolean') throw invalid();
  // Raw results/errors/binary attachments are deliberately not eager history.
  // This is only an execution summary; lazy authorized details are separate.
  return { ...base, role: 'tool', toolCallId: frame.data.toolCallId, toolPhase: 'result',
    text: '', truncated: false, toolError: !frame.data.success };
}

/** Parent validates and copies only known fields. Adjacent lifecycle frame
 * binds the projection to the exact native event and child scope. */
export function validateCopilotProjection(value: unknown, event: CopilotLifecycleFrame): CopilotProjectedMessage {
  if (!record(value) || value.nativeEventId !== event.id || value.agentId !== event.agentId
    || value.parentToolCallId !== event.data.parentToolCallId || typeof value.text !== 'string'
    || value.text.length > COPILOT_MESSAGE_TEXT_LIMIT || typeof value.truncated !== 'boolean'
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) throw invalid();
  const projected = projectCopilotMessage({ ...event, timestamp: new Date(value.createdAt as number).toISOString(),
    data: { ...event.data, content: value.text, toolName: value.toolName } });
  if (!projected || projected.role !== value.role || projected.messageId !== value.messageId
    || projected.toolCallId !== value.toolCallId || projected.toolName !== value.toolName
    || projected.toolPhase !== value.toolPhase || projected.toolError !== value.toolError
    || projected.text !== value.text || projected.role === 'tool' && value.truncated) throw invalid();
  const files = projected.toolPhase === 'result' && projected.toolError === false ? normalizeSourceFiles(value.sourceFiles) : [];
  return { ...projected, truncated: value.truncated, ...(files.length ? { sourceFiles: files } : {}) };
}

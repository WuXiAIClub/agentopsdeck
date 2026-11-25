import { MAX_MESSAGE_CHARS, sessionRuntimeId } from '@agentopsdeck/shared';
import { validateClaudeProjection, type ClaudeProjectedMessage } from '../claude/message-projection.js';
import { validateClaudeStreamFinal, validateClaudeTextStream, type ClaudeStreamFinal, type ClaudeTextStream } from '../claude/stream-projection.js';
import { validateClaudeToolDetails, type ClaudeToolDetail } from '../claude/tool-details.js';
import { validateCopilotStoredProjection } from '../copilot/transcript-store.js';
import type { CopilotProjectedMessage } from '../copilot/message-projection.js';
import { validateCopilotStream, type CopilotTextStream } from '../copilot/stream-projection.js';
import { validateCopilotToolDetail, type CopilotToolDetail } from '../copilot/tool-details.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import { validSdkJournalSnapshot } from './connector-sdk-journal-domain.js';

type Scope = { runtime: SdkAgentId; ref: SdkCompactRef };
export type SdkTranscriptAppend =
  | { runtime: 'claude-code'; ref: SdkCompactRef; rows: ClaudeProjectedMessage[]; final?: ClaudeStreamFinal; details?: ClaudeToolDetail[] }
  | { runtime: 'ghcp'; ref: SdkCompactRef; row: CopilotProjectedMessage; submittedText: string; detail?: CopilotToolDetail }
  | { runtime: 'antigravity'; ref: SdkCompactRef; row: CopilotProjectedMessage; submittedText: string; detail?: CopilotToolDetail };
export type SdkTranscriptStream =
  | { runtime: 'claude-code'; ref: SdkCompactRef; snapshot: ClaudeTextStream }
  | { runtime: 'ghcp'; ref: SdkCompactRef; snapshot: CopilotTextStream }
  | { runtime: 'antigravity'; ref: SdkCompactRef; snapshot: CopilotTextStream };
export type SdkTranscriptAck = Scope & { applied: boolean };
export type ConnectorSdkTranscriptCommands = {
  sdkTranscriptAppend: { input: SdkTranscriptAppend; output: SdkTranscriptAck };
  sdkTranscriptStream: { input: SdkTranscriptStream; output: SdkTranscriptAck };
  sdkTranscriptEnd: { input: Scope; output: SdkTranscriptAck };
};
export type ConnectorSdkTranscriptKind = keyof ConnectorSdkTranscriptCommands;
export const connectorSdkTranscriptSteps = Object.freeze({ sdkTranscriptAppend: 99, sdkTranscriptStream: 100, sdkTranscriptEnd: 101 });
// Original summary (1 MiB), separate bounded text detail and IPC envelope. The
// original owner's 12 MiB aggregate and 128 physical requests still apply.
export const SDK_TRANSCRIPT_COMMAND_BYTES = 2 * 1024 * 1024;
export const isConnectorSdkTranscriptKind = (k: string): k is ConnectorSdkTranscriptKind => Object.hasOwn(connectorSdkTranscriptSteps, k);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const ref = (v: unknown): v is SdkCompactRef => fields(v, ['key', 'id', 'epoch', 'nativeSessionId'])
  && id(v.key) && id(v.id) && id(v.epoch) && id(v.nativeSessionId);
export const sameSdkTranscriptRef = (a: SdkCompactRef, b: SdkCompactRef) =>
  a.key === b.key && a.id === b.id && a.epoch === b.epoch && a.nativeSessionId === b.nativeSessionId;
const scope = (v: Record<string, unknown>) => ref(v.ref) && (v.runtime === 'claude-code' || v.runtime === 'ghcp' || v.runtime === 'antigravity')
  && sessionRuntimeId(v.ref.key) === v.runtime && v.ref.key !== `${v.runtime}:`;
const claudeRows = (rows: unknown): rows is ClaudeProjectedMessage[] => Array.isArray(rows) && rows.length <= 256
  && rows.every(row => fields(row, ['nativeMessageId', 'blockIndex', 'parentToolUseId', 'role', 'text', 'truncated', 'detailAvailable'],
    ['toolCallId', 'toolName', 'toolPhase', 'toolError', 'sourceFiles']));
export function validConnectorSdkTranscriptInput(k: ConnectorSdkTranscriptKind, v: unknown): boolean {
  try {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !scope(v as Record<string, unknown>)) return false;
    const p = v as Record<string, unknown>;
    if (k === 'sdkTranscriptEnd') return fields(v, ['runtime', 'ref']);
    if (k === 'sdkTranscriptStream') {
      if (!fields(v, ['runtime', 'ref', 'snapshot'])) return false;
      if (p.runtime === 'claude-code') {
        if (!fields(p.snapshot, ['messageId', 'parentToolUseId', 'blocks']) || !Array.isArray(p.snapshot.blocks)
          || !p.snapshot.blocks.every(b => fields(b, ['blockIndex', 'text', 'truncated']))) return false;
        validateClaudeTextStream(p.snapshot);
      } else {
        if (!fields(p.snapshot, ['messageId', 'text', 'truncated'], ['agentId', 'parentToolCallId'])) return false;
        validateCopilotStream(p.snapshot);
      }
      return Buffer.byteLength(JSON.stringify(v)) <= SDK_TRANSCRIPT_COMMAND_BYTES;
    }
    if (p.runtime === 'claude-code') {
      if (!fields(v, ['runtime', 'ref', 'rows'], ['final', 'details']) || !claudeRows(p.rows)) return false;
      const rows = p.rows.length ? validateClaudeProjection(p.rows, p.rows[0]!.nativeMessageId, p.rows[0]!.parentToolUseId) : [];
      if (p.final !== undefined) {
        if (!fields(p.final, ['messageId', 'blockIndexes'])) return false;
        validateClaudeStreamFinal(p.final);
      }
      if (p.details !== undefined && (!Array.isArray(p.details)
        || !p.details.every(d => fields(d, ['blockIndex', 'text', 'truncated'])))) return false;
      validateClaudeToolDetails(p.details ?? [], rows);
    } else {
      if (!fields(v, ['runtime', 'ref', 'row', 'submittedText'], ['detail'])
        || typeof p.submittedText !== 'string' || p.submittedText.length > MAX_MESSAGE_CHARS
        || !fields(p.row, ['nativeEventId', 'role', 'text', 'truncated', 'createdAt'],
          ['agentId', 'parentToolCallId', 'messageId', 'toolCallId', 'toolName', 'toolPhase', 'toolError', 'sourceFiles'])) return false;
      const row = validateCopilotStoredProjection(p.row as CopilotProjectedMessage);
      if (p.detail !== undefined && !fields(p.detail, ['text', 'truncated'])) return false;
      validateCopilotToolDetail(p.detail, row);
    }
    return Buffer.byteLength(JSON.stringify(v)) <= SDK_TRANSCRIPT_COMMAND_BYTES;
  } catch { return false; }
}
export function validConnectorSdkTranscriptOutput(v: unknown): v is SdkTranscriptAck {
  return fields(v, ['runtime', 'ref', 'applied']) && scope(v) && typeof v.applied === 'boolean';
}

/** Exact current intent, not authentication supplied by native code. Public
 * history authorization remains a separate current-reader boundary. All writes
 * use the original journal/transcript/queue/file-index connection and schema. */
export function executeConnectorSdkTranscript<K extends ConnectorSdkTranscriptKind>(k: K,
  input: ConnectorSdkTranscriptCommands[K]['input'], owner: ConnectorUserStore): SdkTranscriptAck {
  if (!validConnectorSdkTranscriptInput(k, input)) throw Error('connector_storage_unavailable');
  const journal = input.runtime === 'claude-code' ? owner.claudeJournal : input.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
  const snapshot = journal.readSnapshot(input.ref.key), execution = snapshot.execution;
  const ack = (applied: boolean): SdkTranscriptAck => ({ runtime: input.runtime, ref: { ...input.ref }, applied });
  if (!validSdkJournalSnapshot(snapshot)) throw Error('connector_storage_unavailable');
  if (snapshot.deletion || !snapshot.session || snapshot.session.nativeSessionId !== input.ref.nativeSessionId
    || !execution || execution.kind === 'compact' || !sameSdkTranscriptRef(execution, input.ref)) return ack(false);
  const transcript = input.runtime === 'claude-code' ? owner.claudeTranscript : input.runtime === 'ghcp' ? owner.copilotTranscript : owner.antigravityTranscript;
  if (k === 'sdkTranscriptEnd') { transcript.endStreams(input.ref); return ack(true); }
  if (!(k === 'sdkTranscriptStream' ? ['dispatching', 'running'] : ['dispatching', 'running', 'settling']).includes(execution.phase)) return ack(false);
  if (k === 'sdkTranscriptAppend') {
    const p = input as SdkTranscriptAppend;
    if (p.runtime === 'claude-code') owner.claudeTranscript.append(p.ref, p.rows, p.final, p.details);
    else if (p.runtime === 'ghcp') owner.copilotTranscript.append(p.ref, p.row, p.submittedText, p.detail);
    else owner.antigravityTranscript.append(p.ref, p.row, p.submittedText, p.detail);
    return ack(true);
  }
  const p = input as SdkTranscriptStream;
  return ack(p.runtime === 'claude-code'
    ? owner.claudeTranscript.updateStream(p.ref, p.snapshot)
    : p.runtime === 'ghcp'
      ? owner.copilotTranscript.updateStream(p.ref, p.snapshot)
      : owner.antigravityTranscript.updateStream(p.ref, p.snapshot));
}

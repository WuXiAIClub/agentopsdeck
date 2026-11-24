import { sdkSessionView } from '../connector/sdk-session-view.js';
import type { ChatMessage } from '@agentopsdeck/shared';
import type { SdkExecution, SdkSession } from '../connector/sdk-execution-journal.js';
import type { ClaudeStoredMessage } from './transcript-store.js';
import { validateClaudeProjection } from './message-projection.js';

const invalid = () => new Error('Claude session projection identity is invalid');
const validKey = (key: string) => key.startsWith('claude-code:') && key.length > 'claude-code:'.length;
export const claudeSessionView = (session: SdkSession, execution: SdkExecution | undefined, ready: boolean) =>
  sdkSessionView('claude-code', session, execution, ready);

// Tuple encoding prevents delimiter collisions and scopes native IDs to the
// session and root/child context. Stable across refresh, pagination and restart.
const identity = (key: string, parent: string | null, id: string, block?: number) =>
  `claude:${Buffer.from(JSON.stringify([key, parent, id, ...(block === undefined ? [] : [block])])).toString('base64url')}`;

export function claudeMessageAnchor(key: string, value: string) {
  try {
    if (value.length > 4096 || !value.startsWith('claude:')) return;
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(7), 'base64url').toString());
    if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== key
      || decoded[1] !== null && typeof decoded[1] !== 'string' || typeof decoded[2] !== 'string'
      || !Number.isSafeInteger(decoded[3]) || decoded[3] < 0 || decoded[3] > 255
      || identity(key, decoded[1], decoded[2], decoded[3]) !== value) return;
    return { parentToolUseId: decoded[1] as string | null, nativeMessageId: decoded[2] as string, blockIndex: decoded[3] as number };
  } catch { return; }
}

/** Map only already-bounded durable rows. No SDK or native history access, no
 * whole tool bodies, no guessed ctx/model/usage, no per-read timestamps. */
export function claudeChatMessages(key: string, messages: readonly ClaudeStoredMessage[]): ChatMessage[] {
  if (!validKey(key)) throw invalid();
  return messages.flatMap(message => {
    if (message.sessionKey !== key || !message.rows.length || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0) throw invalid();
    const rows = validateClaudeProjection(message.rows, message.nativeMessageId, message.rows[0]!.parentToolUseId);
    return rows.map(row => {
      const result: ChatMessage = { id: message.admissions?.[row.blockIndex] ?? message.displayIds?.[row.blockIndex] ?? identity(key, row.parentToolUseId, row.nativeMessageId, row.blockIndex),
        sessionKey: key, turnId: message.executionId, role: row.role, text: row.text,
        createdAt: message.createdAt,
        // Keep the native parent reference, including nested subagents. Do
        // not invent a root-scoped tool ID without knowing the parent's scope.
        ...(row.parentToolUseId === null ? {} : { parentToolUseId: row.parentToolUseId }),
        ...(row.truncated ? { contentTruncated: true } : {}),
      };
      // An assistant message may be followed by more tools/model turns. Only
      // native lifecycle settlement can establish a final answer/run outcome.
      if (row.role === 'user') result.status = message.admissionStatuses?.[row.blockIndex] ?? 'sent';
      if (row.role === 'tool') {
        result.toolCallId = identity(key, row.parentToolUseId, row.toolCallId!);
        result.toolPhase = row.toolPhase!;
        if (row.toolName !== undefined) result.toolName = row.toolName;
        result.toolPreview = row.text;
        result.toolDetailAvailable = message.detailBlocks?.includes(row.blockIndex) ?? false;
        if (row.toolError) result.status = 'failed';
        else if (row.toolPhase === 'result' && row.toolError === false) {
          result.status = 'sent';
          if (row.sourceFiles?.length) result.sourceFiles = row.sourceFiles;
        }
      }
      return result;
    });
  });
}

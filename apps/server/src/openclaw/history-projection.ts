import { nanoid } from 'nanoid';
import type { ActivityEntry, ChatMessage } from '@agentopsdeck/shared';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { DeckStore } from '../projection/deck-store.js';
import { dedupeDisplayMessages, normalizeMessageMedia, normalizeMessageText, normalizeRole } from '../messages/normalize.js';
import { enrichGatewayHistoryFailuresFromRawTranscript, sanitizeFailureReason } from './failure-diagnostics.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { createHistoryRefresh, gatewayHistoryRows, HistoryReadSuperseded } from '../refresh/history.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Bridge = (row: any, role: ChatMessage['role']) => Promise<{
  media: NonNullable<ChatMessage['media']>; bridgedReferences: Set<string>;
}>;
export type OpenClawHistoryOptions = {
  gateway: Pick<GatewayWsClient, 'connectionId' | 'requestWithConnection'>;
  local: boolean;
  readLocal(key: string): Promise<any[]>;
  projection: Pick<DeckStore, 'replaceMessages' | 'replaceActivities'>;
  bridgeMedia: Bridge;
  bridgeArtifacts: Bridge;
  diagnostics?: PerformanceDiagnostics;
};

/** Original Gateway/local history source. A fresh read never turns an error or
 * empty authoritative response into a successful best-effort local snapshot. */
export async function readOpenClawHistoryRows(options: Pick<OpenClawHistoryOptions, 'gateway' | 'local' | 'readLocal'>,
  sessionKey: string, authoritative: boolean) {
  try {
    const { payload, connectionId } = await options.gateway.requestWithConnection('chat.history', { sessionKey, limit: 400 });
    const rows = gatewayHistoryRows(payload, sessionKey);
    if (!options.local) return { rows, connectionId };
    const localRows = await options.readLocal(sessionKey).catch(() => []);
    if (rows.length > 0) return { rows: enrichGatewayHistoryFailuresFromRawTranscript(rows, localRows), connectionId };
    return { rows: !authoritative && localRows.length > 0 ? localRows : rows, connectionId };
  } catch (error) {
    if (authoritative || !options.local) throw error;
    const rows = await options.readLocal(sessionKey).catch(() => []);
    if (rows.length > 0) return { rows, connectionId: undefined };
    throw error;
  }
}

/** Same row/media/activity normalization as the original Connector runtime.
 * Preparing media is an owned physical task, not execution readiness proof. */
export async function projectOpenClawHistoryRows(sessionKey: string, rows: any[],
  options: Pick<OpenClawHistoryOptions, 'bridgeMedia' | 'bridgeArtifacts'>) {
    const messages: ChatMessage[] = [];
    for (const row of rows) {
      const createdAt = Number(row.createdAt ?? row.ts ?? row.timestamp ?? Date.now());
      const updatedAt = row.updatedAt;
      const toolCalls = extractToolCalls(row);
      if (toolCalls.length > 0) {
        const assistantText = nonToolAssistantText(row).trim();
        if (assistantText) {
          messages.push({
            id: String(row.id ?? row.messageId ?? row.ts ?? nanoid()),
            sessionKey,
            role: 'assistant',
            text: assistantText,
            ...rowTerminalAssistantFields(row),
            createdAt,
            updatedAt,
          });
        }
        toolCalls.forEach((toolCall, index) => {
          const fallbackId = `${row.id ?? row.messageId ?? row.ts ?? 'tool-call'}:${index}`;
          messages.push({
            id: String(toolCall.id ?? fallbackId),
            sessionKey,
            role: 'tool',
            text: normalizeMessageText({ payload: toolCall }),
            toolCallId: String(toolCall.id ?? fallbackId),
            ...(typeof toolCall.name === 'string' ? { toolName: toolCall.name } : {}),
            toolPhase: 'call',
            ...rowFailureFields(row),
            createdAt: createdAt + index,
            updatedAt,
          });
        });
        continue;
      }
      const toolResult = extractToolResult(row);
      if (toolResult) {
        const output = normalizeToolResultText(row) || row.output || row.result || row.content;
        messages.push({
          id: String(row.id ?? row.messageId ?? row.ts ?? toolResult.toolCallId ?? nanoid()),
          sessionKey,
          role: 'tool',
          text: normalizeMessageText({
            payload: {
              type: 'toolResult',
              name: toolResult.toolName,
              output,
              error: row.error ?? row.errorMessage,
              status: row.isError ? 'error' : row.status,
            },
          }),
          ...(toolResult.toolCallId ? { toolCallId: toolResult.toolCallId } : {}),
          ...(toolResult.toolName ? { toolName: toolResult.toolName } : {}),
          toolPhase: 'result',
          ...rowTokenUsage(row),
          ...rowFailureFields(row),
          createdAt,
          updatedAt,
        });
        continue;
      }
      const role = normalizeRole(row.role ?? row.authorRole ?? row.message?.role);
      const [bridged, artifacts] = await Promise.all([
        options.bridgeMedia(row, role).catch(() => ({ media: [], bridgedReferences: new Set<string>() })),
        options.bridgeArtifacts(row, role).catch(() => ({ media: [], bridgedReferences: new Set<string>() })),
      ]);
      const bridgedReferences = new Set<string>([...bridged.bridgedReferences, ...artifacts.bridgedReferences]);
      messages.push({
        id: String(row.id ?? row.messageId ?? row.ts ?? nanoid()),
        sessionKey,
        role,
        text: normalizeMessageText(row, { bridgedRawMediaReferences: bridgedReferences }),
        media: [...normalizeMessageMedia(row), ...bridged.media, ...artifacts.media],
        ...rowTokenUsage(row),
        ...rowTerminalAssistantFields(row, role),
        ...rowFailureFields(row),
        createdAt,
        updatedAt,
      });
    }
    return { messages: dedupeDisplayMessages(messages), activities: rowsToActivities(sessionKey, rows) };
}

/** No SQL or native dispatch. Both production assemblies use this original
 * reader; the async application must share, invalidate and drain it, not create
 * a second source behind the public HTTP facade. */
export function createOpenClawHistory(options: OpenClawHistoryOptions) {
  let generation = 0, closed = false, closing: Promise<void> | undefined;
  const revisions = new Map<string, { revision: string; connection: string | undefined }>();
  // Preserve the original runtime's sanitized diagnostic while keeping the
  // typed superseded signal used by async HTTP preparation/retry handling.
  const superseded = () => new HistoryReadSuperseded('OpenClaw history connection changed or projection invalidated');
  const refresh = createHistoryRefresh(async (key, authoritative) => {
    const epoch = generation, connection = options.gateway.connectionId();
    const check = () => {
      if (closed || epoch !== generation || connection !== options.gateway.connectionId()) throw superseded();
    };
    const trace = guardedTrace(options.diagnostics ?? performanceDiagnostics, 'openclaw-history-projection');
    let failed = true;
    try {
      const { rows, connectionId } = await readOpenClawHistoryRows(options, key, authoritative);
      check();
      if (connectionId !== undefined && connectionId !== options.gateway.connectionId()) throw superseded();
      const revision = stableGatewayRowsRevision(rows), previous = revisions.get(key);
      if (previous?.revision !== revision || previous.connection !== connection) {
        const projected = await projectOpenClawHistoryRows(key, rows, options);
        check();
        options.projection.replaceMessages(key, projected.messages);
        check();
        options.projection.replaceActivities(key, projected.activities);
        check();
        revisions.set(key, { revision, connection });
      }
      trace.add('records', rows.length); failed = false;
      return { epoch, connection };
    } finally { trace.add('step', 1); trace.finish(failed); }
  }, result => {
    // Invalidation may run in a projection subscriber or between promise
    // continuations. It must also fence the generic refresh's ready/maxAge ACK.
    if (closed || result.epoch !== generation || result.connection !== options.gateway.connectionId())
      throw superseded();
  });
  const originalInvalidate = refresh.invalidate, originalReady = refresh.ready, originalClose = refresh.close;
  return Object.assign(refresh, {
    invalidate: () => { generation++; revisions.clear(); originalInvalidate(); },
    ready: (key: string) => !closed && originalReady(key)
      && revisions.has(key) && revisions.get(key)!.connection === options.gateway.connectionId(),
    close: () => {
      if (closing) return closing;
      closed = true; generation++; revisions.clear();
      return closing = originalClose();
    },
  });
}

  function rowTerminalAssistantFields(row: any, role = normalizeRole(row.role ?? row.authorRole ?? row.message?.role)): Pick<ChatMessage, 'status'> {
    if (role !== 'assistant') return {};
    const stopReason = String(row?.stopReason ?? row?.message?.stopReason ?? row?.finishReason ?? row?.finish_reason ?? '').toLowerCase();
    const stateText = String(row?.status ?? row?.state ?? row?.phase ?? '').toLowerCase();
    const explicitFinal = Boolean(row?.final ?? row?.isFinal ?? row?.done ?? row?.completed);
    const terminalStop = /^(stop|end|end_turn|complete|completed|done|final|length|max_tokens?)$/.test(stopReason);
    const terminalState = /\b(sent|success|succeeded|complete|completed|done|final)\b/.test(stateText);
    return explicitFinal || terminalStop || terminalState ? { status: 'sent' } : {};
  }

  function rowFailureFields(row: any): Pick<ChatMessage, 'status' | 'failureReason'> {
    const statusText = String(row?.status ?? row?.state ?? row?.error ?? row?.errorMessage ?? row?.failureReason ?? '').toLowerCase();
    const failed = Boolean(row?.failed ?? row?.isError ?? row?.error ?? row?.errorMessage ?? row?.failureReason) || /fail|error|crash/.test(statusText);
    const reason = sanitizeFailureReason(row?.failureReason ?? row?.error ?? row?.errorMessage);
    return failed ? { status: 'failed', ...(reason ? { failureReason: reason } : {}) } : {};
  }

  function extractToolCalls(row: any): any[] {
    const content: any[] = Array.isArray(row?.content) ? row.content : [];
    return content.filter((item: any) => item?.type === 'toolCall' || item?.type === 'functionCall');
  }

  function nonToolAssistantText(row: any) {
    if ((row?.role ?? row?.authorRole ?? row?.message?.role) !== 'assistant') return '';
    const content = Array.isArray(row?.content) ? row.content : [];
    return content
      .filter((item: any) => item?.type !== 'toolCall' && item?.type !== 'functionCall')
      .map((item: any) => typeof item?.text === 'string' ? item.text : (typeof item?.content === 'string' ? item.content : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  function extractToolResult(row: any): { toolCallId?: string; toolName?: string } | undefined {
    const isToolResult = row?.role === 'toolResult' || row?.type === 'toolResult' || row?.toolName || row?.toolCallId;
    if (!isToolResult) return undefined;
    return {
      toolCallId: typeof row.toolCallId === 'string' ? row.toolCallId : (typeof row.tool_call_id === 'string' ? row.tool_call_id : undefined),
      toolName: typeof row.toolName === 'string' ? row.toolName : (typeof row.name === 'string' ? row.name : undefined),
    };
  }


  function rowTokenUsage(row: any) {
    const usage = row?.usage ?? row?.tokenUsage ?? row?.tokens ?? row?.metadata?.usage ?? row?.__openclaw?.usage;
    const inputTokens = firstNumber(row?.inputTokens, row?.promptTokens, row?.prompt_tokens, usage?.inputTokens, usage?.promptTokens, usage?.prompt_tokens, usage?.input);
    const outputTokens = firstNumber(row?.outputTokens, row?.completionTokens, row?.completion_tokens, usage?.outputTokens, usage?.completionTokens, usage?.completion_tokens, usage?.output);
    const totalTokens = firstNumber(row?.totalTokens, usage?.totalTokens, usage?.total_tokens, inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
  }

  function firstNumber(...values: unknown[]) {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
    return undefined;
  }

  function rowsToActivities(sessionKey: string, rows: any[]): ActivityEntry[] {
    const activities: ActivityEntry[] = [];
    for (const row of rows) {
      if (row?.role === 'toolResult' || row?.type === 'toolResult' || row?.toolName || row?.toolCallId) {
        const toolCallId = String(row.toolCallId ?? row.id ?? row.__openclaw?.id ?? nanoid());
        const updatedAt = Number(row.timestamp ?? row.createdAt ?? row.__openclaw?.recordTimestampMs ?? Date.now());
        const outputPreview = normalizeToolResultText(row).slice(0, 800);
        activities.push({
          id: `history:${toolCallId}`,
          status: row.isError ? 'error' : 'done',
          toolName: String(row.toolName ?? 'tool'),
          ...(outputPreview ? { outputPreview } : {}),
          runId: 'history',
          toolCallId,
          sessionKey,
          hiddenArgumentCount: 0,
          updatedAt,
          durationMs: 0,
        });
      }
      for (const item of Array.isArray(row?.content) ? row.content : []) {
        if (item?.type !== 'toolCall') continue;
        const toolCallId = String(item.id ?? row.id ?? nanoid());
        const updatedAt = Number(row.timestamp ?? row.createdAt ?? row.__openclaw?.recordTimestampMs ?? Date.now());
        const summary = summarizeToolArguments(item.arguments);
        activities.push({
          id: `history:${toolCallId}`,
          status: 'running',
          toolName: String(item.name ?? 'tool'),
          ...(summary ? { summary } : {}),
          runId: 'history',
          toolCallId,
          sessionKey,
          hiddenArgumentCount: 0,
          updatedAt,
          durationMs: 0,
        });
      }
    }
    return activities;
  }

  function normalizeToolResultText(row: any) {
    if (typeof row?.content === 'string') return row.content;
    if (Array.isArray(row?.content)) return row.content.map((item: any) => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n');
    return '';
  }

  function summarizeToolArguments(args: unknown) {
    if (typeof args === 'string') return args.slice(0, 240);
    if (args && typeof args === 'object') return Object.keys(args as Record<string, unknown>).slice(0, 6).join(', ');
    return undefined;
  }

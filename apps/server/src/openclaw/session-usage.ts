import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { readTranscriptTail } from './transcript-tail.js';

const execFileAsync = promisify(execFile);
const DEFAULT_STALE_ACTIVE_RUN_MS = 60 * 60 * 1000;

type ChatSessionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  compactionCount?: number;
  totalTokensFresh?: boolean;
  status?: 'idle' | 'running' | 'failed' | 'waiting' | 'unknown';
  hasActiveRun?: boolean;
  model?: string;
  modelProvider?: string;
};

type TranscriptState = {
  unresolved: boolean;
  yielded: boolean;
  lastMessageAt?: number;
};

let sessionUsageCache: { expiresAt: number; value: Map<string, Partial<ChatSessionUsage>> } | undefined;

export async function readOpenClawSessionUsage() {
  const now = Date.now();
  if (sessionUsageCache && sessionUsageCache.expiresAt > now) return sessionUsageCache.value;
  const { stdout } = await execFileAsync('openclaw', ['sessions', '--all-agents', '--limit', '500', '--json'], {
    timeout: 12_000,
    maxBuffer: 12 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
  const value = new Map<string, Partial<ChatSessionUsage>>();
  const sessionStores = new Map<string, Promise<Record<string, any> | undefined>>();
  for (const row of rows) {
    const key = typeof row?.key === 'string' ? row.key : undefined;
    if (!key) continue;
    const usage: Partial<ChatSessionUsage> = {};
    setIfNumber(usage, 'inputTokens', row.inputTokens);
    setIfNumber(usage, 'outputTokens', row.outputTokens);
    setIfNumber(usage, 'totalTokens', row.totalTokens);
    setIfNumber(usage, 'contextTokens', row.contextTokens);
    setIfNumber(usage, 'compactionCount', row.compactionCount);
    const agentId = typeof row.agentId === 'string' ? row.agentId : inferAgentId(key);
    const rawStore = await readSessionStoreAsync(agentId, sessionStores);
    const rawSession = rawStore?.[key];
    setIfNumber(usage, 'compactionCount', rawSession?.compactionCount ?? rawSession?.compactionCheckpoints?.length);
    const rawStatus = String(rawSession?.status ?? row.status ?? '').toLowerCase();
    if (rawStatus === 'running') Object.assign(usage, await classifyOpenClawSessionRunAsync(row, rawSession, now));
    if (typeof row.totalTokensFresh === 'boolean') usage.totalTokensFresh = row.totalTokensFresh;
    if (typeof row.model === 'string') usage.model = row.model;
    if (typeof row.modelProvider === 'string') usage.modelProvider = row.modelProvider;
    value.set(key, usage);
  }
  sessionUsageCache = { expiresAt: now + 15_000, value };
  return value;
}

export function readOpenClawSessionDiskUsage(rows: any[]) {
  const now = Date.now();
  const value = new Map<string, Partial<ChatSessionUsage>>();
  const sessionStores = new Map<string, Record<string, any> | undefined>();
  for (const row of rows) {
    const key = typeof row?.sessionKey === 'string' ? row.sessionKey : (typeof row?.key === 'string' ? row.key : undefined);
    if (!key) continue;
    const agentId = typeof row.agentId === 'string' ? row.agentId : inferAgentId(key);
    const rawSession = readSessionStore(agentId, sessionStores)?.[key];
    if (!rawSession) continue;
    const rawStatus = String(rawSession.status ?? row.status ?? '').toLowerCase();
    if (rawSession.abortedLastRun === true) {
      value.set(key, { status: 'failed', hasActiveRun: false });
    } else if (rawStatus === 'running') {
      value.set(key, classifyOpenClawSessionRun(row, rawSession, now));
    }
  }
  return value;
}

/** Original directory display classification without main-thread filesystem I/O.
 * The caller owns the entire Promise through its refresh/maintenance drain. */
export async function readOpenClawSessionDiskUsageAsync(rows: any[]) {
  const now = Date.now();
  const value = new Map<string, Partial<ChatSessionUsage>>();
  const sessionStores = new Map<string, Promise<Record<string, any> | undefined>>();
  for (const row of rows) {
    const key = typeof row?.sessionKey === 'string' ? row.sessionKey : (typeof row?.key === 'string' ? row.key : undefined);
    if (!key) continue;
    const agentId = typeof row.agentId === 'string' ? row.agentId : inferAgentId(key);
    const rawSession = (await readSessionStoreAsync(agentId, sessionStores))?.[key];
    if (!rawSession) continue;
    const rawStatus = String(rawSession.status ?? row.status ?? '').toLowerCase();
    if (rawSession.abortedLastRun === true) value.set(key, { status: 'failed', hasActiveRun: false });
    else if (rawStatus === 'running') value.set(key, await classifyOpenClawSessionRunAsync(row, rawSession, now));
  }
  return value;
}

function setIfNumber(target: Partial<ChatSessionUsage>, key: keyof ChatSessionUsage, value: unknown) {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) (target as Record<string, unknown>)[key] = value;
    return;
  }
  if (typeof value !== 'string' || !value.trim()) return;
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) (target as Record<string, unknown>)[key] = numberValue;
}

function inferAgentId(sessionKey: string) {
  const parts = sessionKey.split(':');
  return parts[0] === 'agent' && parts[1] ? parts[1] : 'main';
}

export function classifyOpenClawSessionRun(row: any, rawSession: any, now = Date.now()): Pick<ChatSessionUsage, 'status' | 'hasActiveRun'> {
  if (rawSession?.abortedLastRun === true) return { status: 'failed', hasActiveRun: false };
  return classifyTranscriptRun(row, rawSession, inspectTranscriptState(rawSession?.sessionFile), now);
}

export async function classifyOpenClawSessionRunAsync(row: any, rawSession: any, now = Date.now()): Promise<Pick<ChatSessionUsage, 'status' | 'hasActiveRun'>> {
  if (rawSession?.abortedLastRun === true) return { status: 'failed', hasActiveRun: false };
  let transcript: TranscriptState = { unresolved: true, yielded: false };
  try {
    if (typeof rawSession?.sessionFile === 'string') transcript = inspectTranscriptLines(await readTranscriptTail(rawSession.sessionFile));
  } catch { /* Display remains conservative when the source is unreadable. */ }
  return classifyTranscriptRun(row, rawSession, transcript, now);
}

function classifyTranscriptRun(row: any, rawSession: any, transcript: TranscriptState, now: number): Pick<ChatSessionUsage, 'status' | 'hasActiveRun'> {
  if (transcript.yielded) return { status: 'waiting', hasActiveRun: false };
  const lastSignalAt = latestOpenClawRunSignalAt(row, rawSession, transcript.lastMessageAt);
  const hasActiveRun = transcript.unresolved && !isStaleActiveRunAt(lastSignalAt, now);
  return { status: hasActiveRun ? 'running' : 'idle', hasActiveRun };
}

export function staleActiveRunMs() {
  const configured = Number(process.env.AOD_STALE_ACTIVE_RUN_MS);
  if (Number.isFinite(configured) && configured > 0) return Math.max(60_000, Math.floor(configured));
  return DEFAULT_STALE_ACTIVE_RUN_MS;
}

export function isStaleActiveRunAt(lastSignalAt: unknown, now = Date.now()) {
  const timestamp = numericTime(lastSignalAt);
  return Boolean(timestamp && now - timestamp > staleActiveRunMs());
}

function inspectTranscriptState(path: unknown): TranscriptState {
  if (typeof path !== 'string' || !existsSync(path)) return { unresolved: true, yielded: false };
  try {
    return inspectTranscriptLines(readFileSync(path, 'utf8'));
  } catch {
    return { unresolved: true, yielded: false };
  }
}

function inspectTranscriptLines(text: string): TranscriptState {
  try {
    const lines = text.trim().split('\n').filter(Boolean).slice(-20);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const row = JSON.parse(lines[index] ?? '{}');
      const message = row?.message;
      if (!message) continue;
      const lastMessageAt = numericTime(row?.timestamp, row?.ts);
      const timed = { ...(lastMessageAt ? { lastMessageAt } : {}) };
      if (isSessionsYieldToolResult(message)) return { unresolved: false, yielded: true, ...timed };
      if (message.role === 'user') return { unresolved: true, yielded: false, ...timed };
      if (message.role === 'toolResult') return { unresolved: true, yielded: false, ...timed };
      if (message.role === 'assistant') {
        const content = Array.isArray(message.content) ? message.content : [];
        const hasToolCall = content.some((item: any) => item?.type === 'toolCall');
        const hasSessionsYieldToolCall = content.some(isSessionsYieldToolCall);
        if (hasSessionsYieldToolCall) return { unresolved: false, yielded: true, ...timed };
        if (hasToolCall || message.stopReason === 'toolUse') return { unresolved: true, yielded: false, ...timed };
        return { unresolved: false, yielded: false, ...timed };
      }
    }
    return { unresolved: true, yielded: false };
  } catch {
    return { unresolved: true, yielded: false };
  }
}

function isSessionsYieldToolCall(item: any) {
  return item?.type === 'toolCall' && item?.name === 'sessions_yield';
}

function isSessionsYieldToolResult(message: any) {
  if (message?.role !== 'toolResult') return false;
  if (message?.toolName === 'sessions_yield') return true;
  const text = Array.isArray(message.content)
    ? message.content.map((item: any) => typeof item?.text === 'string' ? item.text : '').join('\n')
    : '';
  if (!text.trim()) return false;
  try {
    return JSON.parse(text)?.status === 'yielded';
  } catch {
    return /"status"\s*:\s*"yielded"/.test(text);
  }
}

function latestOpenClawRunSignalAt(row: any, rawSession: any, transcriptLastMessageAt: number | undefined) {
  return latestTime(
    transcriptLastMessageAt,
    rawSession?.updatedAt,
    rawSession?.lastActiveAt,
    rawSession?.runStartedAt,
    row?.updatedAt,
    row?.lastActiveAt,
    row?.runStartedAt,
  );
}

function latestTime(...values: unknown[]) {
  let latest: number | undefined;
  for (const value of values) {
    const timestamp = numericTime(value);
    if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function numericTime(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function readSessionStore(agentId: string, cache: Map<string, Record<string, any> | undefined>) {
  if (cache.has(agentId)) return cache.get(agentId);
  const path = join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
  if (!existsSync(path)) {
    cache.set(agentId, undefined);
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    cache.set(agentId, parsed);
    return parsed;
  } catch {
    cache.set(agentId, undefined);
    return undefined;
  }
}

function readSessionStoreAsync(agentId: string, cache: Map<string, Promise<Record<string, any> | undefined>>) {
  let reading = cache.get(agentId);
  if (!reading) {
    const file = join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
    reading = readFile(file, 'utf8').then(text => JSON.parse(text) as Record<string, any>).catch(() => undefined);
    cache.set(agentId, reading);
  }
  return reading;
}

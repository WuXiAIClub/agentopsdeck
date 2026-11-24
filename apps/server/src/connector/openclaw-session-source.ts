import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ServerConfig } from '../config.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { normalizeMessageText, normalizeRole } from '../messages/normalize.js';
import { normalizeOpenClawSessionRow } from '../openclaw/session-row.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { prepareExecutionHome, verifyExecutionDirectory } from '../execution/private-environment.js';

const execFileAsync = promisify(execFile);
type Execute = (args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
const MAX_OVERRIDE_FILE_BYTES = 1024 * 1024;
const MAX_OVERRIDE_ENTRIES = 2_000;
const MAX_SESSION_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_INDEX_ENTRIES = 5_000;
const MAX_REGISTRY_AGENT_DIRS = 128;
const MAX_REGISTRY_AGGREGATE_BYTES = 16 * 1024 * 1024;
const MAX_REGISTRY_TOTAL_ROWS = 20_000;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 400;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

function isSafeSingleSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && !/[/\\:\x00-\x1f\x7f]/.test(value);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function isWithinRealRoot(candidateReal: string, rootReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The original local registry/CLI/history source. No SQL, native writes or
 * execution proof. Close freezes new reads and drains the original I/O. */
export function createOpenClawSessionSource(config: Pick<ServerConfig, 'sessionTitlesFile' | 'nativeFileRoots'>,
  ports: { execute?: Execute; diagnostics?: PerformanceDiagnostics } = {}) {
  const reads = createTaskDrain();
  const { home, configFile } = config.nativeFileRoots;
  const execute: Execute = ports.execute ?? ((args, options) => execFileAsync('openclaw', args, options));
  const run = <T>(step: number, read: () => Promise<T>) => reads.run(async () => {
    const trace = guardedTrace(ports.diagnostics ?? performanceDiagnostics, 'openclaw-session-source');
    trace.add('step', step);
    try { const value = await read(); trace.finish(false); return value; }
    catch (error) { trace.finish(true); throw error; }
  });
  return {
    readSessions: () => run(1, readOpenClawStatusSessions),
    readTranscript: (sessionKey: string) => run(2, () => readOpenClawTranscriptRows(sessionKey)),
    close: () => reads.close(),
  };

  async function readOpenClawStatusSessions() {
    const registryRows = await readOpenClawRegistrySessionRows();
    if (registryRows.length > 0) {
      const normalized = registryRows.map(normalizeOpenClawSessionRow).filter((row: ReturnType<typeof normalizeOpenClawSessionRow>): row is NonNullable<typeof row> => Boolean(row));
      const homeReal = await realpath(home);
      return withRecoveredOpenClawDirectSessions(await withTitleOverrideSessions(normalized, homeReal));
    }
    const rows = await readOpenClawSessionsList().catch(async () => readOpenClawStatusRecentSessions());
    const normalized = rows.map(normalizeOpenClawSessionRow).filter((row: ReturnType<typeof normalizeOpenClawSessionRow>): row is NonNullable<typeof row> => Boolean(row));
    const titled = await withTranscriptRecoveredSessionTitles(normalized);
    const homeReal = await realpath(home);
    return withRecoveredOpenClawDirectSessions(await withTranscriptTerminalSessionStatus(await withTitleOverrideSessions(titled, homeReal)));
  }

  async function withTranscriptRecoveredSessionTitles(rows: any[]) {
    const next = [];
    for (const row of rows) {
      if (hasSessionTitleCandidate(row)) {
        next.push(row);
        continue;
      }
      const title = await firstUserTranscriptTitle(String(row.sessionKey)).catch(() => undefined);
      next.push(title ? { ...row, derivedTitle: title } : row);
    }
    return next;
  }

  function hasSessionTitleCandidate(row: any) {
    return Boolean(optionalString(row?.label ?? row?.subject ?? row?.derivedTitle ?? row?.displayName ?? row?.title));
  }

  function optionalString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  async function firstUserTranscriptTitle(sessionKey: string) {
    const rows = await readOpenClawTranscriptRows(sessionKey);
    for (const row of rows as any[]) {
      const role = normalizeRole(row.role ?? row.authorRole ?? row.message?.role);
      if (role !== 'user') continue;
      const text = normalizeMessageText(row).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      return text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}…`;
    }
    return undefined;
  }

  async function withTranscriptTerminalSessionStatus(rows: any[]) {
    const next = [];
    for (const row of rows) {
      if (row.status !== 'failed') {
        next.push(row);
        continue;
      }
      const terminal = await latestTranscriptTerminalStatus(String(row.sessionKey)).catch(() => undefined);
      if (terminal?.status === 'idle') next.push({ ...row, status: 'idle', updatedAt: Math.max(Number(row.updatedAt) || 0, terminal.at), lastActiveAt: Math.max(Number(row.lastActiveAt) || 0, terminal.at), runCompletedAt: terminal.at });
      else next.push(row);
    }
    return next;
  }

  async function latestTranscriptTerminalStatus(sessionKey: string) {
    const rows = await readOpenClawTranscriptRows(sessionKey).catch(() => []);
    let latest: { at: number; status: 'idle' | 'failed' } | undefined;
    for (const row of rows as any[]) {
      const role = row.role ?? row.message?.role;
      if (role !== 'assistant') continue;
      const text = String(row.text ?? normalizeMessageText(row) ?? '').toLowerCase();
      const failed = row.status === 'failed' || text.includes('assistant turn failed before producing content') || text.includes('assistant turn was stopped before producing content');
      // Historical transcript rows do not always carry status/stopReason after
      // Gateway/registry recovery. For a session already marked failed, any later
      // non-error assistant text is a terminal success signal and should clear the
      // stale failed badge caused by an older tool/result row.
      const hasAssistantText = text.trim().length > 0;
      const sent = row.status === 'sent' || row.stopReason === 'stop' || row.message?.stopReason === 'stop' || hasAssistantText;
      if (!failed && !sent) continue;
      const at = numericTime(row.updatedAt, row.createdAt, row.message?.timestamp, row.timestamp) ?? 0;
      if (!at || (latest && at <= latest.at)) continue;
      latest = { at, status: failed ? 'failed' : 'idle' };
    }
    return latest;
  }

  async function withTitleOverrideSessions(rows: any[], homeReal: string) {
    const byKey = new Map(rows.map((row) => [String(row.sessionKey), row]));
    const titles = await readSessionTitleOverrides();
    const files = await readSessionFileOverrides();
    for (const [sessionKey, title] of Object.entries(titles)) {
      const recovered = await titleOverrideSessionRow(sessionKey, title, rows, files, homeReal);
      if (!recovered) continue;
      const existing = byKey.get(sessionKey);
      byKey.set(sessionKey, existing ? { ...existing, label: title, subject: title } : recovered);
    }
    return [...byKey.values()];
  }

  async function titleOverrideSessionRow(sessionKey: string, title: string, rows: any[], files: Record<string, string>, homeReal: string) {
    const parts = sessionKey.split(':');
    if (parts[0] !== 'agent' || !isSafeSingleSegment(parts[1])) return undefined;
    const agentId = parts[1];
    const now = Date.now();
    const defaults = inferredSessionDefaults(rows, agentId);
    const rawSessionFile = files[sessionKey];
    const sessionsReal = rawSessionFile ? await resolveConfinedSessionsDir(homeReal, agentId) : undefined;
    const sessionFile = rawSessionFile && sessionsReal ? await resolveConfinedTranscriptOverride(rawSessionFile, sessionsReal) : undefined;
    const sessionFileFields = sessionFile ? { sessionFile, transcriptPath: sessionFile, sessionId: sessionIdFromTranscriptPath(sessionFile) } : {};
    if (isSyntheticWebSessionKey(sessionKey)) {
      return { key: sessionKey, sessionKey, agentId, label: title, subject: title, kind: 'web', surface: 'web', status: 'idle', updatedAt: now, lastActiveAt: now, ...defaults, ...sessionFileFields };
    }
    if (parts[2] === 'feishu' && ['direct', 'group'].includes(parts[3] ?? '') && parts.slice(4).join(':')) {
      return {
        key: sessionKey,
        sessionKey,
        agentId,
        label: title,
        subject: title,
        kind: parts[3],
        channel: 'feishu',
        surface: 'feishu',
        origin: { provider: 'feishu', surface: 'feishu', chatType: parts[3], accountId: agentId },
        deliveryContext: { channel: 'feishu', accountId: agentId },
        status: 'idle',
        updatedAt: now,
        lastActiveAt: now,
        ...defaults,
        ...sessionFileFields,
      };
    }
    return undefined;
  }

  function inferredSessionDefaults(rows: any[], agentId: string) {
    const candidates = rows.filter((row) => (row.agentId ?? inferAgentIdFromSessionKey(String(row.sessionKey ?? row.key ?? ''))) === agentId);
    const modelRow = candidates.find((row) => typeof row.model === 'string' && row.model.trim()) ?? rows.find((row) => typeof row.model === 'string' && row.model.trim());
    const contextRow = candidates.find((row) => Number.isFinite(Number(row.contextTokens))) ?? rows.find((row) => Number.isFinite(Number(row.contextTokens)));
    return {
      ...(typeof modelRow?.model === 'string' ? { model: modelRow.model } : {}),
      ...(typeof modelRow?.modelProvider === 'string' ? { modelProvider: modelRow.modelProvider } : {}),
      ...(Number.isFinite(Number(contextRow?.contextTokens)) ? { contextTokens: Number(contextRow.contextTokens) } : {}),
    };
  }

  async function readSessionTitleOverrides() {
    return readBoundedStringMap(config.sessionTitlesFile);
  }

  async function readSessionFileOverrides() {
    return readBoundedStringMap(path.join(path.dirname(config.sessionTitlesFile), 'session-files.json'));
  }

  async function readBoundedStringMap(filePath: string): Promise<Record<string, string>> {
    let before;
    try {
      before = await lstat(filePath);
    } catch (error) {
      if (isMissingFileError(error)) return {};
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) {
      throw new Error('session_override_file_untrusted');
    }
    if (before.size > MAX_OVERRIDE_FILE_BYTES) {
      throw new Error('session_override_file_oversize');
    }
    const raw = await readFile(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_OVERRIDE_FILE_BYTES) {
      throw new Error('session_override_file_oversize');
    }
    const after = await lstat(filePath);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error('session_override_file_untrusted');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('session_override_file_invalid');
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > MAX_OVERRIDE_ENTRIES) {
      throw new Error('session_override_entries_exceeded');
    }
    const result: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (typeof value === 'string' && value.trim()) result[key] = value.trim();
    }
    return result;
  }

  function sessionIdFromTranscriptPath(value: string) {
    const base = path.basename(value);
    const match = /^([a-z0-9-]+)\.jsonl/i.exec(base);
    return match?.[1];
  }

  function isSyntheticWebSessionKey(sessionKey: string) {
    return sessionKey.toLowerCase().includes(':dashboard:agentopsdeck-web-');
  }

  async function withRecoveredOpenClawDirectSessions(rows: any[]) {
    const byKey = new Map(rows.map((row) => [row.sessionKey, row]));
    for (const row of rows) {
      const key = String(row.sessionKey ?? '');
      const parts = key.split(':');
      if (parts[0] !== 'agent' || parts[2] !== 'main') continue;
      const agentId = parts[1];
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : undefined;
      if (!agentId || !sessionId?.startsWith('ou_')) continue;
      const recoveredKey = `agent:${agentId}:feishu:direct:${sessionId}`;
      if (byKey.has(recoveredKey)) continue;
      const recovered = {
        ...row,
        key: recoveredKey,
        sessionKey: recoveredKey,
        label: 'Feishu · Direct',
        subject: 'Feishu · Direct',
        kind: 'direct',
        channel: 'feishu',
        source: 'direct',
        origin: {
          provider: 'feishu',
          surface: 'feishu',
          chatType: 'direct',
          to: `user:${sessionId}`,
          accountId: agentId,
          ...(row.origin ?? {}),
        },
        deliveryContext: {
          channel: 'feishu',
          to: `user:${sessionId}`,
          accountId: agentId,
          ...(row.deliveryContext ?? {}),
        },
      };
      byKey.set(recoveredKey, recovered);
    }
    return [...byKey.values()];
  }

  async function readOpenClawSessionsList() {
    const execOptions = {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: cliEnvironment(),
    };
    let stdout: string;
    try {
      ({ stdout } = await execute(['sessions', '--all-agents', '--limit', '500', '--json'], execOptions));
    } catch (error) {
      if (!String((error as any)?.stderr ?? (error as any)?.message ?? error).includes('unknown option')) throw error;
      ({ stdout } = await execute(['sessions', '--all-agents', '--json'], execOptions));
    }
    const parsed = JSON.parse(stdout) as any;
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.sessions) ? parsed.sessions : []);
    return mergeOpenClawRegistryRows(rows, await readOpenClawRegistrySessionRows());
  }

  async function readOpenClawStatusRecentSessions() {
    const { stdout } = await execute(['status', '--json'], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: cliEnvironment(),
    });
    const parsed = JSON.parse(stdout) as any;
    return Array.isArray(parsed?.sessions?.recent) ? parsed.sessions.recent : [];
  }

  async function readOpenClawRegistrySessionRows() {
    verifyExecutionDirectory(home, true);
    const homeReal = await realpath(home);
    const agentsDir = path.join(home, 'agents');
    let agents;
    try {
      agents = await readdir(agentsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
    const agentsStat = await lstat(agentsDir);
    if (agentsStat.isSymbolicLink() || !agentsStat.isDirectory()) {
      throw new Error('openclaw_registry_directory_untrusted');
    }
    const agentsReal = await realpath(agentsDir);
    if (!isWithinRealRoot(agentsReal, homeReal)) {
      throw new Error('openclaw_registry_directory_untrusted');
    }
    const rows: any[] = [];
    let agentDirCount = 0;
    let aggregateBytes = 0;
    for (const agent of agents) {
      if (agent.isSymbolicLink()) {
        throw new Error('openclaw_registry_agent_untrusted');
      }
      if (!agent.isDirectory()) continue;
      if (!isSafeSingleSegment(agent.name)) {
        throw new Error('openclaw_registry_agent_invalid');
      }
      if (++agentDirCount > MAX_REGISTRY_AGENT_DIRS) {
        throw new Error('openclaw_registry_agent_budget_exceeded');
      }
      const sessionsReal = await resolveConfinedSessionsDir(homeReal, agent.name);
      if (!sessionsReal) continue;
      const file = path.join(agentsDir, agent.name, 'sessions', 'sessions.json');
      const loaded = await readBoundedSessionIndex(file, sessionsReal);
      if (!loaded) continue;
      aggregateBytes += loaded.byteLength;
      if (aggregateBytes > MAX_REGISTRY_AGGREGATE_BYTES) {
        throw new Error('openclaw_registry_byte_budget_exceeded');
      }
      for (const [key, value] of loaded.entries) {
        if (!value || typeof value !== 'object') continue;
        if (rows.length >= MAX_REGISTRY_TOTAL_ROWS) {
          throw new Error('openclaw_registry_row_budget_exceeded');
        }
        const sanitized = { ...value };
        if (typeof sanitized.sessionFile === 'string') {
          const confined = await resolveConfinedTranscriptOverride(sanitized.sessionFile, sessionsReal);
          if (confined) sanitized.sessionFile = confined;
          else delete sanitized.sessionFile;
        }
        rows.push({ key, sessionKey: key, agentId: value.agentId ?? agent.name, ...sanitized });
      }
    }
    return rows;
  }

  async function resolveConfinedSessionsDir(homeReal: string, agentId: string): Promise<string | undefined> {
    if (!isSafeSingleSegment(agentId)) return undefined;
    const agentsDir = path.join(home, 'agents');
    let agentsStat;
    try {
      agentsStat = await lstat(agentsDir);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    if (agentsStat.isSymbolicLink() || !agentsStat.isDirectory()) {
      throw new Error('openclaw_registry_directory_untrusted');
    }
    const agentDir = path.join(agentsDir, agentId);
    let agentStat;
    try {
      agentStat = await lstat(agentDir);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) {
      throw new Error('openclaw_registry_agent_untrusted');
    }
    const sessionsDir = path.join(agentDir, 'sessions');
    let sessionsStat;
    try {
      sessionsStat = await lstat(sessionsDir);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) {
      throw new Error('openclaw_sessions_directory_untrusted');
    }
    const sessionsReal = await realpath(sessionsDir);
    if (!isWithinRealRoot(sessionsReal, homeReal)) {
      throw new Error('openclaw_sessions_directory_untrusted');
    }
    return sessionsReal;
  }

  async function readBoundedSessionIndex(indexPath: string, sessionsReal: string): Promise<{ entries: Array<[string, any]>; parsed: Record<string, any>; byteLength: number } | undefined> {
    let before;
    try {
      before = await lstat(indexPath);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) {
      throw new Error('openclaw_session_index_untrusted');
    }
    if (before.size > MAX_SESSION_INDEX_BYTES) {
      throw new Error('openclaw_session_index_oversize');
    }
    const indexReal = await realpath(indexPath);
    if (path.dirname(indexReal) !== sessionsReal) {
      throw new Error('openclaw_session_index_untrusted');
    }
    const raw = await readFile(indexPath, 'utf8');
    const byteLength = Buffer.byteLength(raw, 'utf8');
    if (byteLength > MAX_SESSION_INDEX_BYTES) {
      throw new Error('openclaw_session_index_oversize');
    }
    const after = await lstat(indexPath);
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error('openclaw_session_index_untrusted');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('openclaw_session_index_invalid');
    }
    const entries = Object.entries(parsed as Record<string, any>);
    if (entries.length > MAX_SESSION_INDEX_ENTRIES) {
      throw new Error('openclaw_session_index_entries_exceeded');
    }
    return { entries, parsed: parsed as Record<string, any>, byteLength };
  }

  async function resolveConfinedTranscriptOverride(candidatePath: string, sessionsReal: string): Promise<string | undefined> {
    const resolvedCandidate = path.resolve(candidatePath);
    const base = path.basename(resolvedCandidate);
    if (!base.endsWith('.jsonl') || !isSafeSingleSegment(base)) return undefined;
    let candidateStat;
    try {
      candidateStat = await lstat(resolvedCandidate);
    } catch (error) {
      if (isMissingFileError(error)) {
        let parentReal: string;
        try {
          parentReal = await realpath(path.dirname(resolvedCandidate));
        } catch {
          return undefined;
        }
        return parentReal === sessionsReal ? path.join(sessionsReal, base) : undefined;
      }
      throw error;
    }
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile() || candidateStat.nlink > 1) {
      throw new Error('openclaw_transcript_untrusted');
    }
    const candidateReal = await realpath(resolvedCandidate);
    if (!isWithinRealRoot(candidateReal, sessionsReal) || path.dirname(candidateReal) !== sessionsReal) {
      return undefined;
    }
    return resolvedCandidate;
  }

  function mergeOpenClawRegistryRows(rows: any[], registryRows: any[]) {
    const byKey = new Map<string, any>();
    for (const row of rows) byKey.set(String(row.key ?? row.sessionKey ?? row.id ?? ''), row);
    for (const registryRow of registryRows) {
      const key = String(registryRow.key ?? registryRow.sessionKey ?? '');
      if (!key) continue;
      const existing = byKey.get(key);
      byKey.set(key, existing ? { ...registryRow, ...existing, status: existing.status ?? registryRow.status, updatedAt: existing.updatedAt ?? registryRow.updatedAt, sessionId: existing.sessionId ?? registryRow.sessionId } : registryRow);
    }
    return [...byKey.values()];
  }

  async function readOpenClawTranscriptRows(sessionKey: string) {
    const agentId = inferAgentIdFromSessionKey(sessionKey);
    if (!agentId) return [];
    verifyExecutionDirectory(home, true);
    const homeReal = await realpath(home);
    const sessionsReal = await resolveConfinedSessionsDir(homeReal, agentId);
    if (!sessionsReal) return [];
    const sessionsDir = path.join(home, 'agents', agentId, 'sessions');
    const indexPath = path.join(sessionsDir, 'sessions.json');
    const loadedIndex = await readBoundedSessionIndex(indexPath, sessionsReal);
    if (!loadedIndex) return [];
    const index = loadedIndex.parsed;
    const fileOverrides = await readSessionFileOverrides();
    const entry = index?.[sessionKey] ?? recoveredDirectSessionIndexEntry(index, sessionKey);
    const sessionId = typeof entry?.sessionId === 'string'
      ? entry.sessionId
      : typeof entry?.systemPromptReport?.sessionId === 'string'
        ? entry.systemPromptReport.sessionId
        : sessionIdFromTranscriptPath(fileOverrides[sessionKey] ?? '');
    const sessionFile = typeof entry?.sessionFile === 'string' ? entry.sessionFile : fileOverrides[sessionKey];
    const confinedOverride = sessionFile ? await resolveConfinedTranscriptOverride(sessionFile, sessionsReal) : undefined;
    const transcriptPath = confinedOverride
      ? confinedOverride
      : sessionId && /^[a-z0-9-]+$/i.test(sessionId)
        ? path.join(sessionsReal, `${sessionId}.jsonl`)
        : undefined;
    if (!transcriptPath) return [];
    return readBoundedTranscriptMessages(transcriptPath, sessionsReal);
  }

  async function readBoundedTranscriptMessages(transcriptPath: string, sessionsReal: string) {
    let before;
    try {
      before = await lstat(transcriptPath);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) {
      throw new Error('openclaw_transcript_untrusted');
    }
    if (before.size > MAX_TRANSCRIPT_BYTES) {
      throw new Error('openclaw_transcript_oversize');
    }
    const realTranscript = await realpath(transcriptPath);
    if (path.dirname(realTranscript) !== sessionsReal) {
      throw new Error('openclaw_transcript_untrusted');
    }
    const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    let handle;
    try {
      handle = await open(realTranscript, openFlags);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.nlink > 1 || openedStat.dev !== before.dev || openedStat.ino !== before.ino) {
        throw new Error('openclaw_transcript_untrusted');
      }
      if (openedStat.size > MAX_TRANSCRIPT_BYTES) {
        throw new Error('openclaw_transcript_oversize');
      }
      const ring: any[] = [];
      let messageIndex = 0;
      let totalRead = 0;
      let carry = Buffer.alloc(0);
      const chunk = Buffer.allocUnsafe(TRANSCRIPT_READ_CHUNK_BYTES);
      const consumeLine = (lineBuffer: Buffer) => {
        if (lineBuffer.length === 0) return;
        if (lineBuffer.length > MAX_TRANSCRIPT_LINE_BYTES) {
          throw new Error('openclaw_transcript_line_oversize');
        }
        const line = lineBuffer.toString('utf8').trim();
        if (!line) return;
        const row = JSON.parse(line) as any;
        if (row?.type !== 'message') return;
        const currentIndex = messageIndex++;
        const messageTime = numericTime(row.message?.timestamp, row.timestamp) ?? Date.now();
        const normalized = {
          id: row.id,
          timestamp: row.timestamp,
          createdAt: messageTime + currentIndex,
          updatedAt: messageTime + currentIndex,
          role: row.message?.role,
          content: row.message?.content,
          message: row.message,
          usage: row.message?.usage,
          stopReason: row.message?.stopReason,
          status: row.message?.status ?? row.message?.state,
          error: row.message?.error,
          errorMessage: row.message?.errorMessage,
          isError: row.message?.isError,
          toolCallId: row.message?.toolCallId,
          toolName: row.message?.toolName,
          name: row.message?.toolName,
        };
        if (ring.length >= MAX_TRANSCRIPT_MESSAGES) ring.shift();
        ring.push(normalized);
      };

      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        totalRead += bytesRead;
        if (totalRead > MAX_TRANSCRIPT_BYTES) {
          throw new Error('openclaw_transcript_oversize');
        }
        let slice = chunk.subarray(0, bytesRead);
        let newlineIndex = slice.indexOf(0x0a);
        while (newlineIndex !== -1) {
          const linePart = slice.subarray(0, newlineIndex);
          const fullLine = carry.length > 0 ? Buffer.concat([carry, linePart]) : linePart;
          carry = Buffer.alloc(0);
          consumeLine(fullLine);
          slice = slice.subarray(newlineIndex + 1);
          newlineIndex = slice.indexOf(0x0a);
        }
        if (slice.length > 0) {
          if (carry.length + slice.length > MAX_TRANSCRIPT_LINE_BYTES) {
            throw new Error('openclaw_transcript_line_oversize');
          }
          carry = carry.length > 0 ? Buffer.concat([carry, slice]) : Buffer.from(slice);
        }
      }
      if (carry.length > 0) consumeLine(carry);
      return ring;
    } finally {
      await handle.close();
    }
  }

  function recoveredDirectSessionIndexEntry(index: any, sessionKey: string) {
    const parts = sessionKey.split(':');
    if (parts[0] !== 'agent' || parts[2] !== 'feishu' || parts[3] !== 'direct') return undefined;
    const agentId = parts[1];
    const directUserId = parts[4];
    if (!isSafeSingleSegment(agentId) || !directUserId?.startsWith('ou_')) return undefined;
    const mainEntry = index?.[`agent:${agentId}:main`];
    return mainEntry?.sessionId === directUserId ? mainEntry : undefined;
  }

  function inferAgentIdFromSessionKey(sessionKey: string) {
    const parts = sessionKey.split(':');
    const candidate = parts[0] === 'agent' && parts[1] ? parts[1] : parts[0];
    return isSafeSingleSegment(candidate) ? candidate : undefined;
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

  function cliEnvironment() {
    return { ...prepareExecutionHome(home), OPENCLAW_STATE_DIR: home, OPENCLAW_CONFIG_PATH: configFile };
  }

}

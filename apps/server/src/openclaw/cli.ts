import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessage } from '@agentopsdeck/shared';
import { normalizeMessageText, normalizeRole } from '../messages/normalize.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import { readTranscriptTail } from './transcript-tail.js';
import { agentOpsDeckDataDirectory } from '../config.js';
import { executionEnvironment, prepareExecutionHome, verifyExecutionBinary, verifyExecutionDirectory } from '../execution/private-environment.js';
import { drainNativeDiagnostics } from '../execution/native-diagnostics.js';

const cliStdoutLimit = 1024 * 1024;
const cliStderrLimit = 64 * 1024;
const cliSessionScanLimit = 4096;

export async function readOpenClawAgentNames(home: string): Promise<string[]> {
  try {
    verifyExecutionDirectory(home, true);
    const directory = path.join(home, 'agents');
    verifyExecutionDirectory(directory);
    const names: string[] = [];
    let visited = 0;
    for await (const entry of await opendir(directory)) {
      if (++visited > cliSessionScanLimit) throw new Error('Agent registry capacity exceeded');
      if (entry.isDirectory()) names.push(entry.name);
    }
    return names;
  } catch { throw new Error('Configured OpenClaw agent registry unavailable'); }
}

function boundedCliOutput(limit: number) {
  let buffer = Buffer.alloc(0), length = 0, overflowed = false;
  return {
    append(chunk: Buffer | string) {
      if (overflowed) return;
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (size > limit - length) {
        overflowed = true;
        buffer = Buffer.alloc(0);
        length = 0;
        return;
      }
      if (length + size > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(limit, Math.max(length + size, buffer.length * 2, 4096)));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      if (typeof chunk === 'string') buffer.write(chunk, length, size, 'utf8');
      else chunk.copy(buffer, length);
      length += size;
    },
    exceeded: () => overflowed,
    text: () => buffer.toString('utf8', 0, length),
  };
}

export function shouldUseOpenClawCliFallback(error: unknown, method: 'agent' | 'sessions.create') {
  // OpenClaw 2026.6.11 rejects this scope before invoking the handler. Do not
  // infer non-execution from a timeout, quoted error text or another method.
  return error instanceof GatewayRpcError && error.method === method
    && error.code === 'INVALID_REQUEST' && error.message === 'missing scope: operator.write';
}

export function localOpenClawCliSessionKey(sessionKey: string, agentId: string | undefined) {
  if (!sessionKey.includes(':dashboard:')) return sessionKey;
  if (isCliFallbackDisplaySessionKey(sessionKey)) return sessionKey;
  return `agent:${agentId ?? agentIdFromSessionKey(sessionKey) ?? 'main'}:main`;
}

function isCliFallbackDisplaySessionKey(sessionKey: string) {
  return sessionKey.toLowerCase().includes(':dashboard:agentopsdeck-web-');
}

export function createCliFallbackDisplaySessionKey(agentId: string) {
  return `agent:${agentId}:dashboard:agentopsdeck-web-${randomUUID()}`;
}

function sessionIdFromSessionKey(sessionKey: string) {
  const parts = sessionKey.split(':');
  return parts[parts.length - 1] || 'main';
}

export function agentIdFromSessionKey(sessionKey: string) {
  const parts = sessionKey.split(':');
  return parts[0] === 'agent' ? parts[1] : undefined;
}

export async function startOpenClawAgentFallback(
  sessionKey: string,
  agentId: string | undefined,
  displaySessionKey: string,
  message: string,
  idPrefix: string,
  onComplete?: (result: { ok: true; text: string; replyText?: string; messages: ChatMessage[] } | { ok: false; error: string }) => void | Promise<void>,
  ownLifetime?: (completion: Promise<void>) => void,
) {
  const sessionId = sessionIdFromSessionKey(sessionKey);
  const startedAt = Date.now();
  const args = ['agent', '--session-id', sessionId, '--message', message, '--json'];
  if (agentId) args.splice(1, 0, '--agent', agentId);
  let drained!: () => void;
  const lifetime = new Promise<void>(resolve => { drained = resolve; });
  try {
    // Register synchronously, including the startup interval and failed spawn.
    ownLifetime?.(lifetime);
    const launch = openClawCliLaunch();
    const child = spawn(launch.executable, args, {
      cwd: launch.homeDirectory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: launch.environment,
    });
    const stdout = boundedCliOutput(cliStdoutLimit);
    const stderr = drainNativeDiagnostics(child.stderr, cliStderrLimit);
    child.stdout?.on('data', (chunk) => stdout.append(chunk));
    child.once('close', (code, signal) => {
      void (async () => {
        if (!onComplete) return;
        let result: Parameters<typeof onComplete>[0];
        try {
          if (stdout.exceeded() || stderr.exceeded()) {
            result = { ok: false, error: 'openclaw CLI output exceeded its capture budget; original invocation must not be retried' };
          } else if (code === 0) {
            const output = stdout.text();
            const replyText = parseOpenClawCliReply(output);
            if (replyText === undefined) throw new Error('OpenClaw CLI reply unavailable');
            const text = replyText;
            const messages = await readOpenClawCliTranscriptMessages({ homeDirectory: launch.homeDirectory,
              agentId, sessionId, displaySessionKey, idPrefix, startedAt, finalText: text });
            result = { ok: true, text, messages, ...(replyText !== undefined ? { replyText } : {}) };
          } else {
            result = { ok: false, error: cliExitDiagnostic(code, signal) };
          }
        } catch {
          result = { ok: false, error: 'openclaw CLI result unavailable; original invocation must not be retried' };
        }
        await onComplete(result);
      })().catch(() => { console.warn('[openclaw-cli] completion callback failed'); }).finally(drained);
    });
    return await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      let settled = false;
      const settle = (result: { ok: true } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      child.on('error', () => settle({ ok: false, error: 'openclaw CLI launch unavailable; original invocation must not be retried' }));
      child.once('exit', (code, signal) => {
        if (code === 0) settle({ ok: true });
        else settle({ ok: false, error: cliExitDiagnostic(code, signal) });
      });
      const timer = setTimeout(() => {
        // The owner must keep the process alive through child close; merely
        // awaiting its lifetime Promise does not keep Node's event loop alive.
        settle({ ok: true });
      }, 500).unref();
    });
  } catch {
    drained(); // No child was created; asynchronous spawn errors await close.
    return { ok: false as const, error: 'openclaw CLI launch unavailable; original invocation must not be retried' };
  }
}

async function readOpenClawCliTranscriptMessages(params: {
  homeDirectory: string;
  agentId: string | undefined;
  sessionId: string;
  displaySessionKey: string;
  idPrefix: string;
  startedAt: number;
  finalText: string;
}): Promise<ChatMessage[]> {
  const sessionFile = await findOpenClawSessionFile(params.homeDirectory, params.agentId, params.sessionId);
  if (!sessionFile) return [];
  let raw = '';
  try {
    raw = await readTranscriptTail(sessionFile);
  } catch {
    return [];
  }
  const messages: ChatMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseJsonLine(line);
    if (!row) continue;
    const createdAt = timestampMs(row.timestamp ?? row.message?.timestamp);
    if (createdAt < params.startedAt - 2_000) continue;
    messages.push(...openClawRowToDisplayMessages(row, params.displaySessionKey, params.idPrefix, createdAt));
  }
  const deduped = dedupeCliMessages(messages);
  const hasFinal = deduped.some((message) => message.role === 'assistant' && params.finalText && message.text.trim() === params.finalText.trim());
  if (!hasFinal && params.finalText.trim()) {
    const now = Date.now();
    deduped.push({ id: `cli:${params.idPrefix}:assistant`, sessionKey: params.displaySessionKey, role: 'assistant', text: params.finalText.trim(), createdAt: now, updatedAt: now, status: 'sent' });
  }
  return deduped.sort((a, b) => a.createdAt - b.createdAt);
}

async function findOpenClawSessionFile(home: string, agentId: string | undefined, sessionId: string) {
  if (!agentId || agentId === '.' || agentId === '..' || safeSessionFilePart(agentId) !== agentId) return undefined;
  const dir = path.join(home, 'agents', agentId, 'sessions');
  const suffix = `_${safeSessionFilePart(sessionId)}.jsonl`;
  const exact = `${safeSessionFilePart(sessionId)}.jsonl`;
  let newest: { file: string; mtimeMs: number } | undefined;
  let visited = 0;
  try {
    verifyExecutionDirectory(home, true);
    verifyExecutionDirectory(dir);
    for await (const entry of await opendir(dir)) {
      if (++visited > cliSessionScanLimit) return undefined;
      if (!entry.isFile() || (entry.name !== exact && !entry.name.endsWith(suffix))) continue;
      const file = path.join(dir, entry.name);
      try {
        const info = await stat(file);
        if (info.isFile() && (!newest || info.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: info.mtimeMs };
      } catch {}
    }
  } catch { return undefined; }
  return newest?.file;
}


function openClawRowToDisplayMessages(row: any, displaySessionKey: string, idPrefix: string, createdAt: number): ChatMessage[] {
  const message = row?.message ?? row;
  const role = normalizeRole(message?.role ?? row?.role);
  if (role === 'user') return [];
  if (role === 'tool') {
    const text = normalizeMessageText(row) || '[tool output]';
    return [{
      id: `cli:${idPrefix}:${row?.id ?? randomUUID()}:tool-result`,
      sessionKey: displaySessionKey,
      role: 'tool',
      text,
      toolPreview: text.slice(0, 1_000),
      toolDetailAvailable: text.length > 1_000,
      toolLineCount: text.split(/\r?\n/).length,
      ...optionalStringProperty('toolCallId', message?.toolCallId),
      ...optionalStringProperty('toolName', message?.toolName),
      toolPhase: 'result',
      createdAt,
      updatedAt: createdAt,
      status: message?.isError ? 'failed' : 'sent',
      ...(message?.isError ? { failureReason: text.slice(0, 500) } : {}),
    }];
  }
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolCalls = content.filter((item: any) => item?.type === 'toolCall' || item?.type === 'functionCall');
  if (toolCalls.length > 0) {
    return toolCalls.map((item: any, index: number) => {
      const text = normalizeMessageText({ message: { content: [item] } }) || `[tool ${stringValue(item?.name) ?? 'unknown'}]`;
      return {
        id: `cli:${idPrefix}:${row?.id ?? randomUUID()}:tool-call:${index}`,
        sessionKey: displaySessionKey,
        role: 'tool',
        text,
        toolPreview: text.slice(0, 1_000),
        toolDetailAvailable: text.length > 1_000,
        toolLineCount: text.split(/\r?\n/).length,
        ...optionalStringProperty('toolCallId', item?.id),
        ...optionalStringProperty('toolName', item?.name),
        toolPhase: 'call',
        createdAt: createdAt + index,
        updatedAt: createdAt + index,
        status: 'sent',
      } satisfies ChatMessage;
    });
  }
  if (role === 'assistant') {
    const text = normalizeMessageText(row);
    if (!text) return [];
    return [{ id: `cli:${idPrefix}:${row?.id ?? randomUUID()}:assistant`, sessionKey: displaySessionKey, role: 'assistant', text, createdAt, updatedAt: createdAt, status: 'sent' }];
  }
  return [];
}

function dedupeCliMessages(messages: ChatMessage[]) {
  const seen = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const key = `${message.role}\u0000${message.toolPhase ?? ''}\u0000${message.toolCallId ?? ''}\u0000${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message);
  }
  return result;
}

function parseJsonLine(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function timestampMs(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function safeSessionFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}


function optionalStringProperty<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  const text = stringValue(value);
  return text ? { [key]: text } as { [P in K]?: string } : {};
}

export function parseOpenClawCliReply(output: string): string | undefined {
  if (Buffer.byteLength(output) > cliStdoutLimit) return;
  try {
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.status !== undefined && parsed.status !== 'ok')) return;
    const result = parsed.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return;
    if (typeof result.meta?.finalAssistantVisibleText === 'string') return result.meta.finalAssistantVisibleText.trim();
    if (!Array.isArray(result.payloads) || result.payloads.some((item: unknown) => !item || typeof item !== 'object'
      || Array.isArray(item) || ('text' in item && typeof item.text !== 'string'))) return;
    return result.payloads.map((item: { text?: string }) => item.text ?? '').filter(Boolean).join('\n\n').trim();
  } catch { return; }
}

export function isOpenClawCliAvailable() {
  try { openClawCliLaunch(); return true; }
  catch { return false; }
}

function openClawCliLaunch() {
  if (process.env.AOD_LOCAL_OPENCLAW_CLI !== 'true') throw new Error('OpenClaw CLI is disabled');
  const homeDirectory = process.env.AOD_OPENCLAW_HOME?.trim() || path.join(agentOpsDeckDataDirectory(process.env), 'openclaw-home');
  const environment = executionEnvironment(homeDirectory);
  const explicit = process.env.AOD_OPENCLAW_CLI_PATH;
  const candidate = explicit ?? environment.PATH!.split(path.delimiter)
    .map(directory => path.join(directory, process.platform === 'win32' ? 'openclaw.exe' : 'openclaw'))
    .find(executable => existsSync(executable));
  if (!candidate) throw new Error('OpenClaw CLI executable unavailable');
  const executable = verifyExecutionBinary(candidate);
  return { executable, homeDirectory, environment: {
    ...prepareExecutionHome(homeDirectory, [executable]), OPENCLAW_HOME: homeDirectory, OPENCLAW_STATE_DIR: homeDirectory,
    OPENCLAW_CONFIG_PATH: path.join(homeDirectory, 'openclaw.json'),
  } };
}

function cliExitDiagnostic(code: number | null, signal: NodeJS.Signals | null) {
  const status = Number.isInteger(code) && code !== null && code >= 0 && code <= 255 ? String(code) : 'unavailable';
  return `openclaw CLI execution failed: code=${status}${signal ? '; signalled' : ''}; original invocation must not be retried`;
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { parseAntigravityQuotaWait, type AntigravityQuotaWaitState } from '@agentopsdeck/shared';
import type { AntigravityConfig } from './config.js';
import { antigravityEnvironment, verifyAntigravityEnvironment } from './environment.js';
import { projectAntigravityUpdate, type AntigravityProjectedUpdate } from './message-projection.js';

export const ANTIGRAVITY_ACP_PROTOCOL_VERSION = 1;
export const ANTIGRAVITY_ACP_FRAME_BYTES = 1_048_576;
export const ANTIGRAVITY_ACP_WRITE_BYTES = 32 * 1024 * 1024;
export const ANTIGRAVITY_ACP_PENDING_LIMIT = 64;
export const ANTIGRAVITY_ACP_UPDATE_LIMIT = 65_536;
export const ANTIGRAVITY_ACP_UPDATE_BYTES = 64 * 1024 * 1024;
const failure = () => Error('Antigravity ACP transport unavailable; delivery may be unknown');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
export type AntigravitySessionUpdate = { sessionId: string; update: AntigravityProjectedUpdate };
export type AntigravityHandshake = { protocolVersion: 1; agentCapabilities: Record<string, unknown> };
export type AntigravityPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };
export type AntigravityPromptUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};
export type AntigravityPromptResult = {
  stopReason: string;
  usage?: AntigravityPromptUsage;
};

function synchronousAssertion(assert: () => void) {
  const result: unknown = assert();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw failure();
  }
}

export class AntigravityAcpError extends Error {
  constructor(
    readonly code: number,
    readonly quotaWait?: AntigravityQuotaWaitState,
  ) {
    super(code === -32000 ? 'Antigravity authentication required in its dedicated home' : 'Antigravity ACP request failed');
  }
}

function selectAllowOptionId(options: unknown[]): string | undefined {
  const candidates = options.filter((item): item is Record<string, unknown> => record(item) && typeof item.optionId === 'string' && identity(item.optionId));
  const preferred = candidates.find(item => item.kind === 'allow_always')
    ?? candidates.find(item => item.kind === 'allow_once')
    ?? candidates.find(item => typeof item.kind === 'string' && item.kind.startsWith('allow'))
    ?? candidates[0];
  return preferred ? (preferred.optionId as string) : undefined;
}

export class AntigravityAcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private failed = false;
  private exited = false;
  private exitCode: number | null = null;
  private transportClosed = false;
  private terminationRequested = false;
  private negotiated = false;
  private initializing: Promise<AntigravityHandshake> | undefined;
  private sessionId: string | undefined;
  private openingSession = false;
  private prompting = false;
  private promptSent = false;
  private hasPrompted = false;
  private requestedStop = false;
  private initializedCapabilities: Record<string, unknown> | undefined;
  private permissionCount = 0;
  private updateCount = 0;
  private updateBytes = 0;
  readonly finished: Promise<void>;

  constructor(private readonly options: {
    config: AntigravityConfig;
    assertOwnership: () => void;
    update: (update: AntigravitySessionUpdate) => void;
  }) {
    synchronousAssertion(options.assertOwnership);
    verifyAntigravityEnvironment(options.config);
    const args = options.config.permissionMode === 'deny'
      ? ['acp', '--sandbox', '--disable-telemetry']
      : ['acp', '--disable-telemetry'];
    this.child = spawn(options.config.command, args, {
      cwd: options.config.workspace,
      env: antigravityEnvironment(options.config),
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.finished = new Promise(resolve => {
      this.child.once('exit', (code, signal) => { this.exited = true; this.exitCode = signal ? null : code; });
      this.child.once('close', () => {
        this.exited = true; this.transportClosed = true;
        this.fail(); resolve();
      });
    });
    this.child.once('error', () => this.fail());
    this.child.stdin.on('error', () => this.fail());
    this.child.stdout.on('error', () => this.fail());
    this.child.stderr.on('error', () => this.fail());
    this.child.stderr.resume();
    this.child.stdout.on('data', (bytes: Buffer) => this.consume(bytes));
  }

  initialize(): Promise<AntigravityHandshake> {
    if (this.initializing) return this.initializing;
    const timer = setTimeout(() => this.close(), this.options.config.startupTimeoutMs);
    this.initializing = this.request('initialize', {
      protocolVersion: ANTIGRAVITY_ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'AgentOpsDeck', version: '1.0.0' },
    }).then((value): AntigravityHandshake => {
      if (!record(value) || value.protocolVersion !== ANTIGRAVITY_ACP_PROTOCOL_VERSION
        || !record(value.agentCapabilities)) throw failure();
      this.negotiated = true;
      this.initializedCapabilities = value.agentCapabilities;
      return { protocolVersion: ANTIGRAVITY_ACP_PROTOCOL_VERSION, agentCapabilities: structuredClone(value.agentCapabilities) };
    }).catch(error => { this.fail(); throw error; }).finally(() => clearTimeout(timer));
    return this.initializing;
  }

  async newSession(): Promise<string> {
    if (!this.negotiated || this.sessionId || this.openingSession || this.prompting) throw failure();
    this.openingSession = true;
    try {
      const value = await this.setupRequest('session/new', { cwd: this.options.config.workspace, mcpServers: [] });
      if (!record(value) || !identity(value.sessionId)) throw failure();
      this.sessionId = value.sessionId;
      return value.sessionId;
    } catch (error) { this.fail(); throw error; }
    finally { this.openingSession = false; }
  }

  async resumeOwnedSession(sessionId: string, assertOwnedSession: (sessionId: string) => void): Promise<void> {
    if (!this.negotiated || this.sessionId || this.openingSession || this.prompting || !identity(sessionId)
      || !record(this.initializedCapabilities?.sessionCapabilities)
      || !record(this.initializedCapabilities.sessionCapabilities.resume)) throw failure();
    synchronousAssertion(() => assertOwnedSession(sessionId));
    this.openingSession = true;
    try {
      const value = await this.setupRequest('session/resume', { sessionId, cwd: this.options.config.workspace, mcpServers: [] });
      if (!record(value)) throw failure();
      this.sessionId = sessionId;
    } catch (error) { this.fail(); throw error; }
    finally { this.openingSession = false; }
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.negotiated || !this.sessionId || this.prompting || !identity(modelId)) throw failure();
    try {
      await this.setupRequest('session/set_model', { sessionId: this.sessionId, modelId });
    } catch (error) { this.fail(); throw error; }
  }

  async prompt(
    input: string | AntigravityPromptBlock[],
    persistIntent: (sessionId: string) => Promise<void>,
  ): Promise<AntigravityPromptResult> {
    const blocks: AntigravityPromptBlock[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    const hasValidContent = blocks.length > 0 && blocks.every(block =>
      block.type === 'text' ? typeof block.text === 'string' && block.text.length > 0
        : block.type === 'image' && typeof block.mimeType === 'string' && block.mimeType.startsWith('image/') && typeof block.data === 'string' && block.data.length > 0);
    if (!this.negotiated || !this.sessionId || this.prompting || this.hasPrompted || !hasValidContent
      || (typeof input === 'string' && !input.trim())
      || Buffer.byteLength(JSON.stringify(blocks)) > ANTIGRAVITY_ACP_WRITE_BYTES) throw failure();
    const sessionId = this.sessionId;
    this.prompting = true; this.hasPrompted = true; this.requestedStop = false; this.permissionCount = 0;
    try {
      await persistIntent(sessionId);
      if (this.failed || this.requestedStop) throw failure();
      this.promptSent = true;
      const value = await this.request('session/prompt', { sessionId, prompt: blocks });
      if (!record(value) || typeof value.stopReason !== 'string'
        || !['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(value.stopReason)
        || value.stopReason === 'cancelled' && !this.requestedStop && this.permissionCount === 0) { this.fail(); throw failure(); }
      const rawUsage = record(value.usage) ? value.usage : undefined;
      const count = (candidate: unknown): number | undefined =>
        typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
      const inputTokens = count(rawUsage?.inputTokens);
      const outputTokens = count(rawUsage?.outputTokens);
      const cachedReadTokens = count(rawUsage?.cachedReadTokens);
      const cachedWriteTokens = count(rawUsage?.cachedWriteTokens);
      const thoughtTokens = count(rawUsage?.thoughtTokens);
      const totalTokens = count(rawUsage?.totalTokens);
      const usage: AntigravityPromptUsage | undefined = inputTokens !== undefined && outputTokens !== undefined ? {
        inputTokens,
        outputTokens,
        ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
        ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
        ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      } : undefined;
      return { stopReason: value.stopReason, ...(usage ? { usage } : {}) };
    } catch (error) { if (!(error instanceof AntigravityAcpError)) this.fail(); throw error; }
    finally { this.prompting = false; this.promptSent = false; }
  }

  cancel(): void {
    if (!this.prompting || !this.sessionId) throw failure();
    this.requestedStop = true;
    try {
      if (this.promptSent) this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    } catch { this.fail(); throw failure(); }
  }

  private setupRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const timer = setTimeout(() => this.close(), this.options.config.startupTimeoutMs);
    return this.request(method, params).finally(() => clearTimeout(timer));
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failed || this.pending.size >= ANTIGRAVITY_ACP_PENDING_LIMIT || this.sequence >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(failure());
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch { this.fail(); }
    });
  }

  private write(value: Record<string, unknown>) {
    synchronousAssertion(this.options.assertOwnership);
    if (this.failed || this.exited || !this.child.stdin.writable) throw failure();
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length > ANTIGRAVITY_ACP_WRITE_BYTES || this.child.stdin.writableLength + bytes.length > 2 * ANTIGRAVITY_ACP_WRITE_BYTES) throw failure();
    this.child.stdin.write(bytes, error => { if (error) this.fail(); });
  }

  private consume(bytes: Buffer) {
    if (this.failed) return;
    try {
      let offset = 0;
      while (offset < bytes.length && !this.failed) {
        const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
        const piece = bytes.subarray(offset, end);
        if (this.fragmentBytes + piece.length > ANTIGRAVITY_ACP_FRAME_BYTES) throw failure();
        if (piece.length) { this.fragments.push(Buffer.from(piece)); this.fragmentBytes += piece.length; }
        if (this.fragments.length > 16384) throw failure();
        if (newline < 0) break;
        const frame = Buffer.concat(this.fragments, this.fragmentBytes);
        this.fragments = []; this.fragmentBytes = 0;
        if (!frame.length) throw failure();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
        this.receive(JSON.parse(text));
        offset = newline + 1;
      }
    } catch { this.fail(); }
  }

  private receive(value: unknown) {
    synchronousAssertion(this.options.assertOwnership);
    if (!record(value) || value.jsonrpc !== '2.0') throw failure();
    if (typeof value.method === 'string') {
      if (!record(value.params)) throw failure();
      if (value.id === undefined) {
        if (value.method !== 'session/update') return;
        if (!identity(value.params.sessionId) || !record(value.params.update)) throw failure();
        this.updateBytes += Buffer.byteLength(JSON.stringify(value.params.update));
        if (++this.updateCount > ANTIGRAVITY_ACP_UPDATE_LIMIT || this.updateBytes > ANTIGRAVITY_ACP_UPDATE_BYTES) throw failure();
        if (!this.sessionId) return;
        if (value.params.sessionId !== this.sessionId) throw failure();
        if (this.promptSent) {
          const update = projectAntigravityUpdate(value.params.update);
          if (update) synchronousAssertion(() => this.options.update({ sessionId: this.sessionId!, update }));
        }
        return;
      }
      if (!(typeof value.id === 'string' && identity(value.id) || Number.isSafeInteger(value.id))) throw failure();
      if (value.method === 'session/request_permission') {
        if (!this.promptSent || value.params.sessionId !== this.sessionId || !record(value.params.toolCall)
          || !Array.isArray(value.params.options) || value.params.options.length > 64 || ++this.permissionCount > 1024) throw failure();
        const optionId = this.options.config.permissionMode === 'deny' ? undefined : selectAllowOptionId(value.params.options);
        this.write({
          jsonrpc: '2.0',
          id: value.id,
          result: optionId
            ? { outcome: { outcome: 'selected', optionId } }
            : { outcome: { outcome: 'cancelled' } },
        });
      } else this.write({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Method not supported by AgentOpsDeck' } });
      return;
    }
    if (!Number.isSafeInteger(value.id) || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) throw failure();
    const pending = this.pending.get(value.id as number);
    if (!pending) throw failure();
    this.pending.delete(value.id as number);
    if (value.error !== undefined) {
      if (!record(value.error) || !Number.isSafeInteger(value.error.code)) { pending.reject(failure()); throw failure(); }
      const quotaWait = typeof value.error.message === 'string'
        ? parseAntigravityQuotaWait(value.error.message)
        : undefined;
      pending.reject(new AntigravityAcpError(value.error.code as number, quotaWait));
    } else pending.resolve(value.result);
  }

  private fail() {
    if (this.failed) return;
    this.failed = true;
    for (const pending of this.pending.values()) pending.reject(failure());
    this.pending.clear(); this.fragments = []; this.fragmentBytes = 0;
    if (!this.exited) this.close();
    else this.child.stdin.destroy();
  }

  inspectTransportClosed(): boolean { return this.exited && this.transportClosed; }

  endInput(): void {
    if (!this.exited) this.child.stdin.end();
  }

  inspectProcessGroupEmpty(): boolean {
    if (!this.exited || !this.transportClosed) return false;
    if (!this.child.pid) return true;
    try { process.kill(-this.child.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }

  inspectQuiescentExit(): boolean {
    return !this.terminationRequested && this.exitCode === 0 && this.inspectProcessGroupEmpty();
  }

  close(): void {
    if (!this.failed) this.fail();
    this.child.stdin.destroy();
    if (this.child.pid) {
      this.terminationRequested = true;
      try { process.kill(-this.child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw failure(); }
    }
  }
}

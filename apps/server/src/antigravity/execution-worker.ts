import { setTimeout as delay } from 'node:timers/promises';
import { AntigravityAcpClient, type AntigravityHandshake, type AntigravityPromptBlock, type AntigravityPromptResult, type AntigravitySessionUpdate } from './acp-client.js';
import type { AntigravityConfig } from './config.js';
import type { AntigravityExecutionWorker } from './owned-execution.js';

export const ANTIGRAVITY_DRAIN_GRACE_MS = 10_000;
export const ANTIGRAVITY_DRAIN_KILL_MS = 5_000;
const failure = () => Error('Antigravity worker lifecycle is invalid');

export type AntigravityProcessWorkerOptions = {
  config: AntigravityConfig;
  assertOwnership: () => void;
  update: (update: AntigravitySessionUpdate) => void;
  drainGraceMs?: number;
  drainKillMs?: number;
};

export class AntigravityProcessWorker implements AntigravityExecutionWorker {
  private readonly client: AntigravityAcpClient;
  private readonly drainGraceMs: number;
  private readonly drainKillMs: number;
  private draining: Promise<{ cleaned: boolean; quiescent: boolean }> | undefined;

  constructor(options: AntigravityProcessWorkerOptions) {
    const graceMs = options.drainGraceMs ?? ANTIGRAVITY_DRAIN_GRACE_MS;
    const killMs = options.drainKillMs ?? ANTIGRAVITY_DRAIN_KILL_MS;
    if (!Number.isSafeInteger(graceMs) || graceMs < 10 || graceMs > 30_000
      || !Number.isSafeInteger(killMs) || killMs < 10 || killMs > 60_000) throw failure();
    this.drainGraceMs = graceMs;
    this.drainKillMs = killMs;
    this.client = new AntigravityAcpClient({
      config: options.config,
      assertOwnership: options.assertOwnership,
      update: options.update,
    });
  }

  initialize(): Promise<AntigravityHandshake> {
    if (this.draining) return Promise.reject(failure());
    return this.client.initialize();
  }

  newSession(): Promise<string> {
    if (this.draining) return Promise.reject(failure());
    return this.client.newSession();
  }

  resumeOwnedSession(sessionId: string, assertOwnedSession: (sessionId: string) => void): Promise<void> {
    if (this.draining) return Promise.reject(failure());
    return this.client.resumeOwnedSession(sessionId, assertOwnedSession);
  }

  setModel(modelId: string): Promise<void> {
    if (this.draining) return Promise.reject(failure());
    return this.client.setModel(modelId);
  }

  prompt(input: string | AntigravityPromptBlock[], persistIntent: (sessionId: string) => Promise<void>): Promise<AntigravityPromptResult> {
    if (this.draining) return Promise.reject(failure());
    return this.client.prompt(input, persistIntent);
  }

  cancel(): void {
    if (this.draining) throw failure();
    this.client.cancel();
  }

  stopAndDrain(): Promise<{ cleaned: boolean; quiescent: boolean }> {
    return this.draining ??= this.drain();
  }

  private async drain(): Promise<{ cleaned: boolean; quiescent: boolean }> {
    const awaitProcessGroupEmpty = async (windowMs: number) => {
      const deadline = performance.now() + windowMs;
      while (!this.client.inspectProcessGroupEmpty()) {
        if (performance.now() >= deadline) return false;
        await delay(20);
      }
      return true;
    };
    try {
      this.client.endInput();
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.client.finished,
        new Promise<void>(resolve => {
          graceTimer = setTimeout(() => {
            this.client.close();
            resolve();
          }, this.drainGraceMs);
        }),
      ]).finally(() => clearTimeout(graceTimer));
      if (!this.client.inspectTransportClosed()) {
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          this.client.finished,
          new Promise<void>(resolve => { killTimer = setTimeout(resolve, this.drainKillMs); }),
        ]).finally(() => clearTimeout(killTimer));
      }
      if (!this.client.inspectTransportClosed()) return { cleaned: false, quiescent: false };
      if (!await awaitProcessGroupEmpty(this.drainGraceMs)) {
        this.client.close();
        return { cleaned: await awaitProcessGroupEmpty(this.drainKillMs), quiescent: false };
      }
      const cleaned = this.client.inspectProcessGroupEmpty();
      return { cleaned, quiescent: cleaned && this.client.inspectQuiescentExit() };
    } catch {
      try { this.client.close(); } catch {}
      return { cleaned: false, quiescent: false };
    }
  }
}

import type { AntigravityQuotaWaitState } from '@agentopsdeck/shared';

const MAX_TIMEOUT_CHUNK_MS = 2_000_000_000;

type WaitEntry = {
  state: AntigravityQuotaWaitState;
  resumePrompt: string;
  timer?: ReturnType<typeof setTimeout> | undefined;
};

/** Manages Antigravity quota-reached wait states and automatic timed continuation.
 * Never persists credentials or replays uncertain commands outside the normal turn pipeline. */
export class AntigravityQuotaRetryManager {
  private readonly entries = new Map<string, WaitEntry>();
  private closed = false;

  constructor(
    private readonly options: {
      onChange?: (sessionKey: string) => void;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get(sessionKey: string): AntigravityQuotaWaitState | undefined {
    const entry = this.entries.get(sessionKey);
    if (!entry) return undefined;
    if (entry.state.retryAt <= this.now() && !entry.timer) {
      this.entries.delete(sessionKey);
      return undefined;
    }
    return { ...entry.state };
  }

  schedule(
    sessionKey: string,
    wait: AntigravityQuotaWaitState,
    resumePrompt: string,
    onResume: (sessionKey: string, prompt: string) => void | Promise<void>,
  ): void {
    if (this.closed) return;
    this.clearTimer(sessionKey);
    const entry: WaitEntry = {
      state: { ...wait, autoRetry: true },
      resumePrompt: resumePrompt.trim() || 'Continue.',
    };
    this.entries.set(sessionKey, entry);
    this.armTimer(sessionKey, entry, onResume);
    this.options.onChange?.(sessionKey);
  }

  cancel(sessionKey: string): boolean {
    if (!this.entries.has(sessionKey)) return false;
    this.clearTimer(sessionKey);
    this.entries.delete(sessionKey);
    this.options.onChange?.(sessionKey);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const key of [...this.entries.keys()]) {
      this.clearTimer(key);
    }
    this.entries.clear();
  }

  private clearTimer(sessionKey: string): void {
    const existing = this.entries.get(sessionKey);
    if (existing?.timer) {
      clearTimeout(existing.timer);
      existing.timer = undefined;
    }
  }

  private armTimer(
    sessionKey: string,
    entry: WaitEntry,
    onResume: (sessionKey: string, prompt: string) => void | Promise<void>,
  ): void {
    const remaining = Math.max(0, entry.state.retryAt - this.now());
    const delayMs = Math.min(remaining, MAX_TIMEOUT_CHUNK_MS);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.closed || this.entries.get(sessionKey) !== entry) return;
      if (this.now() + 50 < entry.state.retryAt) {
        this.armTimer(sessionKey, entry, onResume);
        return;
      }
      this.entries.delete(sessionKey);
      this.options.onChange?.(sessionKey);
      void Promise.resolve(onResume(sessionKey, entry.resumePrompt)).catch(() => {
        /* Resume dispatch failures surface through normal turn/session state. */
      });
    }, delayMs);
    entry.timer.unref?.();
  }
}

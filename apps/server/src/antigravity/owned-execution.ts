import type { PrivateAgentHomeLease } from '../connector/private-agent-home-lease.js';
import type { AntigravityHandshake, AntigravitySessionUpdate } from './acp-client.js';

export type AntigravityExecutionIdentity = Readonly<{
  key: string;
  executionId: string;
  ownerEpoch: string;
}>;
export type AntigravityExecutionOutcome = 'completed' | 'cancelled' | 'failed' | 'unknown';
export type AntigravityExecutionResult = {
  outcome: AntigravityExecutionOutcome;
  nativeSessionId?: string;
};
export interface AntigravityExecutionJournal {
  assertBinding(identity: AntigravityExecutionIdentity, nativeSessionId: string): void;
  bindAndPersistIntent(identity: AntigravityExecutionIdentity, nativeSessionId: string): Promise<void>;
  settle(identity: AntigravityExecutionIdentity, result: AntigravityExecutionResult): Promise<void>;
}
export interface AntigravityExecutionWorker {
  initialize(): Promise<AntigravityHandshake>;
  newSession(): Promise<string>;
  resumeOwnedSession(sessionId: string, assertOwnedSession: (sessionId: string) => void): Promise<void>;
  prompt(text: string, persistIntent: (sessionId: string) => Promise<void>): Promise<{ stopReason: string }>;
  cancel(): void;
  stopAndDrain(): Promise<{ cleaned: boolean; quiescent: boolean }>;
}
export type AntigravityOwnedExecutionOptions = {
  identity: AntigravityExecutionIdentity;
  resumeSessionId?: string;
  homeLease: Pick<PrivateAgentHomeLease, 'assertHeld' | 'releaseAfter'>;
  assertOwnership: () => void;
  journal: AntigravityExecutionJournal;
  createWorker: (hooks: {
    assertOwnership: () => void;
    update: (update: AntigravitySessionUpdate) => void;
  }) => AntigravityExecutionWorker;
  update: (identity: AntigravityExecutionIdentity, update: AntigravitySessionUpdate) => void;
};

const failure = () => Error('Antigravity execution ownership or cleanup is unconfirmed; use offline recovery');
const validIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

function assertSynchronously(assertion: () => void) {
  try {
    const result: unknown = assertion();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw failure();
    }
  } catch { throw failure(); }
}

export class AntigravityOwnedExecution {
  private readonly identity: AntigravityExecutionIdentity;
  private readonly resumeSessionId: string | undefined;
  private worker: AntigravityExecutionWorker | undefined;
  private started = false;
  private draining = false;
  private stopped = false;
  private intentVerified = false;
  private prompting = false;
  private nativeSessionId: string | undefined;

  constructor(private readonly options: AntigravityOwnedExecutionOptions) {
    if (!validIdentity(options.identity.key) || !options.identity.key.startsWith('antigravity:')
      || options.identity.key === 'antigravity:' || !validIdentity(options.identity.executionId)
      || !validIdentity(options.identity.ownerEpoch)
      || options.resumeSessionId !== undefined && !validIdentity(options.resumeSessionId)) throw failure();
    this.identity = Object.freeze({ key: options.identity.key, executionId: options.identity.executionId,
      ownerEpoch: options.identity.ownerEpoch });
    this.resumeSessionId = options.resumeSessionId;
    this.assertAdmission();
    if (this.resumeSessionId) this.assertBinding(this.resumeSessionId);
  }

  private assertBinding(nativeSessionId: string) {
    assertSynchronously(() => this.options.journal.assertBinding(this.identity, nativeSessionId));
  }

  private assertAdmission() {
    if (this.draining) throw failure();
    assertSynchronously(this.options.assertOwnership);
    assertSynchronously(() => this.options.homeLease.assertHeld());
    if (this.intentVerified && this.nativeSessionId) this.assertBinding(this.nativeSessionId);
  }

  cancel(): void {
    if (this.draining) return;
    this.assertAdmission();
    this.stopped = true;
    if (this.prompting) {
      try { this.worker?.cancel(); } catch { throw failure(); }
    }
  }

  async run(text: string): Promise<AntigravityExecutionResult> {
    if (this.started || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 524_288) throw failure();
    this.started = true;
    let outcome: AntigravityExecutionOutcome = 'unknown';
    let workerCreated = false;
    try {
      this.assertAdmission();
      if (!this.stopped) {
        this.worker = this.options.createWorker({
          assertOwnership: () => this.assertAdmission(),
          update: update => {
            this.assertAdmission();
            if (!this.intentVerified || update.sessionId !== this.nativeSessionId) throw failure();
            assertSynchronously(() => this.options.update(this.identity, update));
          },
        });
        workerCreated = true;
        await this.worker.initialize();
        this.assertAdmission();
        if (this.stopped) throw failure();
        if (this.resumeSessionId) {
          await this.worker.resumeOwnedSession(this.resumeSessionId, sessionId => {
            this.assertAdmission();
            if (sessionId !== this.resumeSessionId) throw failure();
            this.assertBinding(sessionId);
          });
          this.nativeSessionId = this.resumeSessionId;
        } else {
          const nativeSessionId = await this.worker.newSession();
          if (!validIdentity(nativeSessionId)) throw failure();
          this.nativeSessionId = nativeSessionId;
        }
        this.assertAdmission();
        if (this.stopped) throw failure();
        this.prompting = true;
        const result = await this.worker.prompt(text, async sessionId => {
          this.assertAdmission();
          if (this.stopped || sessionId !== this.nativeSessionId) throw failure();
          await this.options.journal.bindAndPersistIntent(this.identity, sessionId);
          this.assertAdmission();
          this.assertBinding(sessionId);
          this.intentVerified = true;
          if (this.stopped) throw failure();
        }).finally(() => { this.prompting = false; });
        this.assertAdmission();
        if (this.intentVerified) {
          if (result.stopReason === 'end_turn') outcome = 'completed';
          else if (result.stopReason === 'cancelled' && this.stopped) outcome = 'cancelled';
          else if (['max_tokens', 'max_turn_requests', 'refusal'].includes(result.stopReason)) outcome = 'failed';
        }
      }
    } catch {
      outcome = 'unknown';
      if (!workerCreated) {
        this.draining = true;
        throw failure();
      }
    }
    this.draining = true;
    try {
      let result: AntigravityExecutionResult;
      await this.options.homeLease.releaseAfter(async () => {
        const evidence = this.worker ? await this.worker.stopAndDrain() : { cleaned: true, quiescent: true };
        if (evidence.cleaned !== true) throw failure();
        if (evidence.quiescent !== true) outcome = 'unknown';
        assertSynchronously(this.options.assertOwnership);
        if (outcome !== 'unknown' && this.nativeSessionId) this.assertBinding(this.nativeSessionId);
        result = { outcome, ...(this.nativeSessionId ? { nativeSessionId: this.nativeSessionId } : {}) };
        await this.options.journal.settle(this.identity, { ...result });
        assertSynchronously(this.options.assertOwnership);
      });
      return result!;
    } catch { throw failure(); }
  }
}

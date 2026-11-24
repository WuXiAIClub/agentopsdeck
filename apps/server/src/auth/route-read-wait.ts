import { AuthPersistenceError } from './private-store.js';
import { AuthRoutePersistence, type Awaitable } from './route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Only read/final-proof phases may have their HTTP wait ended here. The
 * original owner and shared admission slot remain live until real settlement.
 * This cannot cancel SQL, acknowledge a write or grant mutation authority. */
export type AuthRouteReadStep = 110 | 96 | 95 | 94 | 92 | 1 | 2 | 6 | 7 | 9 | 10 | 12 | 13 | 17 | 20 | 22 | 26 | 31 | 33 | 35 | 37 | 38 | 40 | 43 | 48 | 49 | 63 | 64 | 65 | 67 | 69 | 71 | 75 | 77 | 79 | 81 | 82 | 83 | 84 | 85 | 86 | 89 | 90 | 91;
const readSteps = new Set<number>([1, 2, 6, 7, 9, 10, 12, 13, 17, 20, 22, 26, 31, 33, 35, 37, 38, 40, 43, 48, 49, 63, 64, 65, 67, 69, 71, 75, 77, 79, 81, 82, 83, 84, 85, 86, 89, 90, 91, 92, 94, 95, 96, 110]);

export class AuthReadCancelledError extends AuthPersistenceError {}

export class AuthRouteReadWait {
  constructor(private readonly persistence: AuthRoutePersistence,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new AuthPersistenceError();
  }
  async run<T>(request: Request, step: AuthRouteReadStep, work: () => Awaitable<T>): Promise<{ value: T }> {
    if (!readSteps.has(step)) throw new AuthPersistenceError();
    if (request.signal.aborted) {
      this.observeWaitEnd(step, 'cancelled');
      throw new AuthReadCancelledError();
    }
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new AuthReadCancelledError());
      request.signal.addEventListener('abort', abort, { once: true });
    });
    let timer!: ReturnType<typeof setTimeout>;
    let deadlineError: AuthPersistenceError | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        deadlineError = request.signal.aborted ? new AuthReadCancelledError() : new AuthPersistenceError();
        reject(deadlineError);
      }, this.timeoutMs);
    });
    // Race observes BOTH late outcomes. Never await a raw result again: the
    // persistence port boxes values to avoid a second caller `then` inspection.
    const original = this.persistence.run(step, work);
    try {
      const result = await Promise.race([original, cancelled, expired]);
      if (request.signal.aborted) throw new AuthReadCancelledError();
      return result;
    } catch (error) {
      // Observe only the winning wait outcome. An abort and an already-queued
      // timer can both run before finally clears the timer; that is one HTTP
      // settlement, not both a cancellation and a SQL timeout.
      if (error instanceof AuthReadCancelledError) this.observeWaitEnd(step, 'cancelled');
      else if (error === deadlineError) this.observeWaitEnd(step, 'timedOut');
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
    }
  }
  private observeWaitEnd(step: AuthRouteReadStep, outcome: 'timedOut' | 'cancelled') {
    try {
      const trace = this.diagnostics.start('auth-route-persistence');
      trace.add('step', step); trace.add(outcome, 1); trace.add('pending', this.persistence.pending); trace.finish(true);
    } catch { /* Observation cannot extend the HTTP wait or release SQL. */ }
  }
}

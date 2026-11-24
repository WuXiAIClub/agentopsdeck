// Retry superseded transport or transient read errors boundedly (at most twice
// for an unchanged history boundary) so initial conversation fill does not wedge.
export type HistoryBackfillOutcome = void | 'superseded' | 'retryable-error';
type Attempt = { key: string; number: number };
export function createHistoryBackfillAttempts() {
  let current: Attempt | undefined;
  let ready = false;
  return {
    begin(key: string): Attempt | undefined {
      if (current?.key === key && !ready) return undefined;
      current = { key, number: current?.key === key ? current.number + 1 : 1 };
      ready = false;
      return current;
    },
    retryDelay(attempt: Attempt, outcome: HistoryBackfillOutcome): number | undefined {
      if (current !== attempt || attempt.number >= 3) return undefined;
      if (outcome === 'superseded') return attempt.number * 150;
      if (outcome === 'retryable-error') return attempt.number * 1000;
      return undefined;
    },
    release(attempt: Attempt): boolean {
      if (current !== attempt || attempt.number >= 3) return false;
      ready = true;
      return true;
    },
    reset() { current = undefined; ready = false; },
  };
}

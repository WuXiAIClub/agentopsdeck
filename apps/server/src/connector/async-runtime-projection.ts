import { createTaskDrain } from '../lifecycle/task-drain.js';
import { ExecutionProjectionChanged } from './execution-projection-inventory.js';

/** The root supplies EVERY configured runtime fragment, never an SDK-only
 * substitute for a Deck-wide refresh. No native-idle/permission inference. */
export function createAsyncRuntimeProjection(fragments: readonly (() => Promise<void>)[]) {
  const refreshers = [...fragments], tasks = createTaskDrain();
  let closed = false, generation = 0, last = 0, inflight: Promise<void> | undefined;
  const available = () => { if (closed) throw Error('Runtime projection unavailable'); };
  const refresh = (options: { maxAgeMs?: number } = {}): Promise<void> => {
    try { available(); } catch (error) { return Promise.reject(error); }
    const maxAge = options.maxAgeMs ?? 0;
    if (!inflight && last && maxAge > 0 && Date.now() - last < maxAge) return Promise.resolve();
    ++generation;
    if (inflight) return inflight;
    last = 0;
    // Register physical work before invoking any root callback. A concurrent
    // fresh caller requests a successor scan, not an old scan's tail.
    const work = tasks.run(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = generation;
        available();
        const results = await Promise.allSettled(refreshers.map(run => Promise.resolve().then(() => { available(); return run(); })));
        available();
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.some(result => !(result.reason instanceof ExecutionProjectionChanged))) throw Error('Runtime projection refresh failed');
        if (failures.length) throw new ExecutionProjectionChanged();
        if (current === generation) { last = Date.now(); return; }
      }
      throw new ExecutionProjectionChanged();
    });
    inflight = work.finally(() => { inflight = undefined; });
    return inflight;
  };
  return {
    refresh,
    assertCurrent() { available(); if (!last || inflight) throw Error('Runtime projection is not current'); },
    close() { closed = true; last = 0; return tasks.close(); },
  };
}

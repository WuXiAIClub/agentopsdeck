import { observeHistoryStage } from './history-diagnostics.js';

/** Fixed-size numeric counters only; never retain SQL, paths, messages or IDs.
 * Iterator timings measure SQLite step time, excluding caller JSON/render work. */
export class ReadTimings {
  private counters = { sqlSteps: 0, sqlMs: 0, sqlMaxMs: 0, jsonCalls: 0, jsonMs: 0, jsonBytes: 0 };
  snapshot() { return { ...this.counters }; }
  *rows<T>(values: Iterable<T>): Generator<T> {
    const iterator = values[Symbol.iterator]();
    try {
      while (true) {
        const start = performance.now();
        let next: IteratorResult<T>;
        let failed = true;
        try { next = iterator.next(); failed = false; }
        finally { const elapsed = performance.now() - start; this.counters.sqlSteps++; this.counters.sqlMs += elapsed; this.counters.sqlMaxMs = Math.max(this.counters.sqlMaxMs, elapsed); observeHistoryStage('sql', elapsed, failed); }
        if (next.done) return;
        yield next.value;
      }
    } finally { iterator.return?.(); }
  }
  parse(text: string): unknown {
    const start = performance.now();
    let failed = true;
    try { const value: unknown = JSON.parse(text); failed = false; return value; }
    finally {
      // Stop before UTF-8 accounting: byteLength is another linear scan and
      // must not be attributed to JSON.parse when diagnosing large records.
      const elapsed = performance.now() - start;
      observeHistoryStage('json', elapsed, failed);
      this.counters.jsonCalls++; this.counters.jsonMs += elapsed;
      this.counters.jsonBytes += Buffer.byteLength(text);
    }
  }
}

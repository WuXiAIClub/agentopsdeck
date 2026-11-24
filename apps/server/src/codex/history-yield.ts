import { setImmediate } from 'node:timers/promises';

/** Promise/async-generator awaits alone drain microtasks without servicing
 * native stdio, SSE or timeout callbacks. Yield bounded history batches to the
 * event loop, not a sleep, global queue or execution-proof shortcut. */
export class HistoryYield {
  private records = 0;
  private units = 0;
  checkpoint(units: number): Promise<void> | undefined {
    this.records++;
    this.units += units;
    if (this.records < 256 && this.units < 256 * 1024) return;
    this.records = 0;
    this.units = 0;
    return setImmediate();
  }
}

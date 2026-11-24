// A wake-up hint, never an event queue or a source of truth. Callers capture the
// revision before reading durable state, then wait only if nothing changed.
export class ChangeSignal {
  private listeners = new Set<() => void>();
  revision = 0;

  get waiting() { return this.listeners.size; }

  notify() {
    this.revision++;
    for (const wake of this.listeners) wake();
  }

  wait(revision: number, signal: AbortSignal, timeoutMs?: number): Promise<void> {
    if (signal.aborted || revision !== this.revision) return Promise.resolve();
    if (this.listeners.size >= 256) return Promise.reject(new Error('Change wait capacity exceeded'));
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = timeoutMs === undefined ? undefined : setTimeout(done, timeoutMs);
      this.listeners.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

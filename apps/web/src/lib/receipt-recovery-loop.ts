/** GET-only recovery scheduling. The caller supplies pending records and a
 * receipt reader, never a send callback. Events do not reset existing backoff. */
export function createReceiptRecoveryLoop<T>(options: {
  read: () => T[];
  identity: (row: T) => string;
  check: (rows: T[]) => Promise<void>;
  enabled: () => boolean;
  busy: () => boolean;
}) {
  const retries = new Map<string, { attempts: number; at: number }>();
  const delays = [2_000, 5_000, 10_000, 30_000, 60_000];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let nextBatch = 0;

  function pending(immediate = false) {
    const rows = options.read();
    const ids = new Set(rows.map(options.identity));
    for (const id of retries.keys()) if (!ids.has(id)) retries.delete(id);
    for (const id of ids) {
      const previous = retries.get(id);
      if (!previous) retries.set(id, { attempts: 0, at: Date.now() + (immediate ? 0 : delays[0]!) });
      else if (immediate) previous.at = Date.now();
    }
    return rows;
  }

  function request(immediate = false) {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending(immediate);
    if (running || !options.enabled() || !retries.size) return;
    const earliest = Math.min(...Array.from(retries.values(), retry => retry.at));
    timer = setTimeout(() => { void tick(); }, Math.max(0, earliest - Date.now(), nextBatch - Date.now()));
  }

  async function tick() {
    timer = undefined;
    if (stopped || !options.enabled()) return;
    if (options.busy()) { nextBatch = Date.now() + 1_000; request(); return; }
    // Sort by due time: an unavailable oldest record must not starve record 5+.
    const batch = pending().filter(row => retries.get(options.identity(row))!.at <= Date.now())
      .sort((a, b) => retries.get(options.identity(a))!.at - retries.get(options.identity(b))!.at).slice(0, 4);
    if (!batch.length) { request(); return; }
    running = true;
    try { await options.check(batch); }
    catch { /* The reader reports failures; unresolved records remain eligible. */ }
    finally {
      running = false;
      if (!stopped) {
        for (const row of batch) {
          const retry = retries.get(options.identity(row));
          if (retry) { retry.at = Date.now() + delays[Math.min(retry.attempts++, delays.length - 1)]!; }
        }
        nextBatch = Date.now() + 1_000;
        request();
      }
    }
  }

  return {
    request,
    stop() { stopped = true; if (timer !== undefined) clearTimeout(timer); retries.clear(); },
  };
}

/** Do not expose arbitrary server response bodies in a delivery notice. */
export function receiptFailureKind(error: unknown): 'missing' | 'denied' | 'auth' | 'temporary' {
  if (error && typeof error === 'object') {
    const status = 'status' in error ? error.status : undefined;
    if (status === 404 || status === 410) return 'missing';
    if (status === 403) return 'denied';
    if (status === 401 || ('name' in error && error.name === 'AuthRequiredError')) return 'auth';
  }
  return 'temporary';
}

import type { TestContext } from 'node:test';
import { setTimeout as nativeSetTimeout, clearTimeout as nativeClearTimeout } from 'node:timers';

// Capture before any test mocks timers or calls syncBuiltinESMExports(). This
// watchdog measures a broken test barrier, not the product's HTTP deadline.
const barrierTimer = nativeSetTimeout, clearBarrierTimer = nativeClearTimeout;

/** Observe the original request exactly once; never recreate or replay it.
 * Early HTTP completion must fail the intended physical-admission assertion.
 * The real watchdog also bounds a broken fixture where neither side settles. */
export async function awaitHttpAdmission(
  entered: PromiseLike<unknown>, original: { status: number } | PromiseLike<{ status: number }>,
  label = 'original physical work', watchdogMs = 15_000,
): Promise<void> {
  if (!Number.isSafeInteger(watchdogMs) || watchdogMs < 1) throw Error('Invalid barrier watchdog');
  let timer: ReturnType<typeof nativeSetTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(entered),
      Promise.resolve(original).then(response => { throw Error(`${label}: HTTP ended before admission (${response.status})`); }),
      new Promise<never>((_, reject) => {
        timer = barrierTimer(() => reject(Error(`${label}: admission barrier did not settle`)), watchdogMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearBarrierTimer(timer); }
}

/** Test-only main-thread time. Open real Auth/worker fixtures before creating
 * this controller. Advance only after the intended original admission gate.
 * Worker clocks, SQL, authorization and native/file effects remain real. */
export function controlledHttpDeadline(t: TestContext, watchdogMs = 15_000) {
  if (!Number.isSafeInteger(watchdogMs) || watchdogMs < 1) throw Error('Invalid deadline watchdog');
  const epoch = performance.now();
  let elapsed = 0, restored = false;
  const clock = t.mock.method(performance, 'now', () => epoch + elapsed);
  try { t.mock.timers.enable({ apis: ['setTimeout'] }); }
  catch (error) { clock.mock.restore(); throw error; }
  const restore = () => {
    if (restored) return;
    restored = true;
    try { t.mock.timers.reset(); } finally { clock.mock.restore(); }
  };
  t.after(restore);
  return {
    restore,
    /** Preserve the original HTTP budget, and restore real time before the
     * caller releases physical work or starts shutdown/receipt verification. */
    async expire<T>(milliseconds: number, original: T | PromiseLike<T>): Promise<T> {
      let timer: ReturnType<typeof nativeSetTimeout> | undefined;
      try {
        if (restored || !Number.isSafeInteger(milliseconds) || milliseconds < 1)
          throw Error('Invalid controlled HTTP deadline');
        elapsed += milliseconds;
        t.mock.timers.tick(milliseconds);
        return await Promise.race([
          Promise.resolve(original),
          new Promise<never>((_, reject) => {
            timer = barrierTimer(() => reject(Error('Original HTTP did not settle after controlled expiry')), watchdogMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearBarrierTimer(timer);
        restore();
      }
    },
  };
}

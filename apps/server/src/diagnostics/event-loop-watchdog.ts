import { randomUUID } from 'node:crypto';
import { Worker, type WorkerOptions } from 'node:worker_threads';

type WatchdogOptions = { heartbeatMs?: number; pollMs?: number; stallMs?: number; repeatMs?: number };

/** Observation only. A missing heartbeat does not identify a SQL operation or
 * prove a deadlock. Never release an owner, terminate business work, or replay
 * a command from this diagnostic. The sole worker owns no business resources.
 * Its direct stderr write bypasses the blocked main-thread console transport.
 */
export function startEventLoopWatchdog(options: WatchdogOptions = {},
  launch: (script: string, options: WorkerOptions) => Worker = (script, options) => new Worker(script, options)): { stop(): void } {
  const heartbeatMs = options.heartbeatMs ?? 1000, pollMs = options.pollMs ?? 1000;
  const stallMs = options.stallMs ?? 10_000, repeatMs = options.repeatMs ?? 60_000;
  if (![heartbeatMs, pollMs, stallMs, repeatMs].every(value => Number.isSafeInteger(value) && value >= 20 && value <= 300_000)
    || stallMs < 2 * Math.max(heartbeatMs, pollMs) || repeatMs < stallMs) {
    throw new Error('Invalid event-loop watchdog configuration');
  }
  const state = new BigInt64Array(new SharedArrayBuffer(16));
  const heartbeat = () => Atomics.store(state, 0, process.hrtime.bigint());
  heartbeat(); Atomics.store(state, 1, 1n);
  let worker: Worker | undefined, timer: ReturnType<typeof setInterval> | undefined, stopped = false;
  const terminate = () => { try { void worker?.terminate().catch(() => {}); } catch { /* Best effort. */ } };
  const unavailable = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    Atomics.store(state, 1, 0n);
    terminate();
    // Fixed vocabulary: never expose worker error messages, paths or inputs.
    try { console.error(JSON.stringify({ component: 'agentopsdeck-event-loop', version: 1, phase: 'unavailable' })); }
    catch { /* Diagnostics cannot change application startup or authority. */ }
  };
  try {
    worker = launch(`
      const { workerData } = require('node:worker_threads');
      const { writeSync } = require('node:fs');
      const state = new BigInt64Array(workerData.state);
      let sequence = 0, pending = false, reportedAt = 0n;
      const emit = (phase, elapsedMs) => {
        try {
          writeSync(2, JSON.stringify({ component: 'agentopsdeck-event-loop', version: 1,
            instance: workerData.instance, sequence, phase,
            elapsedMs: Math.min(Number.MAX_SAFE_INTEGER, Math.round(elapsedMs)) }) + '\\n');
        } catch { /* No diagnostic error can affect the business owner. */ }
      };
      const timer = setInterval(() => {
        if (Atomics.load(state, 1) !== 1n) { clearInterval(timer); return; }
        const now = process.hrtime.bigint();
        const elapsedMs = Math.max(0, Number(now - Atomics.load(state, 0)) / 1e6);
        if (elapsedMs >= workerData.stallMs) {
          if (!pending) { pending = true; sequence++; reportedAt = now; emit('pending', elapsedMs); }
          else if (Number(now - reportedAt) / 1e6 >= workerData.repeatMs) {
            reportedAt = now; emit('pending', elapsedMs);
          }
        } else if (pending) { pending = false; emit('heartbeat-restored', elapsedMs); }
      }, workerData.pollMs);
    `, { eval: true, execArgv: [], workerData: { state: state.buffer, instance: randomUUID(), pollMs, stallMs, repeatMs } });
    worker.on('error', unavailable);
    worker.once('exit', () => { if (!stopped) unavailable(); });
    worker.unref();
    timer = setInterval(heartbeat, heartbeatMs); timer.unref();
  } catch { unavailable(); }
  return { stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    Atomics.store(state, 1, 0n);
    // Only this resource-free diagnostic worker is terminated. Do not await it
    // on a shutdown path or keep the process alive for diagnostic output.
    terminate();
  } };
}

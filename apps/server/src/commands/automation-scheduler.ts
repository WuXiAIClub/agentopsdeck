import { nextAutomationTimer, type AutomationObservation, type AutomationTarget,
  type AutomationRule, type CompletionTrigger, type TimerTrigger } from './automation-policy.js';
import { AutomationStore, type StoredAutomationRule } from './automation-store.js';
import type { AutomationRunner } from './automation-runner.js';

type Cursor = { identity: string; next: TimerTrigger | undefined };
export type AutomationSchedulerResult = { considered: number; dispatched: number; rejected: number; busy: boolean };
const result = (): AutomationSchedulerResult => ({ considered: 0, dispatched: 0, rejected: 0, busy: false });
const identity = (s: StoredAutomationRule) => JSON.stringify([s.rule.revision, s.rule.authorityEpoch, s.rule.target]);
const sameTarget = (a: AutomationTarget, b: AutomationTarget) => a.ownerId === b.ownerId
  && a.connectionId === b.connectionId && a.runtime === b.runtime && a.sessionId === b.sessionId;

/** Explicitly-started, owner-local scheduler. Construction does not send. Native
 * runtime supplies fresh observations and trusted completion events; this is NOT
 * an HTTP completion endpoint. There is no startup catch-up, retry queue, or
 * automatic replay/recovery of a persisted reservation. Dispatch/unknown quotas
 * and native start gates remain owned by AutomationStore/Runner/TurnQueue. */
export class AutomationScheduler {
  private cursors = new Map<string, Cursor>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private active = 0;
  private polling = false;
  private since = 0;
  private highWater = 0;
  private generation = 0;
  constructor(private readonly owner: string, private readonly store: AutomationStore,
    private readonly runner: Pick<AutomationRunner, 'dispatch'>,
    private readonly observe: (target: AutomationTarget, rule: AutomationRule) => AutomationObservation,
    private readonly authorized: (target: AutomationTarget) => boolean,
    private readonly clock: () => number = Date.now) {}
  private now() {
    const n = this.clock();
    if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid scheduler clock');
    return n;
  }
  /** Host may disable the timer and drive tick explicitly in deterministic tests.
   * Repeated start never resets quotas or creates a second timer. */
  start(timer = true) {
    if (this.running) return;
    const now = this.now();
    this.since = now; this.highWater = Math.max(this.highWater, now);
    const rules = this.store.list(this.owner);
    this.cursors.clear();
    for (const stored of rules) this.cursor(stored, this.highWater);
    this.running = true; this.generation++;
    if (timer) {
      this.timer = setInterval(() => { void this.tick().catch(() => { this.stop(); }); }, 1000);
      this.timer.unref();
    }
  }
  /** Stops future observation; it cannot undo an already admitted native turn.
   * Revocation must advance the durable rule authority epoch separately. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.running = false; this.cursors.clear(); this.generation++;
  }
  private cursor(stored: StoredAutomationRule, now: number) {
    const key = stored.rule.id, prior = this.cursors.get(key), value = identity(stored);
    if (prior?.identity === value) return prior;
    const next = { identity: value, next: stored.revoked ? undefined : nextAutomationTimer(stored.rule, now) };
    this.cursors.set(key, next); return next;
  }
  private async dispatch(stored: StoredAutomationRule, trigger: TimerTrigger | CompletionTrigger,
    summary: AutomationSchedulerResult) {
    summary.considered++;
    // No waiting list: excess concurrency is skipped, not delivered later.
    if (!this.running || this.active >= 4) { summary.busy = true; return; }
    this.active++;
    try {
      if (!this.authorized(stored.rule.target)) { summary.rejected++; return; }
      const view = this.observe(stored.rule.target, stored.rule);
      const receipt = this.store.reserve(this.owner, stored.rule.id, trigger, view);
      // Already-claimed original requests are intentionally not dispatched.
      if (receipt.state !== 'reserved') return;
      const outcome = await this.runner.dispatch(this.owner, receipt.requestId);
      if (outcome.state === 'queued') summary.dispatched++; else summary.rejected++;
    } catch { summary.rejected++; }
    finally { this.active--; }
  }
  async tick(): Promise<AutomationSchedulerResult> {
    const summary = result();
    if (!this.running) return summary;
    if (this.polling) return { ...summary, busy: true };
    this.polling = true;
    const generation = this.generation;
    try {
      const now = this.now();
      if (now < this.highWater) return summary;
      this.highWater = now;
      const rules = this.store.list(this.owner), alive = new Set(rules.map(s => s.rule.id));
      for (const key of this.cursors.keys()) if (!alive.has(key)) this.cursors.delete(key);
      const pending: Promise<void>[] = [];
      for (const stored of rules) {
        if (!this.running || this.generation !== generation) break;
        const cursor = this.cursor(stored, now), due = cursor.next;
        if (!due || due.at > now || stored.revoked) continue;
        // Move directly to the next future slot BEFORE IO, including failure.
        // A delayed event loop does not produce a burst of historical sends.
        cursor.next = nextAutomationTimer(stored.rule, now);
        pending.push(this.dispatch(stored, due, summary));
      }
      await Promise.all(pending); return summary;
    } finally { this.polling = false; }
  }
  /** Only call from the trusted current native completion observer. Restart
   * history, foreign/old connections and pre-start outcomes are not triggers. */
  async completed(target: AutomationTarget, trigger: CompletionTrigger): Promise<AutomationSchedulerResult> {
    const summary = result();
    if (!this.running || target.ownerId !== this.owner || trigger.completedAt < this.since) return summary;
    const now = this.now();
    if (now < this.highWater) return summary;
    this.highWater = now;
    const pending: Promise<void>[] = [];
    for (const stored of this.store.list(this.owner)) {
      if (!stored.revoked && stored.rule.enabled && stored.rule.mode.kind === 'completion'
        && sameTarget(stored.rule.target, target)) pending.push(this.dispatch(stored, trigger, summary));
    }
    await Promise.all(pending); return summary;
  }
}

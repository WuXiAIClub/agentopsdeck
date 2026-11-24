import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorAutomationBackgroundOutput } from './connector-automation-background-domain.js';
import type { CodexAppServer } from '../codex/app-server.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { AsyncCodexScheduling } from './async-codex-scheduling.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Single SQL-free background driver. One sequential plan/poll lane, no waiter
 * deadline that could release live physical work. This is an internal owner
 * port, not an HTTP API or a second native execution path. */
export class AsyncAutomationBackground {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private closing = false;
  private inflight: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closeWork?: Promise<void>;
  private paused: AdmissionPause | undefined;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: Pick<CodexAppServer, 'ownedAutomationObservation' | 'takeOwnedAutomationCompletions' | 'stopConnectionId'>;
    deck: Pick<DeckStore, 'addMessage'>;
    scheduling: Pick<AsyncCodexScheduling, 'notifyAdmission'>;
    /** Local veto only. Worker retains current authority and FIFO admission. */
    available?(): boolean;
    diagnostics?: PerformanceDiagnostics;
  }) {}
  start(timer = true) {
    if (this.closing) throw new ConnectorOwnerUnavailable();
    if (this.running) return;
    this.running = true;
    if (timer) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); this.timer.unref(); }
  }
  tick(): Promise<void> {
    if (!this.running || this.closing || this.paused || this.options.available?.() === false) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const work = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'connector-automation');
      let owners = 0, admitted = 0;
      try {
        let after = '';
        while (!this.closing && !this.paused && this.running && this.options.available?.() !== false) {
          const plan = await this.options.owner.command('automationBackgroundPlan', { after });
          if (!validConnectorAutomationBackgroundOutput('automationBackgroundPlan', plan)
            || plan && (plan.ownerId <= after || ++owners > 128)) throw new ConnectorOwnerUnavailable();
          // A plan is not admission. Do not consume native completions or
          // start a poll after maintenance/close wins the asynchronous read.
          if (!plan || this.closing || this.paused || this.options.available?.() === false) break;
          const connection = this.options.runtime.stopConnectionId;
          const observations = plan.targets.map(sessionKey => ({ sessionKey, connectionId: connection ?? null,
            ...this.options.runtime.ownedAutomationObservation(sessionKey) }));
          const completions = this.options.runtime.takeOwnedAutomationCompletions(plan.ownerId).filter(e => plan.targets.includes(e.sessionKey));
          const result = await this.options.owner.command('automationBackgroundPoll', { planId: plan.id, observations, completions });
          if (!validConnectorAutomationBackgroundOutput('automationBackgroundPoll', result)
            || result.queued.some(h => !plan.targets.includes(h.sessionKey) || !h.id.startsWith(`${h.sessionKey}:codex-queued-`))
            || new Set(result.queued.map(h => h.id)).size !== result.queued.length) throw new ConnectorOwnerUnavailable();
          admitted += result.queued.length;
          // A late worker reply cannot republish into a closed/reconnected
          // runtime. The original durable FIFO remains available for recovery.
          try {
            if (!this.closing && connection === this.options.runtime.stopConnectionId) {
              for (const h of result.queued) {
                this.options.deck.addMessage({ id: h.id, sessionKey: h.sessionKey, role: 'user', text: h.text,
                  status: 'queued', queueVersion: h.queueVersion, queueDisposition: 'preparing', createdAt: h.createdAt, updatedAt: h.createdAt });
              }
            }
          } finally {
            // A failed view subscriber also cannot hide durable admission from
            // the original FIFO consumer. Wake carries no execution authority.
            if (result.queued.length) this.options.scheduling.notifyAdmission();
          }
          after = plan.ownerId;
        }
        trace.add('step', 1); trace.add('records', owners); trace.add('changed', admitted); trace.add('settled', 1); trace.finish();
      } catch { trace.add('step', 1); trace.add('unknown', 1); trace.finish(true); throw new ConnectorOwnerUnavailable(); }
    });
    this.inflight = work;
    // Capture physical completion before exposing the public Promise. A caller
    // replacing its catch/then must not counterfeit shutdown completion.
    this.tail = work.then(() => { if (this.inflight === work) this.inflight = undefined; }, () => { if (this.inflight === work) this.inflight = undefined; });
    return work;
  }
  pause(): AdmissionPause {
    if (this.closing) throw new ConnectorOwnerUnavailable();
    if (this.paused) return this.paused;
    let settled = false;
    const lease: AdmissionPause = {
      // tail is private physical settlement, not the mutable public tick Promise.
      drained: this.tail.then(() => { settled = true; }),
      resume: () => {
        if (this.closing || this.paused !== lease || !settled) return false;
        this.paused = undefined; return true;
      },
    };
    this.paused = lease;
    return lease;
  }
  close(): Promise<void> {
    this.closing = true; this.running = false;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    return this.closeWork ??= Promise.resolve().then(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'connector-automation');
      trace.add('step', 2);
      try {
        if (this.inflight) trace.reportPending({ pending: 1 });
        await this.tail;
        const result = await this.options.owner.command('automationBackgroundStop', {});
        if (result !== null) throw new ConnectorOwnerUnavailable();
        trace.add('settled', 1); trace.finish();
      } catch { trace.add('unknown', 1); trace.finish(true); throw new ConnectorOwnerUnavailable(); }
    });
  }
}

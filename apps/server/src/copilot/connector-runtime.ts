import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { ConnectorAgentLifecycle } from '../connector/agent-runtimes.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';
import { CopilotOwnedRuntime } from './owned-runtime.js';
import type { AgentReadiness } from '@agentopsdeck/shared';

type Options = ConstructorParameters<typeof CopilotOwnedRuntime>[0];
const unavailable = () => new Error('Copilot runtime unavailable; inspect local configuration and ownership');

/** Defer private HOME acquisition and worker startup until Connector assembly
 * succeeds. A persisted maintenance fence can pause this adapter before that.
 * Failed startup must not disable other Agents or imply native quiescence. */
export class CopilotConnectorRuntime implements ConnectorAgentLifecycle {
  readonly id = 'ghcp' as const;
  private owned?: CopilotOwnedRuntime;
  private activated = false;
  private failed = false;
  private closed = false;
  private pause: AdmissionPause | undefined;
  private ownedPause: AdmissionPause | undefined;
  private closing?: Promise<void>;

  constructor(private readonly options: Options,
    private readonly createOwner = (options: Options) => new CopilotOwnedRuntime(options)) {}

  activate() {
    if (this.activated || this.closed) return;
    this.activated = true;
    // Assembly has succeeded. Claim HOME even during maintenance so that a
    // stopped runtime can prove ownership, but never launch native startup.
    if (this.pause) {
      try {
        this.owned = this.createOwner(this.options);
        this.ownedPause = this.owned.pauseQueueWorker();
      } catch { this.failed = true; }
      return;
    }
    this.start();
  }

  private start() {
    if (this.closed || this.pause || this.failed) return;
    try {
      this.owned ??= this.createOwner(this.options);
      void this.owned.initialize().catch(() => { this.failed = true; });
    } catch { this.failed = true; /* No retry/takeover on maintenance resume. */ }
  }

  get status(): AgentReadiness {
    if (this.closed) return 'closed';
    const ownedStatus = this.owned?.status;
    if (this.failed || ownedStatus === 'failed') return 'failed';
    if (this.pause) return 'maintenance';
    return ownedStatus ?? 'starting';
  }
  get ready() { return this.status === 'ready'; }
  get commands() {
    if (this.closed || this.pause || !this.owned) throw unavailable();
    return this.owned.commands;
  }
  refreshDirectory() { this.owned?.refreshDirectory(); }
  remove(key: string, authorize: () => void, acknowledge: () => void) {
    if (!this.ready || !this.owned) throw unavailable();
    return this.owned.remove(key, authorize, acknowledge);
  }
  async refreshSession(key: string, options: HistoryRefreshOptions = {}) {
    if (this.closed || this.failed || !this.owned) throw unavailable();
    await this.owned.refreshSession(key, options);
  }
  isSessionHistoryReady(key: string) { return !this.closed && !!this.owned?.isSessionHistoryReady(key); }
  recoverSession(key: string, expectedRunId: string) { return !this.closed && !this.failed && !!this.owned?.recoverSession(key, expectedRunId); }

  pauseQueueWorker(): AdmissionPause {
    if (this.closed) throw unavailable();
    if (this.pause) return this.pause;
    this.ownedPause = this.owned?.pauseQueueWorker();
    let drained = false;
    const pause: AdmissionPause = {
      drained: Promise.resolve().then(() => this.ownedPause?.drained).then(() => { drained = true; }),
      resume: () => {
        if (!drained || this.closed || this.pause !== pause || this.ownedPause && !this.ownedPause.resume()) return false;
        this.pause = undefined;
        this.ownedPause = undefined;
        if (this.activated) this.start();
        return true;
      },
    };
    this.pause = pause;
    return pause;
  }

  inspectMaintenance() {
    if (this.closed || this.failed || !this.owned) throw unavailable();
    const original = this.owned, pause = this.pause;
    const facts = original.inspectMaintenance();
    if (!facts.ownershipHeld || facts.cleanupUnconfirmed || facts.closed || facts.faulted) throw unavailable();
    return { ...facts, assertCurrent: () => {
      if (this.closed || this.failed || this.owned !== original || this.pause !== pause) throw unavailable();
      facts.assertCurrent();
    } };
  }

  close() {
    this.closed = true;
    return this.closing ??= this.owned?.close() ?? Promise.resolve();
  }
}

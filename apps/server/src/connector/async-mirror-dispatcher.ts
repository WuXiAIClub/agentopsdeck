import { createHash } from 'node:crypto';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import { MirrorDeliveryUnknown, MirrorDispatcherClosed, sendOutboundChannelMessage } from '../messages/mirror.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { mirrorDeliveryReplyMatches, validConnectorMirrorDeliveryInput, validConnectorMirrorDeliveryOutput } from './connector-mirror-delivery-domain.js';

/** One executor for original durable mirror intents. No timers, SQL, new
 * admission or retries. The existing queue's recovery paging drives visits. */
export class AsyncMirrorDispatcher {
  private readonly active = new Map<string, Promise<void>>();
  private closed = false;
  private pauseLease: AdmissionPause | undefined;
  private closing?: Promise<void>;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>; defaultAgentId: string;
    localOpenClawCli: boolean; sendOutbound?: typeof sendOutboundChannelMessage; diagnostics?: PerformanceDiagnostics }) {}

  reconcileSession = (key: string): Promise<void> => {
    if (this.closed || this.pauseLease) return Promise.reject(new MirrorDispatcherClosed());
    const previous = this.active.get(key);
    if (previous) return previous;
    // Each escaped native-reply envelope reserves at most 8 MiB in the shared
    // 16 MiB owner budget. Hold that physical reservation through the send.
    if (this.active.size >= 2) return Promise.reject(new ConnectorOwnerUnavailable());
    const input = { key, defaultAgentId: this.options.defaultAgentId, localOpenClawCli: this.options.localOpenClawCli };
    if (!validConnectorMirrorDeliveryInput('mirrorDeliveryClaim', input)) return Promise.reject(new ConnectorOwnerUnavailable());
    const physical = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'mirror-delivery');
      let failed = true;
      try {
        // A task frozen before its first physical command has no effect.
        if (this.closed || this.pauseLease) return;
        trace.add('step', 1);
        const claim = await this.options.owner.command('mirrorDeliveryClaim', input);
        if (!validConnectorMirrorDeliveryOutput('mirrorDeliveryClaim', claim) || !mirrorDeliveryReplyMatches(input, claim)) throw new ConnectorOwnerUnavailable();
        if (claim.state !== 'send') {
          // Fixed numeric outcomes distinguish quiet recovery from a settled
          // veto without logging identities, routes, content or exceptions.
          trace.add('step', { idle: 4, blocked: 5, no_output: 6 }[claim.state]);
          failed = false; return;
        }
        if (claim.ref.key !== key || createHash('sha256').update(claim.text).digest('hex') !== claim.ref.digest
          || !this.options.localOpenClawCli) throw new ConnectorOwnerUnavailable();
        // A held claim may have committed while close/pause started. Its
        // uncertain intent remains durable; shutdown never starts a late send.
        if (this.closed || this.pauseLease) throw new MirrorDispatcherClosed();
        trace.add('step', 2);
        try { await (this.options.sendOutbound ?? sendOutboundChannelMessage)(claim.route, claim.text, true); }
        catch { throw new MirrorDeliveryUnknown(); }
        // A successful physical effect must still settle after pause/close.
        trace.add('step', 3);
        if (await this.options.owner.command('mirrorDeliveryAck', claim.ref) !== true) throw new MirrorDeliveryUnknown();
        failed = false;
      } finally { trace.finish(failed); }
    });
    this.active.set(key, physical);
    const release = () => { this.active.delete(key); };
    void physical.then(release, release);
    return physical;
  };
  private drain() { return Promise.allSettled([...this.active.values()]).then(() => {}); }
  pauseAdmissions(): AdmissionPause {
    if (this.pauseLease) return this.pauseLease;
    let drained = false;
    const lease: AdmissionPause = { drained: this.drain().then(() => { drained = true; }), resume: () => {
      if (this.closed || this.pauseLease !== lease || !drained) return false;
      this.pauseLease = undefined; return true;
    } };
    return this.pauseLease = lease;
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.drain();
  }
}

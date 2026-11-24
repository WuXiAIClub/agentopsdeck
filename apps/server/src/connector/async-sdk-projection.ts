import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { CONNECTOR_PENDING_INPUT_BYTES, CONNECTOR_PENDING_LIMIT, connectorOwnerCommandBytes,
  connectorOwnerSteps, encodeConnectorOwnerJson, validConnectorOwnerInput, type ConnectorOwnerCommands } from './connector-owner-domain.js';
import { sameSdkTranscriptRef, validConnectorSdkTranscriptOutput } from './connector-sdk-transcript-domain.js';
import type { ClaudeProjectedMessage } from '../claude/message-projection.js';
import type { ClaudeStreamFinal, ClaudeTextStream } from '../claude/stream-projection.js';
import type { ClaudeToolDetail } from '../claude/tool-details.js';
import type { CopilotProjectedMessage } from '../copilot/message-projection.js';
import type { CopilotTextStream } from '../copilot/stream-projection.js';
import type { CopilotToolDetail } from '../copilot/tool-details.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import type { SdkMetricSample } from './sdk-metrics.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Kind = 'sdkTranscriptAppend' | 'sdkTranscriptStream' | 'sdkTranscriptEnd' | 'sdkMetricsObserve';
type Lane = { ref: SdkCompactRef; tail: Promise<void>; failed: boolean; closed: boolean };

/** Synchronous native callbacks, asynchronous ORIGINAL persistence. This is
 * not a history proof: terminal/settlement must await flush for the exact ref.
 * Accepted physical writes retain their budget until their original promise
 * settles, even if an outside waiter times out. No retry, replacement owner or
 * durable "completed" fact is manufactured on failure. */
export class AsyncSdkProjection {
  private readonly lanes = new Map<string, Lane>();
  private pending = 0;
  private bytes = 0;
  private accepting = true;
  private faulted = false;
  private closing: Promise<boolean> | undefined;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>; runtime: SdkAgentId;
    changed?: (key: string) => void; faulted?: (ref: SdkCompactRef) => void; diagnostics?: PerformanceDiagnostics }) {}
  snapshot() { return { executions: this.lanes.size, pending: this.pending, inputBytes: this.bytes, accepting: this.accepting,
    failed: [...this.lanes.values()].filter(l => l.failed).length, faulted: this.faulted }; }
  private lane(ref: SdkCompactRef): Lane {
    // Registration belongs to the original native starter, never a late
    // callback. An old callback cannot reopen a released or replaced lane.
    const scope = { key: ref.key, id: ref.id, epoch: ref.epoch, nativeSessionId: ref.nativeSessionId };
    if (!this.accepting || this.lanes.has(ref.key) || this.lanes.size >= CONNECTOR_PENDING_LIMIT
      || !validConnectorOwnerInput('sdkTranscriptEnd', { runtime: this.options.runtime, ref: scope })) throw Error('connector_storage_unavailable');
    const lane: Lane = { ref: scope, tail: Promise.resolve(), failed: false, closed: false };
    this.lanes.set(ref.key, lane); return lane;
  }
  claude(ref: SdkCompactRef) {
    if (this.options.runtime !== 'claude-code') throw Error('connector_storage_unavailable');
    const lane = this.lane(ref), scope = { runtime: 'claude-code' as const, ref: lane.ref };
    return {
      project: (rows: ClaudeProjectedMessage[], final?: ClaudeStreamFinal, details?: ClaudeToolDetail[]) => {
        this.enqueue(lane, 'sdkTranscriptAppend', { ...scope, rows, ...(final ? { final } : {}), ...(details ? { details } : {}) });
      },
      stream: (snapshot: ClaudeTextStream) => { this.enqueue(lane, 'sdkTranscriptStream', { ...scope, snapshot }); },
      metrics: (sample: SdkMetricSample) => { this.enqueue(lane, 'sdkMetricsObserve', { ...scope, sample }); },
    };
  }
  copilot(ref: SdkCompactRef, submittedText: string) {
    if (this.options.runtime !== 'ghcp') throw Error('connector_storage_unavailable');
    const lane = this.lane(ref), scope = { runtime: 'ghcp' as const, ref: lane.ref };
    return {
      project: (row: CopilotProjectedMessage, detail?: CopilotToolDetail) => {
        this.enqueue(lane, 'sdkTranscriptAppend', { ...scope, row, submittedText, ...(detail ? { detail } : {}) });
      },
      stream: (snapshot: CopilotTextStream) => { this.enqueue(lane, 'sdkTranscriptStream', { ...scope, snapshot }); },
      metrics: (sample: SdkMetricSample) => { this.enqueue(lane, 'sdkMetricsObserve', { ...scope, sample }); },
    };
  }
  private fail(lane: Lane, step: number) {
    if (lane.failed) return;
    lane.failed = true;
    this.faulted = true;
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'sdk-async-projection');
    trace.add('step', step); trace.add('unknown', 1); trace.finish(true);
    try { this.options.faulted?.({ ...lane.ref }); } catch { /* Observations cannot release protection. */ }
  }
  private enqueue<K extends Kind>(lane: Lane, kind: K, input: ConnectorOwnerCommands[K]['input'], closing = false) {
    if (lane.closed || !closing && !this.accepting) return;
    if (lane.failed && !closing) return;
    let fixed: ConnectorOwnerCommands[K]['input'], size: number;
    try {
      const body = encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(kind));
      fixed = JSON.parse(body); size = Buffer.byteLength(body);
      if (!validConnectorOwnerInput(kind, fixed) || this.pending >= CONNECTOR_PENDING_LIMIT
        || this.bytes + size > CONNECTOR_PENDING_INPUT_BYTES) throw Error('connector_storage_unavailable');
    } catch { this.fail(lane, connectorOwnerSteps[kind]); return; }
    this.pending++; this.bytes += size;
    lane.tail = lane.tail.then(async () => {
      if (lane.failed && !closing) return;
      const result = await this.options.owner.command(kind, fixed);
      let applied: boolean;
      if (kind === 'sdkMetricsObserve') {
        if (typeof result !== 'boolean') throw Error('connector_storage_unavailable');
        applied = result;
      } else {
        if (!validConnectorSdkTranscriptOutput(result) || result.runtime !== this.options.runtime
          || !sameSdkTranscriptRef(result.ref, lane.ref)) throw Error('connector_storage_unavailable');
        applied = result.applied;
      }
      // False stream means the original optional display cache was full. It
      // does not discard a durable final or imply persistence has failed.
      // Metric observations are idempotent/monotonic: duplicate event ids and
      // old sequences return false in the original journal, not a failed write.
      if (!applied && kind !== 'sdkTranscriptStream' && kind !== 'sdkMetricsObserve') throw Error('connector_storage_unavailable');
      if (applied) { try { this.options.changed?.(lane.ref.key); } catch { /* View is recoverable from original facts. */ } }
    }).catch(() => this.fail(lane, connectorOwnerSteps[kind])).finally(() => { this.pending--; this.bytes -= size; });
  }
  async flush(ref: SdkCompactRef): Promise<boolean> {
    const lane = this.lanes.get(ref.key);
    if (!lane || !sameSdkTranscriptRef(lane.ref, ref)) return false;
    // A callback may append while we wait. A stable physical tail, not just
    // the promise captured at entry, is the publication/settlement barrier.
    let tail: Promise<void>;
    do { tail = lane.tail; await tail; } while (tail !== lane.tail);
    return !lane.failed && this.lanes.get(ref.key) === lane;
  }
  async release(ref: SdkCompactRef): Promise<boolean> {
    const lane = this.lanes.get(ref.key);
    if (!lane || !sameSdkTranscriptRef(lane.ref, ref)) return false;
    if (!lane.closed) {
      this.enqueue(lane, 'sdkTranscriptEnd', { runtime: this.options.runtime, ref: lane.ref }, true);
      lane.closed = true;
    }
    await lane.tail;
    if (this.lanes.get(ref.key) === lane) this.lanes.delete(ref.key);
    return !lane.failed;
  }
  close(): Promise<boolean> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = Promise.all([...this.lanes.values()].map(lane => this.release(lane.ref))).then(values => values.every(Boolean) && !this.faulted);
    return this.closing;
  }
}

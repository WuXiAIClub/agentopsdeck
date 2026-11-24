import { projectCopilotMessage } from './message-projection.js';
import { projectCopilotToolDetail } from './tool-details.js';
import { CopilotTextStreams } from './stream-projection.js';
import { copilotLifecycleFrame, type CopilotWorkerReply } from './worker-protocol.js';
import { copilotMetricSample } from './metrics.js';
import { FileOperationEvidence } from '../messages/file-operation-evidence.js';

/** At most one timer and bounded queued lifecycle/projection frames. Token
 * deltas update bounded text in-place, not one pending IPC frame per token. */
export class CopilotStreamDelivery {
  private readonly text = new CopilotTextStreams();
  private readonly files = new FileOperationEvidence('ghcp');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail = Promise.resolve();
  private pending = 0;
  private failed = false;
  private closed = false;
  private metricSequence = 0;
  constructor(private readonly emit: (reply: CopilotWorkerReply) => Promise<void>,
    private readonly onFailure: () => void, private readonly intervalMs = 50, private readonly sessionId?: string) {}
  private enqueue(action: () => Promise<void>) {
    if (this.failed || ++this.pending > 256) throw new Error('Copilot stream delivery failed');
    const task = this.tail.then(async () => { if (this.failed) throw new Error('Copilot stream delivery failed'); await action(); });
    this.tail = task.catch(() => { this.failed = true; try { this.onFailure(); } catch { /* retain failure */ } }).finally(() => { this.pending--; });
  }
  send(value: unknown) {
    if (this.closed || this.failed) throw new Error('Copilot stream delivery closed');
    const frame = copilotLifecycleFrame(value), row = projectCopilotMessage(value);
    if (row?.role === 'tool') {
      const scope = [row.agentId ?? null, row.parentToolCallId ?? null, row.toolCallId!] as const;
      if (row.toolPhase === 'call') this.files.start(scope, row.nativeEventId, row.toolName!, (value as { data: { arguments?: unknown } }).data.arguments);
      else {
        const files = this.files.complete(scope, row.nativeEventId, row.toolError === false);
        if (files.length) row.sourceFiles = files;
      }
    }
    const detail = projectCopilotToolDetail(value, row);
    const sample = this.sessionId ? copilotMetricSample(value, this.metricSequence + 1) : undefined;
    if (sample) this.metricSequence++;
    // Final content supersedes any unflushed partial. Already emitted partial
    // snapshots and the final use the same public message identity.
    this.text.accept(value);
    if (sample || ['user.message', 'assistant.message', 'tool.execution_start', 'tool.execution_complete', 'session.error', 'session.idle'].includes(frame.type)) {
      this.enqueue(async () => {
        await this.emit({ kind: 'event', event: frame });
        if (row) await this.emit({ kind: 'projection', row, ...(detail ? { detail } : {}) });
        if (sample) await this.emit({ kind: 'metrics', nativeSessionId: this.sessionId!, sample });
      });
    }
    if (this.text.hasPending && !this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      // Capture before enqueuing so final removal cannot reorder a snapshot
      // after its final projection in the serialized output stream.
      const snapshots = this.text.drain();
      try { this.enqueue(async () => { for (const snapshot of snapshots) await this.emit({ kind: 'stream', snapshot }); }); }
      catch { this.failed = true; try { this.onFailure(); } catch { /* retain failure */ } }
    }, this.intervalMs);
  }
  async finish() {
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    const snapshots = this.text.drain();
    this.enqueue(async () => { for (const snapshot of snapshots) await this.emit({ kind: 'stream', snapshot }); });
    try {
      await this.tail;
      if (this.failed) throw new Error('Copilot stream delivery failed');
    } finally { this.files.close(); }
  }
  dispose() { this.closed = true; clearTimeout(this.timer); this.timer = undefined; this.files.close(); }
}

import { ClaudeTextStreams } from './stream-projection.js';
import { projectClaudeMessage } from './message-projection.js';
import { projectClaudeToolDetails } from './tool-details.js';
import { claudeLifecycleFrame, type ClaudeWorkerReply } from './worker-protocol.js';
import { ClaudeReconciledMetrics } from './metrics.js';
import { FileOperationEvidence } from '../messages/file-operation-evidence.js';

/** Coalesce visible text only. Lifecycle/ACK frames are never delayed. There
 * is at most one pending flush, no history polling, and full text is cloned
 * at most once per flush rather than once per tiny native delta. */
export class ClaudeStreamDelivery {
  private readonly text = new ClaudeTextStreams();
  private readonly files = new FileOperationEvidence('claude-code');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail = Promise.resolve();
  private failed = false;
  private closed = false;
  private metricSequence = 0;
  private readonly metrics = new ClaudeReconciledMetrics();

  constructor(private readonly sessionId: string, private readonly emit: (event: ClaudeWorkerReply) => Promise<void>,
    private readonly onFailure: () => void, private readonly intervalMs = 50) {}

  private enqueue(action: () => Promise<void>) {
    const task = this.tail.then(async () => {
      if (this.failed) throw new Error('Claude stream delivery failed');
      await action();
    });
    this.tail = task.catch(() => { this.failed = true; try { this.onFailure(); } catch { /* retain failure */ } });
    return task;
  }

  private async flushText() {
    clearTimeout(this.timer); this.timer = undefined;
    for (const snapshot of this.text.drain()) {
      // Adjacent frames bind the bounded payload to its native parent. The
      // serialized writer prevents a timer from splitting final projections.
      await this.emit({ kind: 'event', event: { type: 'stream_event', session_id: this.sessionId,
        parent_tool_use_id: snapshot.parentToolUseId } });
      await this.emit({ kind: 'stream', snapshot });
    }
  }

  send(event: unknown) {
    if (this.closed) return Promise.reject(new Error('Claude stream delivery closed'));
    return this.enqueue(async () => {
      const frame = claudeLifecycleFrame(event);
      if (frame.session_id !== this.sessionId) throw new Error('Invalid native session');
      const rows = projectClaudeMessage(event, this.sessionId);
      for (const row of rows) {
        if (row.role !== 'tool') continue;
        const scope = [row.parentToolUseId, row.toolCallId!] as const;
        const eventId = JSON.stringify([row.nativeMessageId, row.blockIndex]);
        if (row.toolPhase === 'call') {
          const content = (event as { message: { content: unknown[] } }).message.content;
          const block = content[row.blockIndex] as { input?: unknown };
          this.files.start(scope, eventId, row.toolName!, block.input);
        } else {
          const files = this.files.complete(scope, eventId, row.toolError === false);
          if (files.length) row.sourceFiles = files;
        }
      }
      this.text.accept(event, this.sessionId, false);
      // Final native rows replace already published partial IDs atomically.
      if (frame.type === 'assistant') await this.flushText();
      const stream = this.text.complete(event, this.sessionId);
      await this.emit({ kind: 'event', event: frame });
      if (rows.length) {
        const details = projectClaudeToolDetails(event, this.sessionId);
        await this.emit({ kind: 'projection', rows, ...(stream ? { stream } : {}), ...(details.length ? { details } : {}) });
      }
      const sample = this.metrics.sample(event, this.sessionId, this.metricSequence + 1);
      if (sample) {
        this.metricSequence++;
        await this.emit({ kind: 'metrics', nativeSessionId: this.sessionId, sample });
      }
      if (this.text.hasPending && !this.timer) this.timer = setTimeout(() => {
        void this.enqueue(() => this.flushText()).catch(() => {});
      }, this.intervalMs);
    });
  }

  async finish() {
    this.closed = true;
    clearTimeout(this.timer); this.timer = undefined;
    try { await this.enqueue(() => this.flushText()); }
    finally { this.files.close(); this.metrics.close(); }
  }
}

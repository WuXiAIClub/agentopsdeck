import { randomUUID } from 'node:crypto';
import type { InteractionAnswer } from '@agentopsdeck/shared';
import type { InteractionQuestion } from './interaction-runtime.js';
import { readInteractionFrame, validInteractionQuestion, wireAnswer, type InteractionWorkerFrame } from './interaction-wire.js';

type Pending = { question: InteractionQuestion; claimed: boolean; resolve: (value: InteractionAnswer) => void;
  reject: (error: Error) => void; validate: (answer: InteractionAnswer) => Promise<boolean>; dispose(): void };
const cancelled = () => new Error('Agent interaction unavailable');
/** Private child IPC only. No native SDK object, credential or native request ID
 * crosses the process boundary. Closing synchronously invalidates all awaits. */
export class InteractionWorker {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly executionId: string, private readonly epoch: string,
    private readonly emit: (frame: InteractionWorkerFrame) => Promise<void>, private readonly ttlMs = 10 * 60_000) {
    if (!readInteractionFrame({ kind: 'interaction-ack', executionId, epoch, requestId: 'validate' }, 'worker')
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 30 * 60_000) throw cancelled();
  }
  ask(question: InteractionQuestion, signal?: AbortSignal,
    validate: (answer: InteractionAnswer) => Promise<boolean> = async () => true): Promise<InteractionAnswer> {
    if (this.closed || signal?.aborted || this.pending.size >= 32 || !validInteractionQuestion(question)) return Promise.reject(cancelled());
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(requestId, true);
      const timer = setTimeout(abort, this.ttlMs); timer.unref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(requestId, { question: structuredClone(question), claimed: false, resolve, reject, validate,
        dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
      void this.emit({ kind: 'interaction-request', executionId: this.executionId, epoch: this.epoch, requestId, question })
        .catch(() => this.cancel(requestId, false));
    });
  }
  /** Returns false for a foreign/malformed frame, never answers another run. */
  async receive(value: unknown): Promise<boolean> {
    const frame = readInteractionFrame(value, 'parent');
    if (!frame || frame.executionId !== this.executionId || frame.epoch !== this.epoch) return false;
    const pending = this.pending.get(frame.requestId);
    if (!pending || this.closed) return true;
    if (frame.kind === 'interaction-cancel') { this.cancel(frame.requestId, false); return true; }
    const answer = wireAnswer(pending.question, frame.answer);
    if (!answer) return false;
    if (pending.claimed) return true;
    pending.claimed = true;
    try {
      if (!await pending.validate(answer)) { this.cancel(frame.requestId, true); return true; }
      if (this.closed || this.pending.get(frame.requestId) !== pending) return true;
      // ACK means the original adapter accepted the answer, not tool success.
      await this.emit({ kind: 'interaction-ack', executionId: this.executionId, epoch: this.epoch, requestId: frame.requestId });
      if (this.closed || this.pending.get(frame.requestId) !== pending) return true;
      this.pending.delete(frame.requestId); pending.dispose(); pending.resolve(answer);
    } catch { this.cancel(frame.requestId, true); }
    return true;
  }
  close() {
    this.closed = true;
    for (const id of this.pending.keys()) this.cancel(id, false);
  }
  private cancel(requestId: string, notify: boolean) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId); pending.dispose(); pending.reject(cancelled());
    if (notify) void this.emit({ kind: 'interaction-cancelled', executionId: this.executionId, epoch: this.epoch, requestId }).catch(() => {});
  }
}

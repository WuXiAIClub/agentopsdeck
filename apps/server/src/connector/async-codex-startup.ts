import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { decodeCodexStartupPayload, type CodexStartupPayload } from '../codex/startup-recovery.js';
import type { QueuedTurn } from '../commands/turn-queue.js';
import type { CodexStartupMetadata } from './connector-codex-startup-domain.js';
import type { DeckStore } from '../projection/deck-store.js';
import { codexQueuedTurnMessage } from '../codex/queued-turn-projection.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Options = {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  /** Recover durable executions before opening the original bound view; Deck
   * message mapping may synchronously read that view during publication. */
  projection?: Pick<import('./async-codex-projection.js').AsyncCodexProjection, 'open'>;
  publish(turn: QueuedTurn<CodexStartupPayload>, metadata: CodexStartupMetadata): void | Promise<void>;
  diagnostics?: PerformanceDiagnostics;
};

/** Original frontend message mapping, without a main-thread SQL journal. The
 * original startup gate must remain closed until the whole consumer opens. */
export function codexStartupDeckPublisher(store: Pick<DeckStore, 'getSession' | 'addMessage'>) {
  return (turn: QueuedTurn<CodexStartupPayload>, metadata: CodexStartupMetadata) => {
    store.addMessage(codexQueuedTurnMessage(turn, { version: metadata.version,
      headId: metadata.headId, executionCommandId: metadata.executionCommandId }, store.getSession(turn.sessionKey)));
  };
}

/** Startup-only consumer, under the original application admission gate. No
 * worker/native/queue work may start until open succeeds. DISPLAY facts and
 * imported payloads are not identity evidence or permission to dispatch.
 * Close this physical consumer before releasing the shared Connector owner. */
export class AsyncCodexStartup {
  private opening?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private failed = false;
  private ready = false;
  private records = 0;
  private bytes = 0;
  private closeWork?: Promise<void>;
  constructor(private readonly options: Options) {}
  status() { return Object.freeze({ ready: this.ready, unavailable: this.failed, closing: this.closing,
    records: this.records, bytes: this.bytes }); }
  open(): Promise<void> {
    if (this.closing || this.failed) return Promise.reject(new ConnectorOwnerUnavailable());
    if (this.opening) return this.opening;
    const work = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-startup');
      trace.add('step', 1);
      try {
        const recovery = await this.options.owner.command('codexStartupRecover', {});
        if (!validConnectorOwnerOutput('codexStartupRecover', recovery)) throw new ConnectorOwnerUnavailable();
        await this.options.projection?.open();
        if (this.closing) throw new ConnectorOwnerUnavailable();
        let after = '0';
        for (;;) {
          const result = await this.options.owner.command('codexStartupQueuePage', { after, limit: 64 });
          if (!validConnectorOwnerOutput('codexStartupQueuePage', result)
            || result.some(row => BigInt(row.sequence) <= BigInt(after))) throw new ConnectorOwnerUnavailable();
          const page = JSON.parse(JSON.stringify(result)) as CodexStartupMetadata[];
          if (!page.length) break;
          for (const row of page) {
            this.bytes += row.bytes + Buffer.byteLength(row.sessionKey) + 512;
            if (++this.records > 10_000 || this.bytes > 32 * 1024 * 1024) throw new ConnectorOwnerUnavailable();
            const chunks: Buffer[] = [];
            for (let offset = 0; offset < row.bytes; offset += 65536) {
              const part = await this.options.owner.command('codexStartupQueueChunk', {
                sessionKey: row.sessionKey, id: row.id, version: row.version, offset,
              });
              if (!validConnectorOwnerOutput('codexStartupQueueChunk', part)) throw new ConnectorOwnerUnavailable();
              const chunk = Buffer.from(part, 'base64');
              if (chunk.length !== Math.min(65536, row.bytes - offset)) throw new ConnectorOwnerUnavailable();
              chunks.push(chunk);
            }
            const next = row.sequence;
            await this.options.publish(decodeCodexStartupPayload(row, chunks), row);
            after = next;
          }
        }
        this.ready = !this.closing;
        trace.add('records', this.records); trace.add('sourceBytes', this.bytes); trace.add('settled', 1); trace.finish();
      } catch {
        this.failed = true; this.ready = false;
        trace.add('records', this.records); trace.add('sourceBytes', this.bytes); trace.finish(true);
        throw new ConnectorOwnerUnavailable();
      }
    });
    // Capture physical completion BEFORE exposing work to callers. Public
    // Promise method replacement must not counterfeit shutdown completion.
    this.tail = work.then(() => {}, () => {});
    return this.opening = work;
  }
  close(): Promise<void> {
    this.closing = true; this.ready = false;
    return this.closeWork ??= Promise.resolve().then(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-startup');
      trace.add('step', 6); trace.reportPending({ pending: this.opening ? 1 : 0 });
      await this.tail;
      trace.add('settled', 1); trace.finish(this.failed);
    });
  }
}

import type { ChatMessage } from '@agentopsdeck/shared';
import { randomUUID } from 'node:crypto';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { CONNECTOR_COMMAND_BYTES, ConnectorOwnerUnavailable, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { CODEX_HISTORY_EVIDENCE_LIMIT } from './connector-codex-history-domain.js';
import type { CodexStartupMetadata } from './connector-codex-startup-domain.js';
import { decodeCodexStartupPayload } from '../codex/startup-recovery.js';
import { normalizeTurnContext } from '../codex/turn-context.js';
import type { CodexBatch } from '../codex/queued-batch.js';
import { expandCodexHistory, type CodexHistoryPlan, type CodexHistoryReader } from '../codex/history-plan.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Original history display port. Owns physical reads until completion, serial
 * per shared owner; it cannot grant execution rights or silently use sync SQL. */
export class AsyncCodexHistory implements CodexHistoryReader {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closeWork?: Promise<void>;
  private pendingToken: string | undefined;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  prepare(sessionKey: string, messages: ChatMessage[]): Promise<CodexHistoryPlan> {
    if (this.closing) return Promise.reject(new ConnectorOwnerUnavailable());
    const original = [...messages];
    const work = this.tail.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.closing) throw new ConnectorOwnerUnavailable();
        const plan = await this.read(sessionKey, original);
        if (plan) return plan;
      }
      throw new ConnectorOwnerUnavailable();
    });
    // Capture physical work before exposing the returned Promise.
    this.tail = work.then(() => {}, () => {});
    return work;
  }
  close(): Promise<void> {
    this.closing = true;
    return this.closeWork ??= this.tail.then(() => this.abandonPending());
  }
  private async abandonPending(): Promise<void> {
    const token = this.pendingToken;
    if (!token) return;
    const result = await this.owner.command('codexHistoryFinish', { token, abandon: true });
    if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
    this.pendingToken = undefined;
  }
  private async read(sessionKey: string, messages: ChatMessage[]): Promise<CodexHistoryPlan | undefined> {
    const trace = guardedTrace(this.diagnostics, 'codex-history-read'); trace.add('step', 1);
    let token: string | undefined, failed = true, rows = 0, bytes = 0;
    try {
      await this.abandonPending();
      // Retain the original handle before physical delivery, including an
      // unknown open ACK. Cleanup never retries the open or any business write.
      token = randomUUID(); this.pendingToken = token;
      const opened = await this.owner.command('codexHistoryOpen', { sessionKey, token });
      if (!validConnectorOwnerOutput('codexHistoryOpen', opened) || opened !== token) throw new ConnectorOwnerUnavailable();
      const normalized = [...messages], batches = new Map<string, CodexBatch>();
      const users = messages.map((message, index) => ({ message, index }))
        .filter(({ message }) => message.role === 'user' && message.sessionKey === sessionKey);
      for (let offset = 0; offset < users.length;) {
        const group: typeof users = [];
        let inputBytes = Buffer.byteLength(JSON.stringify({ token, identities: [] }));
        while (offset < users.length && group.length < CODEX_HISTORY_EVIDENCE_LIMIT) {
          const user = users[offset]!;
          const identityBytes = Buffer.byteLength(JSON.stringify({ id: user.message.id, turnId: user.message.turnId ?? null })) + 1;
          if (inputBytes + identityBytes > CONNECTOR_COMMAND_BYTES) break;
          group.push(user); inputBytes += identityBytes; offset++;
        }
        if (!group.length) throw new ConnectorOwnerUnavailable();
        const evidence = await this.owner.command('codexHistoryEvidence', { token,
          identities: group.map(({ message }) => ({ id: message.id, turnId: message.turnId ?? null })) });
        if (!validConnectorOwnerOutput('codexHistoryEvidence', evidence) || evidence.length !== group.length) throw new ConnectorOwnerUnavailable();
        for (const [i, { message, index }] of group.entries()) {
          const e = evidence[i]!;
          normalized[index] = normalizeTurnContext(message, e.proof ?? undefined);
          if (message.turnId && e.batch) {
            const batch = JSON.parse(JSON.stringify(e.batch)) as CodexBatch;
            if (batches.has(message.turnId) && JSON.stringify(batches.get(message.turnId)) !== JSON.stringify(batch)) throw new ConnectorOwnerUnavailable();
            batches.set(message.turnId, batch);
          }
        }
      }
      const expanded = expandCodexHistory(normalized, runId => batches.get(runId));
      const queue: CodexHistoryPlan['queue'] = [];
      let after = 0n;
      for (let offset = 0; ; offset += 64) {
        const result = await this.owner.command('codexHistoryPage', { token, offset });
        if (!validConnectorOwnerOutput('codexHistoryPage', result)) throw new ConnectorOwnerUnavailable();
        const page = JSON.parse(JSON.stringify(result)) as CodexStartupMetadata[];
        if (!page.length) break;
        for (const row of page) {
          if (row.sessionKey !== sessionKey || BigInt(row.sequence) <= after) throw new ConnectorOwnerUnavailable();
          bytes += row.bytes + Buffer.byteLength(JSON.stringify(row));
          if (++rows > 10000 || bytes > 32 * 1024 * 1024) throw new ConnectorOwnerUnavailable();
          const chunks: Buffer[] = [];
          try {
            for (let position = 0; position < row.bytes; position += 65536) {
              const chunk = await this.owner.command('codexHistoryChunk', { token, index: queue.length, offset: position });
              if (!validConnectorOwnerOutput('codexHistoryChunk', chunk)) throw new ConnectorOwnerUnavailable();
              const part = Buffer.from(chunk, 'base64'); chunks.push(part);
              if (part.length !== Math.min(65536, row.bytes - position)) throw new ConnectorOwnerUnavailable();
            }
            queue.push({ entry: decodeCodexStartupPayload(row, chunks), metadata: row });
          } finally { for (const chunk of chunks) chunk.fill(0); }
          after = BigInt(row.sequence);
        }
        // The final short page is complete, including the 10000-row ceiling;
        // do not issue an out-of-range next offset after that bounded page.
        if (page.length < 64) break;
      }
      const current = await this.owner.command('codexHistoryFinish', { token, abandon: false });
      if (typeof current !== 'boolean') throw new ConnectorOwnerUnavailable();
      this.pendingToken = undefined;
      token = undefined;
      if (this.closing) throw new ConnectorOwnerUnavailable();
      if (!current) { trace.add('changed', 1); return; }
      trace.add('settled', 1); failed = false;
      return { messages: expanded, sourceIds: messages.map(message => message.id), queue };
    } finally {
      // No SQL cancellation or owner close before the physical read cleanup.
      // A failed cleanup is observable; never turn it into an empty history.
      try { if (token) await this.abandonPending(); }
      finally { trace.add('records', rows); trace.add('sourceBytes', bytes); trace.finish(failed); }
    }
  }
}

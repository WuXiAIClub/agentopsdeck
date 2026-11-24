import type { ChatMessage } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { HermesHistoryPort } from '../hermes/session-history.js';
import type { HermesHistorySnapshot } from '../hermes/journal.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { connectorHermesHistoryReplyMatches, validConnectorHermesHistoryOutput, validHermesHistoryMessage,
  type ConnectorHermesHistoryCommands, type ConnectorHermesHistoryKind } from './connector-hermes-history-domain.js';

/** Fixed original-owner commands. No native effects, second writer or retries. */
export class AsyncHermesHistory implements HermesHistoryPort {
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>) {}
  private async call<K extends ConnectorHermesHistoryKind>(kind: K, input: ConnectorHermesHistoryCommands[K]['input']) {
    const result = await this.owner.command(kind, input);
    if (!validConnectorHermesHistoryOutput(kind, result) || !connectorHermesHistoryReplyMatches(kind, input, result)) throw new ConnectorOwnerUnavailable();
    return result;
  }
  snapshot(key: string) { return this.call('hermesHistorySnapshot', { key }); }
  attached(snapshot: HermesHistorySnapshot, stored: string) {
    return this.call('hermesHistoryAttach', { key: snapshot.key, digest: snapshot.digest, stored });
  }
  commit(snapshot: HermesHistorySnapshot, rows: Parameters<HermesHistoryPort['commit']>[1]) {
    return this.call('hermesHistoryCommit', { key: snapshot.key, digest: snapshot.digest, rows });
  }
  async projection(snapshot: HermesHistorySnapshot): Promise<ChatMessage[] | null> {
    const messages: ChatMessage[] = []; let offset = 0, bytes = 0;
    // Each page is byte bounded and correlated to the SAME original revision.
    // A changed revision abandons the whole projection, never mixes pages.
    for (let pages = 0; pages < 50_001; pages++) {
      const page = await this.call('hermesHistoryProjection', { key: snapshot.key, digest: snapshot.digest, offset, limit: 64 });
      if (!page) return null;
      bytes += Buffer.byteLength(JSON.stringify(page.messages));
      if (bytes > 64 * 1024 * 1024) throw new ConnectorOwnerUnavailable();
      messages.push(...page.messages);
      if (page.large) {
        bytes += page.large.bytes;
        if (bytes > 64 * 1024 * 1024) throw new ConnectorOwnerUnavailable();
        const chunks: Buffer[] = []; let partOffset = 0;
        while (partOffset < page.large.bytes) {
          const part = await this.call('hermesHistoryMessagePart', { key: snapshot.key, digest: snapshot.digest,
            index: page.large.index, offset: partOffset });
          if (!part) return null;
          if (part.total !== page.large.bytes) throw new ConnectorOwnerUnavailable();
          chunks.push(Buffer.from(part.data, 'base64'));
          partOffset += chunks.at(-1)!.length;
        }
        const message: unknown = JSON.parse(Buffer.concat(chunks, partOffset).toString('utf8'));
        if (!validHermesHistoryMessage(message, snapshot.key)) throw new ConnectorOwnerUnavailable();
        messages.push(message);
      }
      if (page.next === null) {
        const current = await this.snapshot(snapshot.key);
        return current?.digest === snapshot.digest ? messages : null;
      }
      offset = page.next;
    }
    throw new ConnectorOwnerUnavailable();
  }
}

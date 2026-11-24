import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@agentopsdeck/shared';
import type { QueuedTurn } from '../commands/turn-queue.js';
import type { ExecutionGrantAuthority } from '../connector/execution-grants.js';

export type CodexBatch = {
  separator: string;
  members: { id: string; createdAt: number; imageCount: number }[];
};
type Payload = { text: string; images: unknown[]; actorId?: string; executionGrant?: ExecutionGrantAuthority };

/** Protocol safety bounds, not a debounce: take the compatible waiting prefix
 * now. Never skip an older command or combine different execution principals. */
export function waitingBatch<T extends Payload>(entries: QueuedTurn<T>[], authorized: (entry: QueuedTurn<T>) => boolean) {
  const first = entries[0];
  if (!first || first.state !== 'queued') return [];
  const grant = first.payload.executionGrant;
  let bytes = 0;
  const selected: QueuedTurn<T>[] = [];
  for (const entry of entries) {
    const authority = entry.payload.executionGrant;
    if (entry.state !== 'queued' || entry.payload.actorId !== first.payload.actorId
      || authority?.id !== grant?.id || authority?.actorId !== grant?.actorId || authority?.issuerTokenId !== grant?.issuerTokenId
      || !authorized(entry)) break;
    const size = Buffer.byteLength(JSON.stringify(entry.payload));
    if (selected.length && (selected.length >= 16 || bytes + size > 1024 * 1024
      // Leave execution-fact space for native identity, early lifecycle
      // observations and outstanding tool evidence (the fact is capped at 8KiB).
      || Buffer.byteLength(JSON.stringify({ sessionKey: first.sessionKey, members: selected.concat(entry)
        .map(item => ({ id: item.id, createdAt: item.createdAt, imageCount: item.payload.images.length })) })) > 3500)) break;
    selected.push(entry); bytes += size;
  }
  return selected;
}

export function describeBatch<T extends Payload>(entries: QueuedTurn<T>[]): CodexBatch | undefined {
  if (entries.length < 2) return;
  let separator: string;
  do { separator = `\n\n[Queued message boundary ${randomUUID()}]\n\n`; }
  while (entries.some(entry => entry.payload.text.includes(separator)));
  return { separator, members: entries.map(entry => ({ id: entry.id, createdAt: entry.createdAt, imageCount: entry.payload.images.length })) };
}

/** Only durable ACK-bound metadata may split a native user item. No message
 * body, local attachment path or authority is copied into the metadata table. */
export function expandBatchMessage(message: ChatMessage, batch: CodexBatch): ChatMessage[] {
  const texts = message.text.split(batch.separator);
  if (texts.length !== batch.members.length) throw new Error('Native batch history does not match accepted message boundaries');
  if ((message.media?.length ?? 0) !== batch.members.reduce((sum, member) => sum + member.imageCount, 0)) {
    throw new Error('Native batch history does not match accepted attachment boundaries');
  }
  const { media: _media, ...base } = message;
  let imageIndex = 0;
  return batch.members.map((member, i) => {
    const media = message.media?.slice(imageIndex, imageIndex + member.imageCount);
    imageIndex += member.imageCount;
    // Member timestamps record admission, not dispatch. All members belong to
    // the native turn's actual input time (array order preserves batch FIFO).
    return { ...base, id: member.id, text: texts[i]!,
      ...(media?.length ? { media } : {}) };
  });
}

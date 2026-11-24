import { isRecord, type QueuedTurn, type TurnQueue, type TurnQueueMetadata } from '../commands/turn-queue.js';
import type { CodexExecutions } from './executions.js';
import type { CodexImageAttachment } from './app-server.js';

export type CodexStartupPayload = { text: string; images: CodexImageAttachment[] };
type Owner = { turns: TurnQueue; codexExecutions: CodexExecutions };

/** Same decoder and original import marker as the original constructor. No
 * credential inference or dispatch authority is created by startup recovery. */
export function decodeCodexLegacyTurn(sessionKey: string, entry: unknown): QueuedTurn<CodexStartupPayload> {
  if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.text !== 'string'
    || typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt) || !Array.isArray(entry.images)
    || entry.images.some(image => !isRecord(image) || typeof image.filePath !== 'string' || !isRecord(image.media))
    || entry.dispatchState !== undefined && !['dispatching', 'failed'].includes(String(entry.dispatchState))) {
    throw Error('Invalid legacy Codex queue entry');
  }
  return { id: entry.id, sessionKey, createdAt: entry.createdAt, state: entry.dispatchState ? 'outcome_unknown' : 'queued',
    payload: { text: entry.text, images: entry.images as CodexImageAttachment[] } };
}

export function recoverCodexStartup(owner: Owner, queueFile?: string) {
  // Execution recovery owns its transaction. Do not nest it in import's
  // transaction, or advertise a cross-transaction atomic startup guarantee.
  owner.codexExecutions.recoverInterrupted();
  owner.turns.importLegacy('codex', queueFile, decodeCodexLegacyTurn);
  owner.turns.recoverInterrupted('codex');
}

export function decodeCodexStartupPayload(metadata: TurnQueueMetadata, chunks: Uint8Array[]): QueuedTurn<CodexStartupPayload> {
  const body = Buffer.concat(chunks);
  if (body.length !== metadata.bytes) throw Error('connector_storage_unavailable');
  // Reject malformed UTF-8 rather than silently replacing durable user text.
  const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  if (!isRecord(payload) || typeof payload.text !== 'string' || !Array.isArray(payload.images)
    || payload.images.some(image => !isRecord(image) || typeof image.filePath !== 'string' || !isRecord(image.media))) {
    throw Error('connector_storage_unavailable');
  }
  return { id: metadata.id, sessionKey: metadata.sessionKey, createdAt: metadata.createdAt,
    state: metadata.state, payload: payload as CodexStartupPayload };
}

export function* readCodexStartupQueue(turns: TurnQueue): Generator<QueuedTurn<CodexStartupPayload>> {
  let after = '0', records = 0, total = 0;
  for (;;) {
    const page = turns.bootstrapPage('codex', after);
    if (!page.length) return;
    for (const row of page) {
      total += row.bytes + Buffer.byteLength(row.sessionKey) + 512;
      if (++records > 10_000 || total > 32 * 1024 * 1024) throw Error('connector_storage_unavailable');
      yield decodeCodexStartupPayload(row, [turns.bootstrapBody('codex', row.sessionKey, row.id, row.version)]);
      after = row.sequence;
    }
  }
}

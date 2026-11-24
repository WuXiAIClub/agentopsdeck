import type { CommandReceipt, SendDeliveryMode, SendMessageResponse, SendMessageUpload } from '@agentopsdeck/shared';
import { messageReceiptResponse } from './command-recovery.js';

export type RetryPayload = { scope: string; sessionKey: string; key: string; text: string; mode: SendDeliveryMode; media: SendMessageUpload[]; expectedRunId?: string };
/** No message bodies in the persistent receipt journal. Bounded tab-lifetime memory only. */
export class MessageRetryCache {
  private rows = new Map<string, RetryPayload>();
  constructor(private readonly maxEntries = 16, private readonly maxBytes = 16 * 1024 * 1024) {}
  private id(scope: string, session: string, key: string) { return JSON.stringify([scope, session, key]); }
  get(scope: string, session: string, key: string) { return this.rows.get(this.id(scope, session, key)); }
  remove(scope: string, session: string, key: string) { this.rows.delete(this.id(scope, session, key)); }
  clear() { this.rows.clear(); }
  put(row: RetryPayload) {
    const size = (item: RetryPayload) => 2 * (item.text.length + item.media.reduce((sum, media) => sum + media.dataUrl.length, 0));
    if (size(row) > this.maxBytes) return;
    this.rows.set(this.id(row.scope, row.sessionKey, row.key), row);
    while (this.rows.size > this.maxEntries || [...this.rows.values()].reduce((sum, item) => sum + size(item), 0) > this.maxBytes) this.rows.delete(this.rows.keys().next().value!);
  }
}

/** Read before any human-authorized replay. Never interpret missing/unreachable as rejection. */
export async function inspectMessageRetry(key: string, query: () => Promise<CommandReceipt>): Promise<SendMessageResponse | undefined> {
  let receipt: CommandReceipt;
  try { receipt = await query(); } catch { return undefined; }
  if (receipt.key !== key) throw new Error('Receipt identity mismatch');
  return messageReceiptResponse({ key }, receipt);
}

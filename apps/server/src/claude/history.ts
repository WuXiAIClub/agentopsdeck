import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import { claudeChatMessages, claudeMessageAnchor } from './session-view.js';
import { CLAUDE_TRANSCRIPT_PAGE_BYTES } from './transcript-store.js';

type Source = Pick<ConnectorUserStore, 'claudeJournal' | 'claudeTranscript'> & Partial<Pick<ConnectorUserStore, 'sdkAttachments'>>;

/** One bounded snapshot for HTTP and SSE. Queued inputs stay below native
 * history, then retain their identity at actual dispatch time. No SDK IO. */
export function claudeHistoryPage(source: Source, key: string, limit = 200, before?: string) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid Claude history limit');
  const { claudeTranscript: transcript, claudeJournal: journal } = source;
  if (!journal.session(key)) return;
  const anchor = before === undefined ? undefined : claudeMessageAnchor(key, before) ?? transcript.admissionAnchor(key, before) ?? transcript.displayAnchor(key, before);
  const live = transcript.liveMessages(key), liveIndex = before === undefined ? -1 : live.findIndex(row => row.id === before);
  const pending = transcript.pendingPage(key, anchor || liveIndex >= 0 ? 0 : limit, !journal.canStart(key), anchor || liveIndex >= 0 ? undefined : before);
  if (!pending) return;
  const pendingRows = anchor || liveIndex >= 0 ? [] : pending.messages;
  const olderLive = anchor ? [] : liveIndex >= 0 ? live.slice(0, liveIndex) : live;
  const includeLive = liveIndex >= 0 || pending.hiddenCount === 0;
  const liveSlots = includeLive ? limit - pendingRows.length : 0;
  const liveRows = liveSlots > 0 ? olderLive.slice(-liveSlots) : [];
  const nativeSlots = limit - pendingRows.length - liveRows.length;
  const native = transcript.pageBlocks(key, Math.max(1, nativeSlots), anchor);
  if (!native) return;
  const includeNative = !!anchor || includeLive && liveRows.length === olderLive.length && nativeSlots > 0;
  const messages = [...(includeNative ? claudeChatMessages(key, native.messages) : []), ...liveRows, ...pendingRows]
    .map(row => source.sdkAttachments?.project(row) ?? row);
  let hiddenCount = includeNative ? native.hiddenCount : native.totalCount + olderLive.length - liveRows.length
    + (liveIndex >= 0 ? 0 : pending.hiddenCount);
  // Enforce the budget on the actual wire rows, including IDs/queue metadata.
  // A summary budget alone misses envelope overhead and combined queue text.
  let bytes = 2 + messages.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
  while (messages.length > 1 && bytes > CLAUDE_TRANSCRIPT_PAGE_BYTES) {
    bytes -= Buffer.byteLength(JSON.stringify(messages.shift()!)) + 1; hiddenCount++;
  }
  return { messages, totalCount: native.totalCount + live.length + pending.totalCount, hiddenCount };
}

export function claudeHistoryMessage(source: Source, key: string, id: string) {
  if (!source.claudeJournal.session(key)) return;
  const anchor = claudeMessageAnchor(key, id) ?? source.claudeTranscript.admissionAnchor(key, id) ?? source.claudeTranscript.displayAnchor(key, id);
  if (!anchor) return;
  const message = source.claudeTranscript.message(key, anchor);
  const result = message ? claudeChatMessages(key, [message])[0] : undefined;
  if (!result || result.role !== 'tool') return result ? source.sdkAttachments?.project(result) ?? result : undefined;
  const detail = source.claudeTranscript.toolDetail(key, anchor);
  return detail ? { ...result, text: detail.text, contentTruncated: detail.truncated } : result;
}

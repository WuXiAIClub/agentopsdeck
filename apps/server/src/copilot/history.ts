import type { ConnectorUserStore } from '../connector/connector-user-store.js';
import { COPILOT_TRANSCRIPT_PAGE_BYTES } from './transcript-store.js';

type Source = Pick<ConnectorUserStore, 'copilotJournal' | 'copilotTranscript'> & Partial<Pick<ConnectorUserStore, 'sdkAttachments'>>;
type AntigravitySource = Pick<ConnectorUserStore, 'antigravityJournal' | 'antigravityTranscript'> & Partial<Pick<ConnectorUserStore, 'sdkAttachments'>>;
/** Authorized callers only. A single bounded view of durable, live and queued
 * rows; queue echoes retain public IDs, pending inputs stay at the bottom. */
export function copilotHistoryPage(source: Source, key: string, limit = 200, before?: string) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid Copilot history limit');
  const { copilotTranscript: transcript, copilotJournal: journal } = source;
  if (!journal.session(key)) return;
  const nativeAnchor = before !== undefined && !!transcript.message(key, before);
  const live = transcript.liveMessages(key), liveIndex = before === undefined ? -1 : live.findIndex(row => row.id === before);
  const anchored = nativeAnchor || liveIndex >= 0;
  const pending = transcript.pendingPage(key, anchored ? 0 : limit, !journal.canStart(key), anchored ? undefined : before);
  if (!pending) return;
  const pendingRows = anchored ? [] : pending.messages;
  const olderLive = nativeAnchor ? [] : liveIndex >= 0 ? live.slice(0, liveIndex) : live;
  const includeLive = liveIndex >= 0 || pending.hiddenCount === 0;
  const liveSlots = includeLive ? limit - pendingRows.length : 0;
  const liveRows = liveSlots > 0 ? olderLive.slice(-liveSlots) : [];
  const nativeSlots = limit - pendingRows.length - liveRows.length;
  const native = transcript.page(key, Math.max(1, nativeSlots), nativeAnchor ? before : undefined);
  if (!native) return;
  const includeNative = nativeAnchor || includeLive && liveRows.length === olderLive.length && nativeSlots > 0;
  const messages = [...(includeNative ? native.messages : []), ...liveRows, ...pendingRows]
    .map(row => source.sdkAttachments?.project(row) ?? row);
  let hiddenCount = includeNative ? native.hiddenCount : native.totalCount + olderLive.length - liveRows.length
    + (liveIndex >= 0 ? 0 : pending.hiddenCount);
  let bytes = 2 + messages.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
  while (messages.length > 1 && bytes > COPILOT_TRANSCRIPT_PAGE_BYTES) {
    bytes -= Buffer.byteLength(JSON.stringify(messages.shift()!)) + 1; hiddenCount++;
  }
  return { messages, totalCount: native.totalCount + live.length + pending.totalCount, hiddenCount };
}

export function copilotHistoryMessage(source: Source, key: string, id: string) {
  if (!source.copilotJournal.session(key)) return;
  const message = source.copilotTranscript.message(key, id);
  if (message?.role !== 'tool') return message ? source.sdkAttachments?.project(message) ?? message : undefined;
  const detail = source.copilotTranscript.toolDetail(key, id);
  return detail ? { ...message, text: detail.text, contentTruncated: detail.truncated } : message;
}

export function antigravityHistoryPage(source: AntigravitySource, key: string, limit = 200, before?: string) {
  return copilotHistoryPage({ copilotJournal: source.antigravityJournal, copilotTranscript: source.antigravityTranscript,
    ...(source.sdkAttachments ? { sdkAttachments: source.sdkAttachments } : {}) }, key, limit, before);
}

export function antigravityHistoryMessage(source: AntigravitySource, key: string, id: string) {
  return copilotHistoryMessage({ copilotJournal: source.antigravityJournal, copilotTranscript: source.antigravityTranscript,
    ...(source.sdkAttachments ? { sdkAttachments: source.sdkAttachments } : {}) }, key, id);
}

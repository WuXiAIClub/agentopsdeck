import React, { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
const LazyResendMessage = lazy(() => import('./ResendMessage').then(module => ({ default: module.ResendMessage })));
const ResendMessage = (props: React.ComponentProps<typeof LazyResendMessage>) => <Suspense fallback={null}><LazyResendMessage {...props} /></Suspense>;
import { createPortal } from 'react-dom';
import { Copy, X, Check, ImageOff, Terminal, Cpu, FileCode2, Image as ImageIcon, GitBranch, Globe, Server, Bot, MessageSquareShare, Wrench } from 'lucide-react';
import { MessageFocusIcon } from './ui/message-focus-icon';
import type { Components } from 'react-markdown';
const LazyMessageRichMarkdown = lazy(() => import('./MessageRichMarkdown'));
import type { ChatMessage } from '@agentopsdeck/shared';
import { formatTokenValue } from '../lib/session-utils';
import { formatMessageTimestamp } from '../lib/message-time';
import { Badge } from './ui/badge';
import { cn } from '../lib/cn';
import { api, apiUrl, downloadMediaUrl, mediaUrl } from '../api';
const LazyMessageVideoPreview = lazy(() => import('./MessageVideoPreview').then(module => ({ default: module.MessageVideoPreview })));
const MessageVideoPreview = (props: React.ComponentProps<typeof LazyMessageVideoPreview>) => <Suspense fallback={null}><LazyMessageVideoPreview {...props} /></Suspense>;
import { isVideoAttachment } from '../lib/message-video';
import { sourceLink } from '../lib/source-preview';
import { SourceReferencePreview } from './SourceReferencePreview';
import { LongTextReference } from './LongTextReference';
import { MessageDelivery, QueueMessageBody } from './MessageDelivery';
import { RenderRecoveryBoundary } from './RenderRecoveryBoundary';
import { compactToolEntryCount, groupedToolElapsedMs, isToolExecuting, toolVariantFromLabel, type ToolOutputVariant } from '../lib/tool-timeline';
import { parseToolDetail } from '../lib/tool-detail-format';
import { ToolDetailBody, translateToolStatusLabel } from './ToolDetailBody';
import { createMessageItemProjector } from '../lib/incremental-message-items';
import { createIdleToolDetailCache } from '../lib/idle-tool-detail-cache';
import { memoizeMessageClassification } from '../lib/message-classification-cache';
import { isPlainTextMarkdown } from '../lib/markdown-fast-path';
import { assistantDisplayText, hasInvalidAssistantOutput, INVALID_ASSISTANT_OUTPUT_TEXT } from '../lib/assistant-output';

export const ToolDetailCacheContext = React.createContext<ReturnType<typeof createIdleToolDetailCache> | null>(null);

export type DesktopMessageRenderItem =
  | { kind: 'message'; message: ChatMessage; index: number; attachedTools?: ChatMessage[] }
  | { kind: 'toolGroup'; messages: ChatMessage[]; startIndex: number; endIndex: number };

// Keep tool/internal output out of the chat-window budget; otherwise long tool runs hide real conversation context.
export const MESSAGE_WINDOW_CHAT_LIMIT = 200;

export function visibleMessages(messages: ChatMessage[], limit = MESSAGE_WINDOW_CHAT_LIMIT) {
  let chatMessagesSeen = 0;
  let startIndex = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (countsTowardMessageWindow(messages[index])) {
      chatMessagesSeen += 1;
      if (chatMessagesSeen > limit) {
        startIndex = index + 1;
        break;
      }
    }
  }
  return messages.slice(startIndex);
}

export function hiddenMessageCount(allMessages: ChatMessage[], visible: ChatMessage[]) {
  return Math.max(0, countWindowMessages(allMessages) - countWindowMessages(visible));
}

export function countWindowMessages(messages: ChatMessage[]) {
  let count = 0;
  for (const message of messages) if (countsTowardMessageWindow(message)) count++;
  return count;
}

function countsTowardMessageWindow(message: ChatMessage | undefined) {
  return !!message && classifyMessageForDisplay(message) === 'chat';
}

// Reuse the same classification across count/window/grouping passes. Preserve
// the original grouping predicates; this does not cache rendering or content.
const classifyMessageForDisplay = memoizeMessageClassification(message => {
  const text = displayMessageText(readableText(assistantDisplayText(message)));
  if (isToolOutputPlaceholder(text) || isHiddenAssistantNoise(message)) return 'hidden';
  return isInternalOutput(message) ? 'tool' : 'chat';
});

export function desktopMessageItems(messages: ChatMessage[]): DesktopMessageRenderItem[] {
  const items: DesktopMessageRenderItem[] = [];
  let leadingTools: ChatMessage[] = [];
  let pendingTools: ChatMessage[] = [];
  let pendingStart = -1;

  function attachTools(tools: ChatMessage[]) {
    if (!tools.length) return;
    leadingTools = [...leadingTools, ...tools];
  }

  messages.forEach((message, index) => {
    const kind = classifyMessageForDisplay(message);
    if (kind === 'hidden') return;
    if (kind === 'tool') {
      if (pendingStart < 0) pendingStart = index;
      pendingTools.push(message);
      return;
    }
    attachTools(pendingTools);
    pendingTools = [];
    pendingStart = -1;
    const item: DesktopMessageRenderItem = { kind: 'message', message, index };
    if (leadingTools.length) {
      item.attachedTools = leadingTools;
      leadingTools = [];
    }
    items.push(item);
  });

  attachTools(pendingTools);
  if (leadingTools.length) items.push({ kind: 'toolGroup', messages: leadingTools, startIndex: pendingStart < 0 ? 0 : pendingStart, endIndex: messages.length - 1 });
  return items;
}

export function createDesktopMessageProjector() {
  return createMessageItemProjector<ChatMessage>(classifyMessageForDisplay);
}

// Desktop attaches internal tool output to nearby chat messages so execution records do not look like reordered chat bubbles.
export const DesktopMessageWithTools = React.memo(function DesktopMessageWithTools({ message, attachedTools, isRecent, onMediaLoad }: { message: ChatMessage; attachedTools: ChatMessage[] | undefined; isRecent: boolean; onMediaLoad: (() => void) | undefined }) {
  return <div className="desktop-message-with-tools">
    {attachedTools?.length ? <DesktopToolTimeline messages={attachedTools} attached /> : null}
    <DesktopMessageBubble message={message} isRecent={isRecent} onMediaLoad={onMediaLoad} />
  </div>;
});

export const DesktopToolTimeline = React.memo(function DesktopToolTimeline({ messages, attached = false }: { messages: ChatMessage[]; attached?: boolean }) {
  return <RenderRecoveryBoundary scope="tools"><DesktopToolTimelineContent key={messages[0]?.sessionKey} messages={messages} attached={attached} /></RenderRecoveryBoundary>;
});

function DesktopToolTimelineContent({ messages, attached }: { messages: ChatMessage[]; attached: boolean }) {
  const detailId = useId();
  const { t: tr } = useI18n();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, { text?: string; loading?: boolean; error?: string }>>({});
  const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null);
  const [rawViewEntryId, setRawViewEntryId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousOpenKey = useRef<string | null>(null);
  const pendingDetails = useRef(new Map<string, AbortController>());
  const sharedDetailCache = React.useContext(ToolDetailCacheContext);
  const localDetailCache = useMemo(() => createIdleToolDetailCache(), []);
  const detailCache = sharedDetailCache ?? localDetailCache;
  const activeDetailId = useRef<string | null>(null);
  useEffect(() => () => {
    for (const controller of pendingDetails.current.values()) controller.abort();
    pendingDetails.current.clear();
  }, []);
  const { entries, liveNow } = useToolTimelineEntries(messages);
  const openEntry = openKey === null ? undefined : entries.find((entry) => entry.stableKey === openKey);
  const openDetail = openEntry ? details[openEntry.id] : undefined;
  const compactEntryCount = compactToolEntryCount(entries.length);
  const openEntryText = openEntry ? (openDetail?.text ?? openEntry.preview) : '';

  // Focus the committed panel/chip synchronously. Deferred animation callbacks
  // from rapid close/reopen interactions must not steal focus from a newer action.
  useLayoutEffect(() => {
    const previous = previousOpenKey.current;
    previousOpenKey.current = openKey;
    if (openKey !== null) detailRef.current?.focus({ preventScroll: true });
    else if (previous !== null) chipRefs.current.get(previous)?.focus({ preventScroll: true });
  }, [openKey]);

  useEffect(() => {
    if (!copiedEntryId) return;
    const timer = window.setTimeout(() => setCopiedEntryId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copiedEntryId]);

  function closeDetail() {
    retainClosedDetail();
    activeDetailId.current = null;
    for (const controller of pendingDetails.current.values()) controller.abort();
    pendingDetails.current.clear();
    setDetails({});
    setRawViewEntryId(null);
    setOpenKey(null);
  }

  function retainClosedDetail() {
    if (openEntry && openDetail?.text !== undefined) detailCache.put(JSON.stringify([openEntry.sessionKey, openEntry.id]), openDetail.text);
  }

  async function copyEntry(entry: (typeof entries)[number], text: string) {
    try {
      await writeClipboardText(text);
      setCopiedEntryId(entry.id);
    } catch {
      setCopiedEntryId(null);
    }
  }

  async function toggleEntry(index: number) {
    const entry = entries[index];
    if (!entry) return;
    if (openKey === entry.stableKey) {
      closeDetail();
      return;
    }
    retainClosedDetail();
    for (const controller of pendingDetails.current.values()) controller.abort();
    pendingDetails.current.clear();
    activeDetailId.current = entry.id;
    const cached = detailCache.take(JSON.stringify([entry.sessionKey, entry.id]));
    setRawViewEntryId(null);
    setDetails(cached === undefined ? {} : { [entry.id]: { text: cached } });
    setOpenKey(entry.stableKey);
    if (!entry.detailAvailable || cached !== undefined) return;
    const controller = new AbortController();
    pendingDetails.current.set(entry.id, controller);
    setDetails((current) => ({ ...current, [entry.id]: { loading: true } }));
    try {
      const resultMsg = messages.find((m) => m.id === entry.id && m.sessionKey === entry.sessionKey);
      const pairedCallMsg = resultMsg?.toolCallId && resultMsg.toolPhase !== 'call'
        ? messages.find((m) => m.sessionKey === entry.sessionKey && m.toolCallId === resultMsg.toolCallId && m.toolPhase === 'call' && m.id !== entry.id)
        : undefined;
      const [result, pairedCallResult] = await Promise.all([
        api.sessionMessageDetail(entry.sessionKey, entry.id, controller.signal),
        pairedCallMsg?.toolDetailAvailable
          ? api.sessionMessageDetail(entry.sessionKey, pairedCallMsg.id, controller.signal)
          : Promise.resolve(undefined),
      ]);
      if (controller.signal.aborted || activeDetailId.current !== entry.id) return;
      const text = result.message.text;
      // An empty string is an actual result, not a missing cache entry or a
      // reason to restore the preview. Preserve string whitespace for copying.
      const resolvedPrimary = displayMessageText(typeof text === 'string' ? text : readableText(text));
      let combinedText = resolvedPrimary;
      if (pairedCallResult) {
        const callRaw = pairedCallResult.message.text;
        const resolvedCall = displayMessageText(typeof callRaw === 'string' ? callRaw : readableText(callRaw));
        combinedText = [resolvedCall, resolvedPrimary].filter(Boolean).join('\n\n');
      } else if (pairedCallMsg) {
        const callPreviewText = displayMessageText(readableText(pairedCallMsg.toolPreview ?? pairedCallMsg.text));
        if (callPreviewText) {
          combinedText = resolvedPrimary ? `${callPreviewText}\n\n${resolvedPrimary}` : callPreviewText;
        }
      }
      setDetails({ [entry.id]: { text: combinedText } });
    } catch (error) {
      if (controller.signal.aborted || activeDetailId.current !== entry.id) return;
      setDetails({ [entry.id]: { error: error instanceof Error ? error.message : String(error) } });
    } finally {
      if (pendingDetails.current.get(entry.id) === controller) pendingDetails.current.delete(entry.id);
    }
  }

  function renderToolDetail(entry: (typeof entries)[number], text: string, detail: { text?: string; loading?: boolean; error?: string } | undefined) {
    const parsed = parseToolDetail(text);
    const isStructured = parsed.kind === 'structured';
    const isRawMode = rawViewEntryId === entry.id;
    const isCopied = copiedEntryId === entry.id;
    const statusBadge = isStructured ? parsed.status : undefined;
    const durationChip = (isStructured && parsed.durationLabel) ? parsed.durationLabel : entry.elapsedLabel;
    const exitCode = isStructured ? parsed.exitCode : undefined;
    const showHint = entry.hint && (!statusBadge || entry.hint.includes('executing'));

    return <div
      id={`${detailId}-${entry.id}`}
      ref={detailRef}
      className={cn('desktop-tool-detail', `desktop-tool-detail--${entry.variant}`, isStructured && !isRawMode && 'is-structured')}
      role="region"
      tabIndex={-1}
      aria-label={tr('{label} result detail', { label: entry.label })}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeDetail();
        }
      }}
    >
      <div className="desktop-tool-detail-header">
        <div className="desktop-tool-detail-title-group">
          <span className="desktop-tool-detail-icon" aria-hidden="true">{renderToolVariantIcon(entry.variant)}</span>
          <span className="desktop-tool-detail-name">{entry.label}</span>
          {statusBadge ? (
            <span className={cn('tool-detail-status-pill', `is-${statusBadge.tone}`)}>
              <span className="tool-detail-status-dot" aria-hidden="true" />
              {translateToolStatusLabel(statusBadge.label, tr)}
            </span>
          ) : null}
          {showHint ? <span className="desktop-tool-detail-meta-pill is-hint">{entry.hint}</span> : null}
          {exitCode !== undefined ? (
            <span className={cn('desktop-tool-detail-meta-pill is-mono', exitCode !== 0 && 'is-error')}>
              #{exitCode}
            </span>
          ) : null}
          {durationChip ? <span className="desktop-tool-detail-meta-pill is-mono">{durationChip}</span> : null}
          {entry.tokenLabel ? <strong className="desktop-tool-detail-token">{entry.tokenLabel}</strong> : null}
        </div>
        <div className="desktop-tool-detail-actions">
          {isStructured ? (
            <button
              type="button"
              className={cn('desktop-tool-detail-btn', isRawMode && 'is-toggled')}
              onClick={() => setRawViewEntryId(isRawMode ? null : entry.id)}
              aria-label={tr(isRawMode ? 'Switch to formatted view' : 'Switch to raw view')}
              title={tr(isRawMode ? 'Switch to formatted view' : 'Switch to raw view')}
            >
              {tr(isRawMode ? 'Formatted' : 'Raw')}
            </button>
          ) : null}
          <button
            type="button"
            className={cn('desktop-tool-detail-btn', isCopied && 'is-copied')}
            onClick={() => void copyEntry(entry, text)}
            aria-label={tr('Copy {label} result', { label: entry.label })}
          >
            {isCopied ? <Check className="h-3 w-3 shrink-0" aria-hidden="true" /> : <Copy className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span>{tr(isCopied ? 'Copied' : 'Copy')}</span>
          </button>
          <button
            type="button"
            className="desktop-tool-detail-btn desktop-tool-detail-btn--close"
            onClick={closeDetail}
            aria-label={tr("Close tool result detail")}
            title={tr("Close")}
          >
            <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="desktop-tool-detail-close-text">{tr("Close")}</span>
          </button>
        </div>
      </div>
      {detail?.loading ? <p className="desktop-tool-detail-notice">{tr("Loading tool detail…")}</p> : null}
      {detail?.error ? <p className="desktop-tool-detail-notice is-error">{detail.error}</p> : null}
      {isStructured && !isRawMode ? <ToolDetailBody parsed={parsed} /> : <pre className="desktop-tool-detail-raw">{text}</pre>}
    </div>;
  }

  if (!entries.length) return null;

  return <div className={cn('desktop-tool-timeline desktop-tool-track', attached && 'desktop-attached-tools')} data-history-tool-layout={openKey === null && liveNow === undefined ? 'stable' : 'active'} role="list" aria-label={tr("Tool execution sequence")} aria-description={tr('{count} tools', { count: entries.length })}>
      {entries.map((entry, index) => {
        const isCompactOlderEntry = index < compactEntryCount;
        const isOpen = openKey === entry.stableKey;
        const detail = details[entry.id];
        const entryText = detail?.text ?? entry.preview;
        return <React.Fragment key={entry.id}>
          <span className="desktop-tool-node" role="listitem">
            <button
              type="button"
              className={cn('desktop-tool-chip', `desktop-tool-chip--${entry.variant}`, isCompactOlderEntry && 'desktop-tool-chip--compact', isOpen && 'is-active')}
              ref={(node) => {
                if (node) chipRefs.current.set(entry.stableKey, node);
                else chipRefs.current.delete(entry.stableKey);
              }}
              onClick={() => void toggleEntry(index)}
              aria-expanded={isOpen}
              aria-controls={`${detailId}-${entry.id}`}
              aria-label={tr('{label} {phase} {index} of {total}. Click to inspect.', { label: entry.label, phase: entry.phaseLabel, index: index + 1, total: entries.length })}
              title={entry.tokenLabel ? tr('{label} {phase} #{index} · {tokens} context delta estimate · click to inspect', { label: entry.label, phase: entry.phaseLabel, index: index + 1, tokens: entry.tokenLabel }) : tr('{label} {phase} #{index} · click to inspect', { label: entry.label, phase: entry.phaseLabel, index: index + 1 })}
            >
              <span className="desktop-tool-step" aria-hidden="true">{index + 1}</span>
              {!isCompactOlderEntry && <span className="desktop-tool-label">{entry.label}</span>}
              {!isCompactOlderEntry && entry.hint ? <em className="desktop-tool-agent-hint">{entry.hint}</em> : null}
              {!isCompactOlderEntry && entry.tokenLabel ? <strong>{entry.tokenLabel}</strong> : null}
            </button>
            {index < entries.length - 1 ? <span className={cn('desktop-tool-link', `desktop-tool-link--${entry.variant}`, entry.elapsedLabel && 'desktop-tool-link--timed')} aria-label={entry.elapsedLabel ? tr('Next tool after {elapsed}', { elapsed: entry.elapsedLabel }) : undefined} title={entry.elapsedLabel ? tr('Next tool after {elapsed}', { elapsed: entry.elapsedLabel }) : undefined}>
              {entry.elapsedLabel ? <span>{entry.elapsedLabel}</span> : null}
            </span> : null}
          </span>
          {isOpen ? <div className="desktop-tool-detail-row" role="presentation">{renderToolDetail(entry, entryText, detail)}</div> : null}
        </React.Fragment>;
      })}
  </div>;
}

export const MobileToolStrip = React.memo(function MobileToolStrip({ messages, compact = false }: { messages: ChatMessage[]; compact?: boolean }) {
  return <RenderRecoveryBoundary scope="tools"><MobileToolStripContent messages={messages} compact={compact} /></RenderRecoveryBoundary>;
});

function MobileToolStripContent({ messages, compact = false }: { messages: ChatMessage[]; compact?: boolean }) {
  const detailId = useId();
  const { t: tr } = useI18n();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [expandedAll, setExpandedAll] = useState(false);
  const { entries, liveNow } = useToolTimelineEntries(messages);
  useEffect(() => {
    if (entries.length <= 6 && expandedAll) setExpandedAll(false);
  }, [entries.length, expandedAll]);
  const openEntry = entries.find((entry) => entry.stableKey === openKey);
  if (!entries.length) return null;
  const shouldTruncate = !expandedAll && entries.length > 6;
  const openIdx = openKey ? entries.findIndex((entry) => entry.stableKey === openKey) : -1;
  const renderToolPill = (entry: (typeof entries)[number], index: number) => {
    const isOpen = openKey === entry.stableKey;
    const abbreviated = true;
    return <button
      type="button"
      className={cn('mobile-tool-pill', `mobile-tool-pill--${entry.variant}`, abbreviated && 'mobile-tool-pill--abbreviated', isOpen && 'is-active')}
      onClick={() => setOpenKey(isOpen ? null : entry.stableKey)}
      aria-expanded={isOpen}
      aria-controls={`${detailId}-${entry.id}`}
      aria-label={tr('{label} {phase} {index} / {total}', { label: entry.label, phase: entry.phaseLabel, index: index + 1, total: entries.length })}
      role="listitem"
      key={entry.id}
    >
      <span>{index + 1}</span>
      {!abbreviated && <strong>{entry.label}</strong>}
      {!abbreviated && entry.elapsedLabel ? <em>{entry.elapsedLabel}</em> : null}
    </button>;
  };

  return <div className={cn('mobile-tool-strip', compact && 'mobile-tool-strip--compact')} data-history-tool-layout={openKey === null && liveNow === undefined ? 'stable' : 'active'} aria-label={tr('{count} tools', { count: entries.length })}>
    <div className={cn("mobile-tool-strip-scroll", expandedAll && "is-expanded")} role="list" aria-label={tr("Tool execution sequence")}>
      {shouldTruncate ? <>
        {[0, 1, 2].map((idx) => renderToolPill(entries[idx]!, idx))}
        {openIdx >= 3 && openIdx < entries.length - 3 ? renderToolPill(entries[openIdx]!, openIdx) : null}
        <button
          type="button"
          className="mobile-tool-pill-more"
          onClick={() => setExpandedAll(true)}
          aria-label={tr("Expand all tools")}
          title={tr("Expand all tools")}
        >…</button>
        {[entries.length - 3, entries.length - 2, entries.length - 1].map((idx) => renderToolPill(entries[idx]!, idx))}
      </> : entries.map((entry, index) => renderToolPill(entry, index))}
    </div>
    {openEntry ? renderMobileStripDetail(`${detailId}-${openEntry.id}`, openEntry.preview, openEntry.variant) : null}
  </div>;
}

export const MobileMessageBubble = React.memo(function MobileMessageBubble({ message, isRecent, onMediaLoad }: { message: ChatMessage; isRecent: boolean; onMediaLoad: (() => void) | undefined }) {
  return <RenderRecoveryBoundary key={`${message.sessionKey}:${message.id}`} scope="message" plainText={typeof message.text === 'string' ? assistantDisplayText(message) : undefined}>
    <MobileMessageBubbleContent message={message} isRecent={isRecent} onMediaLoad={onMediaLoad} />
  </RenderRecoveryBoundary>;
});

function MobileMessageBubbleContent({ message, isRecent, onMediaLoad }: { message: ChatMessage; isRecent: boolean; onMediaLoad: (() => void) | undefined }) {
  const { t: tr } = useI18n();
  const rawText = readableText(assistantDisplayText(message));
  const text = hasInvalidAssistantOutput(message) ? tr(INVALID_ASSISTANT_OUTPUT_TEXT) : displayMessageText(rawText);
  const failureText = messageFailureText(message, text);
  const displayText = failureText && (!text || text === '(empty)' || isAssistantTurnFailureText(text)) ? failureText : text;
  const hasText = displayText !== '(empty)' && displayText.trim().length > 0;
  if (isToolOutputPlaceholder(text)) return null;
  if (isHiddenAssistantNoise(message)) return null;
  if (isSilentReply(text)) {
    return <div className="mx-auto w-fit rounded-full bg-slate-200/80 px-3 py-1 text-xs font-semibold text-slate-500">{tr("No reply")}</div>;
  }
  if (isInternalOutput(message)) {
    const parsedTool = parseToolDetail(text);
    return <details className="mobile-tool-output">
      <summary>
        <span>{internalOutputLabel(text)}</span>
      </summary>
      {parsedTool.kind === 'structured' ? <div className="mobile-tool-structured-wrap"><ToolDetailBody parsed={parsedTool} compact /></div> : <pre>{text}</pre>}
    </details>;
  }
  if (!hasText && !message.media?.length && !failureText) return null;
  if (false && !isRecent && isLongMessage(text)) {
    return <details className={cn('rounded-[1.35rem] border p-3', message.role === 'user' ? 'ml-10 border-blue-200 bg-blue-600 text-white' : 'mr-10 border-white/70 bg-white/85 text-slate-800 shadow-sm')}>
      <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold">
        <span className="line-clamp-3">{threeLinePreview(text)}</span>
        <strong className="rounded-full bg-current/10 px-2 py-1 text-xs">{tr("more")}</strong>
      </summary>
      <MarkdownText text={text} media={message.media} tone={message.role === 'user' ? 'user' : 'default'} className="mt-3" />
      <MessageMedia media={message.media} onLoad={onMediaLoad} />
    </details>;
  }
  return <article data-message-bubble className={cn('mobile-chat-bubble relative max-w-full break-words rounded-2xl px-2.5 py-1.5 text-[0.9rem] leading-[1.34] shadow-sm', message.role === 'user' ? 'ml-auto bg-blue-600 text-white shadow-blue-600/20' : 'mr-auto border border-slate-200/80 bg-white/95 text-slate-800', failureText && 'ring-2 ring-red-300', message.media?.length && 'space-y-1.5')}>
    <MessageDelivery message={message} placement="header" />
    <QueueMessageBody message={message}>{hasText ? <MarkdownText text={displayText} media={message.media} tone={message.role === 'user' ? 'user' : 'default'} /> : null}</QueueMessageBody>
    <MessageMedia media={message.media} onLoad={onMediaLoad} />
    {failureText && message.role === 'user' ? <p className={cn('mt-2 text-xs font-black', message.role === 'user' ? 'text-red-100' : 'text-red-600')}>{failureText}</p> : null}
    <UnknownDeliveryHint message={message} />
    <MessageDelivery message={message} />
    <footer className="message-footer">
      <MessageReadingActions text={hasText ? displayText : ''} media={message.media} />
      <MessageTimestamp createdAt={message.createdAt} isUser={message.role === 'user'} variant="mobile" />
    </footer>
  </article>;
}

export function MessageBubble({ message, isRecent, onMediaLoad }: { message: ChatMessage; isRecent: boolean; onMediaLoad: (() => void) | undefined }) {
  return <RenderRecoveryBoundary key={`${message.sessionKey}:${message.id}`} scope="message" plainText={typeof message.text === 'string' ? assistantDisplayText(message) : undefined}>
    <MessageBubbleContent message={message} isRecent={isRecent} onMediaLoad={onMediaLoad} />
  </RenderRecoveryBoundary>;
}

function MessageBubbleContent({ message, isRecent, onMediaLoad }: { message: ChatMessage; isRecent: boolean; onMediaLoad: (() => void) | undefined }) {
  const { t: tr } = useI18n();
  const rawText = readableText(assistantDisplayText(message));
  const text = hasInvalidAssistantOutput(message) ? tr(INVALID_ASSISTANT_OUTPUT_TEXT) : displayMessageText(rawText);
  const failureText = messageFailureText(message, text);
  const displayText = failureText && (!text || text === '(empty)' || isAssistantTurnFailureText(text)) ? failureText : text;
  const hasText = displayText !== '(empty)' && displayText.trim().length > 0;
  if (isToolOutputPlaceholder(text)) return null;
  if (isHiddenAssistantNoise(message)) return null;
  if (isSilentReply(text)) {
    return <div className="silent-reply" aria-label={tr("Silent reply")}>{tr("No reply")}</div>;
  }
  if (isInternalOutput(message)) {
    return <details className="message internal-output compact-tool-output">
      <summary>
        <span>{internalOutputLabel(text)}</span>
      </summary>
      <pre>{text}</pre>
    </details>;
  }
  if (!hasText && !message.media?.length && !failureText) return null;
  if (false && !isRecent && isLongMessage(text)) {
    return <details className={`message archived-message ${message.role} ${message.media?.length ? 'with-media' : ''}`}>
      <summary>
        <span>{threeLinePreview(text)}</span>
        <strong>{tr("more")}</strong>
      </summary>
      <MarkdownText text={text} media={message.media} tone={message.role === 'user' ? 'user' : 'default'} />
      <MessageMedia media={message.media} onLoad={onMediaLoad} />
    </details>;
  }
  return <article className={`message ${message.role} ${failureText ? 'failed' : (message.status ?? '')} ${message.media?.length ? 'with-media' : ''}`}>
    <MessageDelivery message={message} placement="header" />
    <QueueMessageBody message={message}>{hasText ? <MarkdownText text={displayText} media={message.media} tone={message.role === 'user' ? 'user' : 'default'} /> : null}</QueueMessageBody>
    <MessageMedia media={message.media} onLoad={onMediaLoad} />
    {failureText && message.role === 'user' ? <p className="message-failure-hint">{failureText}</p> : null}
    <UnknownDeliveryHint message={message} />
    <MessageDelivery message={message} />
    <footer className="message-footer">
      <MessageReadingActions text={hasText ? displayText : ''} media={message.media} />
      <MessageTimestamp createdAt={message.createdAt} isUser={message.role === 'user'} variant="legacy" />
    </footer>
  </article>;
}

const DesktopMessageBubble = React.memo(function DesktopMessageBubble({ message, isRecent, onMediaLoad }: { message: ChatMessage; isRecent: boolean; onMediaLoad: (() => void) | undefined }) {
  return <RenderRecoveryBoundary key={`${message.sessionKey}:${message.id}`} scope="message" plainText={typeof message.text === 'string' ? assistantDisplayText(message) : undefined}>
    <DesktopMessageBubbleContent message={message} isRecent={isRecent} onMediaLoad={onMediaLoad} />
  </RenderRecoveryBoundary>;
});

function DesktopMessageBubbleContent({ message, isRecent, onMediaLoad }: { message: ChatMessage; isRecent: boolean; onMediaLoad: (() => void) | undefined }) {
  const { t: tr } = useI18n();
  const rawText = readableText(assistantDisplayText(message));
  const text = hasInvalidAssistantOutput(message) ? tr(INVALID_ASSISTANT_OUTPUT_TEXT) : displayMessageText(rawText);
  const failureText = messageFailureText(message, text);
  const displayText = failureText && (!text || text === '(empty)' || isAssistantTurnFailureText(text)) ? failureText : text;
  const hasText = displayText !== '(empty)' && displayText.trim().length > 0;
  const isUser = message.role === 'user';
  if (isToolOutputPlaceholder(text)) return null;
  if (isHiddenAssistantNoise(message)) return null;
  if (isSilentReply(text)) {
    return <div className="mx-auto w-fit rounded-full border border-slate-200 bg-white/65 px-3 py-1 text-xs font-bold text-slate-400">{tr("No reply")}</div>;
  }
  if (isInternalOutput(message)) {
    return <details className="w-fit max-w-[calc(100%-0.75rem)] rounded-xl border border-amber-200/80 bg-amber-50/80 px-2.5 py-1.5 text-amber-950 shadow-sm xl:max-w-[72%]">
      <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs font-bold">
        <span className="truncate">{internalOutputLabel(text)}</span>
      </summary>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-white/70 p-2 text-[0.68rem] leading-4 text-amber-950">{text}</pre>
    </details>;
  }
  if (!hasText && !message.media?.length && !failureText) return null;
  if (false && !isRecent && isLongMessage(text)) {
    return <div className={cn('flex items-start', isUser ? 'justify-end' : 'justify-start')}>
      <details className={cn('max-w-[76%] rounded-2xl border px-3 py-1.5 shadow-sm', isUser ? 'border-blue-200 bg-blue-600 text-white shadow-blue-600/20' : 'border-white/80 bg-white/86 text-slate-800')}>
        <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold">
          <span className="line-clamp-2">{threeLinePreview(text)}</span>
          <strong className="rounded-full bg-current/10 px-2 py-0.5 text-[0.68rem]">{tr("more")}</strong>
        </summary>
        <MarkdownText text={text} media={message.media} tone={isUser ? 'user' : 'default'} className="mt-2" />
        <DesktopMessageMedia media={message.media} onLoad={onMediaLoad} />
      </details>
    </div>;
  }
  return <div className={cn('flex min-w-0 items-start', isUser ? 'justify-end' : 'justify-start')}>
    <article data-message-bubble className={cn(
      'min-w-0 max-w-[calc(100%-0.75rem)] overflow-hidden rounded-2xl px-3 py-2 shadow-sm [overflow-wrap:anywhere] xl:max-w-[76%]',
      isUser ? 'bg-blue-600 text-white shadow-blue-600/20' : 'border border-white/80 bg-white/88 text-slate-800 shadow-slate-900/5',
      failureText && 'ring-2 ring-red-300',
      message.media?.length && 'space-y-2',
    )}>
      <MessageDelivery message={message} placement="header" />
      <QueueMessageBody message={message}>{hasText ? <MarkdownText text={displayText} media={message.media} tone={isUser ? 'user' : 'default'} /> : null}</QueueMessageBody>
      <DesktopMessageMedia media={message.media} onLoad={onMediaLoad} />
      {failureText && isUser ? <p className={cn('mt-2 text-xs font-black', isUser ? 'text-red-100' : 'text-red-600')}>{failureText}</p> : null}
      <UnknownDeliveryHint message={message} />
      <MessageDelivery message={message} />
      <footer className="message-footer">
        <MessageReadingActions text={hasText ? displayText : ''} media={message.media} />
        <MessageTimestamp createdAt={message.createdAt} isUser={isUser} variant="desktop" />
      </footer>
    </article>
  </div>;
}

/** A reading snapshot, not a second live session or a second set of queue controls. */
function MessageReadingActions({ text, media }: { text: string; media: ChatMessage['media'] }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<{ text: string; media: ChatMessage['media'] } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => {
    if (!snapshot) return;
    const node = dialog.current;
    node?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      // A notebook remains interactive above the scrim, including its own Escape.
      if (event.key === 'Escape' && node?.contains(document.activeElement)) {
        event.preventDefault(); event.stopPropagation(); setSnapshot(null);
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      const active = document.activeElement;
      if ((!active || active === document.body || node?.contains(active)) && returnFocus.current?.isConnected) {
        returnFocus.current.focus({ preventScroll: true });
      }
    };
  }, [snapshot]);
  async function copy(value: string) {
    try { await writeClipboardText(value); if (mounted.current) setCopyState('copied'); }
    catch { if (mounted.current) setCopyState('failed'); }
    if (mounted.current) { clearTimeout(timer.current); timer.current = setTimeout(() => setCopyState('idle'), 2500); }
  }
  const copyButton = (value: string) => <button type="button" disabled={!value} title={t('Copy message')} aria-label={t('Copy message')} onClick={() => { void copy(value); }}>{copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}</button>;
  return <>
    <div className="message-reading-actions">
      {copyButton(text)}
      <button type="button" title={t('Focus message')} aria-label={t('Focus message')} onClick={event => { returnFocus.current = event.currentTarget; setSnapshot({ text, media }); }}><MessageFocusIcon size={13} /></button>
      <span className="sr-only" role="status">{copyState === 'copied' ? t('Copied') : copyState === 'failed' ? t('Copy failed. Select text to copy manually.') : ''}</span>
    </div>
    {snapshot ? createPortal(<div className="message-focus-scrim" data-message-focus onPointerDown={event => { if (event.target === event.currentTarget) setSnapshot(null); }}>
      <section ref={dialog} role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1} className="message-focus-panel">
        <header><span id={titleId}>{t('Focus message')}</span><div className="message-reading-actions">{copyButton(snapshot.text)}<button type="button" title={t('Close')} aria-label={t('Close')} onClick={() => setSnapshot(null)}><X size={16} /></button></div></header>
        <div className="message-focus-content">
          <MarkdownTextContent text={snapshot.text} media={snapshot.media} />
          <DesktopMessageMedia media={snapshot.media} onLoad={undefined} />
        </div>
        <span className="sr-only" role="status">{copyState === 'copied' ? t('Copied') : copyState === 'failed' ? t('Copy failed. Select text to copy manually.') : ''}</span>
      </section>
    </div>, document.body) : null}
  </>;
}

export function UnknownDeliveryHint({ message }: { message: ChatMessage }) {
  const { t: tr } = useI18n();
  return message.role === 'user' && message.status === 'outcome_unknown'
    ? <div className="mt-2 text-xs font-medium opacity-90" role="status">{tr("Delivery outcome unknown · not resent")}{message.sessionKey && <ResendMessage sessionKey={message.sessionKey} commandKey={message.id} />}</div> : null;
}

export function MessageTimestamp({ createdAt, isUser, variant = 'legacy' }: { createdAt: number; isUser: boolean; variant?: 'legacy' | 'mobile' | 'desktop' }) {
  const label = formatMessageTimestamp(createdAt);
  if (!label) return null;
  const date = new Date(createdAt);
  const title = date.toLocaleString();
  if (variant === 'legacy') {
    return <time className="message-timestamp" dateTime={date.toISOString()} title={title}>{label}</time>;
  }
  return <time
    className={cn(
      'mt-1 block text-right text-[0.62rem] font-semibold leading-none tracking-wide',
      isUser ? 'text-white/60' : 'text-slate-400',
      variant === 'desktop' ? 'select-none' : 'opacity-80',
    )}
    dateTime={date.toISOString()}
    title={title}
  >{label}</time>;
}

function ChatImage({ item, className, onLoad }: { item: NonNullable<ChatMessage['media']>[number]; className?: string; onLoad: (() => void) | undefined }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className="flex min-h-24 items-center justify-center gap-2 p-3" title={item.name}><ImageOff size={20} aria-hidden="true" /><span className="min-w-0 break-all">{item.name}</span></span>
    : <img className={className} src={mediaUrl(item.url)} alt={item.name} loading="lazy" decoding="async" referrerPolicy="no-referrer"
      onLoad={onLoad} onError={() => { setFailed(true); onLoad?.(); }} />;
}

function DesktopMessageMedia({ media: allMedia, onLoad }: { media: ChatMessage['media']; onLoad: (() => void) | undefined }) {
  const media = allMedia?.filter(item => !item.sourceReference);
  if (!media?.length) return null;
  return <div className="grid max-w-full gap-2">
    {media.map((item) => item.type === 'image'
      ? <a className="block max-w-full overflow-hidden rounded-2xl border border-white/50 bg-white/20" href={mediaUrl(item.url)} target="_blank" rel="noreferrer" key={item.url}><ChatImage item={item} className="max-h-80 w-full object-contain" onLoad={onLoad} /></a>
      : isVideoAttachment(item) ? <MessageVideoPreview item={item} key={item.url} />
      : <FileAttachmentCard item={item} variant="desktop" key={item.url} />)}
  </div>;
}

function FileAttachmentCard({ item, variant = 'default' }: { item: NonNullable<ChatMessage['media']>[number]; variant?: 'default' | 'desktop' }) {
  const { t: tr } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string>();

  async function downloadAttachment() {
    if (downloading) return;
    setDownloading(true);
    setError(undefined);
    try {
      const blob = await downloadMediaUrl(item.url);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = item.name || 'download';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally {
      setDownloading(false);
    }
  }

  return <button
    type="button"
    className={cn(
      'flex max-w-full min-w-0 items-center gap-2 rounded-2xl border text-left font-semibold no-underline transition hover:bg-white/45 disabled:opacity-70',
      variant === 'desktop'
        ? 'w-fit border-white/40 bg-white/30 px-3 py-2 text-sm'
        : 'file-chip px-3 py-2',
    )}
    disabled={downloading}
    onClick={() => void downloadAttachment()}
    title={error ? `${item.name}: ${error}` : item.name}
  >
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/55 text-base" aria-hidden="true">📎</span>
    <span className="min-w-0">
      <span className="block truncate">{item.name}</span>
      <span className="block truncate text-[0.68rem] font-bold opacity-70">{error ? tr('Download failed: {error}', { error }) : downloading ? tr('Downloading…') : attachmentMeta(item)}</span>
    </span>
  </button>;
}

function attachmentMeta(item: NonNullable<ChatMessage['media']>[number]) {
  return [item.mimeType || 'file', typeof item.size === 'number' ? formatBytes(item.size) : undefined].filter(Boolean).join(' · ');
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const MarkdownMedia = React.createContext<ChatMessage['media']>(undefined);
function MarkdownLink({ children, href, isUser }: { children?: React.ReactNode; href?: string | undefined; isUser: boolean }) {
  const media = React.useContext(MarkdownMedia);
  const video = media?.find(item => item.url === href && isVideoAttachment(item));
  if (video) return <MessageVideoPreview key={video.url} item={video}>{children}</MessageVideoPreview>;
  const style = cn('font-semibold underline underline-offset-4 break-words break-all text-left', isUser ? 'text-white decoration-white/70' : 'text-blue-700 decoration-blue-300');
  const reference = href ? sourceLink(href, window.location.origin) : undefined;
  const item = reference && media?.find(item => item.sourceReference?.path === reference.path && item.sourceReference?.line === reference.line);
  return reference ? <SourceReferencePreview reference={reference} media={item} className={style}>{children}</SourceReferencePreview>
    : <a className={style} href={href ? mediaUrl(href) : href} target="_blank" rel="noreferrer">{children}</a>;
}

// Keep renderer types stable even when an API refresh supplies new media objects
// or streaming appends text. Otherwise React remounts every code preview.
const MarkdownText = React.memo(function MarkdownText({ text, tone = 'default', className, media }: { text: string; tone?: 'default' | 'user'; className?: string; media?: ChatMessage['media'] }) {
  return tone === 'user' ? <LongTextReference text={text}><MarkdownTextContent text={text} tone={tone} {...(className ? { className } : {})} media={media} /></LongTextReference>
    : <MarkdownTextContent text={text} tone={tone} {...(className ? { className } : {})} media={media} />;
});

export function markdownImageSource(src: string, media: ChatMessage['media']): { url: string; trusted: boolean } | undefined {
  try {
    const url = new URL(mediaUrl(src), window.location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const service = new URL(apiUrl('/api'), window.location.href);
    const trusted = media?.some(item => item.type === 'image' && mediaUrl(item.url) === mediaUrl(src)) ?? false;
    const inbound = new URL(apiUrl('/api/media/inbound/'), window.location.href);
    const controlled = url.origin === service.origin && url.pathname.startsWith(inbound.pathname)
      && /^[A-Za-z0-9_.-]+$/.test(url.pathname.slice(inbound.pathname.length)) && !url.search && !url.hash;
    return { url: url.href, trusted: trusted || controlled };
  } catch { return; }
}

function MarkdownImage({ src, alt, media }: { src: string; alt?: string | undefined; media: ChatMessage['media'] }) {
  const { t } = useI18n();
  const [acceptedUrl, setAcceptedUrl] = useState('');
  const image = markdownImageSource(src, media);
  if (!image) return <span>{alt || t('Image')}</span>;
  if (!image.trusted && acceptedUrl !== image.url) return <span className="inline-flex max-w-full flex-wrap items-center gap-2">
    <span>{alt || t('Image')}</span>
    <button type="button" className="text-xs underline" title={image.url} onClick={() => setAcceptedUrl(image.url)}>{t('Load external image')}</button>
  </span>;
  return <a href={image.url} target="_blank" rel="noreferrer"><ChatImage item={{ type: 'image', url: image.url, name: alt || t('Image') }} className="max-h-80 max-w-full object-contain" onLoad={undefined} /></a>;
}

const MarkdownTextContent = React.memo(function MarkdownTextContent({ text, tone = 'default', className, media }: { text: string; tone?: 'default' | 'user'; className?: string; media?: ChatMessage['media'] }) {
  const isUser = tone === 'user';
  const components = React.useMemo<Components>(() => ({
        p: ({ children }) => <p className="mb-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] last:mb-0">{children}</p>,
        a: ({ children, href }) => <MarkdownLink href={href} isUser={isUser}>{children}</MarkdownLink>,
        img: ({ src, alt }) => typeof src === 'string' && src ? <MarkdownImage key={src} src={src} alt={alt} media={media} /> : null,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        blockquote: ({ children }) => <blockquote className={cn('mb-3 border-l-4 pl-3 italic last:mb-0', isUser ? 'border-white/40 text-white/90' : 'border-blue-200 text-slate-600')}>{children}</blockquote>,
        h1: ({ children }) => <h1 className="mb-2 text-lg font-black tracking-[-0.03em] last:mb-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 text-base font-black tracking-[-0.02em] last:mb-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 text-sm font-black uppercase tracking-[0.08em] last:mb-0">{children}</h3>,
        strong: ({ children }) => <strong className="font-black text-inherit">{children}</strong>,
        code: ({ className: codeClassName, children, ...props }: any) => {
          const isBlock = /language-/.test(codeClassName ?? '');
          if (!isUser && !isBlock && typeof children === 'string' && !children.includes('\n') && sourceLink(children, window.location.origin)) {
            return <MarkdownLink href={children} isUser={false}>{children}</MarkdownLink>;
          }
          return <code className={cn(
            isBlock
              ? 'block overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border p-3 text-xs leading-5 shadow-inner max-w-full min-w-0 [overflow-wrap:anywhere]'
              : 'rounded-md border px-1.5 py-0.5 text-[0.86em] font-semibold break-words break-all whitespace-pre-wrap',
            isBlock
              ? (isUser ? 'border-white/30 bg-white/88 text-slate-900 shadow-blue-950/10' : 'border-slate-200/80 bg-slate-50/95 text-slate-800 shadow-slate-900/5')
              : (isUser ? 'border-white/25 bg-white/22 text-white' : 'border-blue-100 bg-blue-50/80 text-blue-800'),
            codeClassName,
          )} {...props}>{children}</code>;
        },
        pre: ({ children }) => <pre className={cn('mb-3 max-w-full min-w-0 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl [overflow-wrap:anywhere] last:mb-0', isUser ? 'bg-white/12' : 'bg-slate-50/80')}>{children}</pre>,
        table: ({ children }) => <div className="mb-3 overflow-x-auto rounded-2xl border border-slate-200 last:mb-0 max-w-full min-w-0"><table className="min-w-full text-left text-xs">{children}</table></div>,
        th: ({ children }) => <th className={cn('border-b px-3 py-2 font-bold', isUser ? 'border-white/20' : 'border-slate-200 bg-slate-50')}>{children}</th>,
        td: ({ children }) => <td className={cn('border-b px-3 py-2 align-top last:border-b-0', isUser ? 'border-white/15' : 'border-slate-100')}>{children}</td>,
        hr: () => <hr className={cn('my-3', isUser ? 'border-white/20' : 'border-slate-200')} />,
      }), [isUser, media]);
  // Metadata/wrapper updates do not change Markdown syntax. Reuse only this
  // mounted body's element; context still reaches source-link consumers below
  // it. Text/tone changes invalidate it, and unmount retains no global cache.
  const renderedMarkdown = React.useMemo(() => {
    const plainFallback = <>
      {text.split(/\r?\n(?:\r?\n)+/).map((block, index) => <p key={index} className="mb-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] last:mb-0">{block}</p>)}
    </>;
    if (isPlainTextMarkdown(text)) {
      return plainFallback;
    }
    const element = <Suspense fallback={plainFallback}>
      <LazyMessageRichMarkdown text={text} components={components} />
    </Suspense>;
    return element;
  }, [text, tone, components]);
  return <MarkdownMedia.Provider value={media}><div className={cn('markdown-body min-w-0 max-w-full break-words text-[12px] leading-[1.25] [overflow-wrap:anywhere] [&_*]:max-w-full [&_*]:leading-[1.25]', isUser ? 'text-white' : 'text-slate-800', className)}>
    {renderedMarkdown}
  </div></MarkdownMedia.Provider>;
});

function MessageMedia({ media: allMedia, onLoad }: { media: ChatMessage['media']; onLoad: (() => void) | undefined }) {
  const media = allMedia?.filter(item => !item.sourceReference);
  if (!media?.length) return null;
  return <div className="message-media">
    {media.map((item) => item.type === 'image'
      ? <a href={mediaUrl(item.url)} target="_blank" rel="noreferrer" key={item.url}><ChatImage item={item} onLoad={onLoad} /></a>
      : isVideoAttachment(item) ? <MessageVideoPreview item={item} key={item.url} />
      : <FileAttachmentCard item={item} key={item.url} />)}
  </div>;
}


async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to a temporary textarea for HTTP dev hosts or older browsers.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.inset = '0 auto auto -9999px';
  textarea.style.opacity = '0';
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
    if (selection && ranges.every(range => range.commonAncestorContainer.isConnected)) {
      selection.removeAllRanges();
      ranges.forEach(range => selection.addRange(range));
    }
  }
  if (!copied) throw new Error('Clipboard copy failed. Select the text and press Ctrl/Cmd+C.');
}

export function readableText(value: unknown): string {
  if (typeof value === 'string') return value.trim() || '(empty)';
  if (value === null || value === undefined) return '(empty)';
  if (Array.isArray(value)) return value.map(readableText).filter((item) => item !== '(empty)').join('\n\n') || '(empty)';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function isInternalOutput(message: ChatMessage) {
  if (message.role === 'tool') return true;
  const text = stripThinkingLines(readableText(message.text));
  if (!text || text === '(empty)') return false;
  // Assistant turns stay chat bubbles so interim step-by-step replies remain visible,
  // except normalized tool transcripts. Those are execution records and must stay collapsed.
  if (message.role === 'assistant') return isNormalizedToolTranscript(text);
  return /^(HTTP\/\d|LISTEN\s|Command still running|Process still running|remote:|\[[\w/-]+\s+[0-9a-f]{7}\]|>\s*@agentopsdeck\/|M\s+apps\/|\{\s*"ok"\s*:)/m.test(text);
}

function isNormalizedToolTranscript(text: string) {
  const stripped = text.trim();
  if (!/^\[tool\s+[^\]\n]+\]/i.test(stripped)) return false;
  return /\n\s*tool input:\s*\n/i.test(stripped) || /\n\s*\[tool output\]/i.test(stripped) || /\n\s*(status|error|output):\s*/i.test(stripped);
}

function internalOutputLabel(text: string) {
  const toolMatch = text.match(/^\[tool\s+([^\]\n]+)\]/i);
  if (toolMatch?.[1]) return toolMatch[1].trim();
  if (/git|commit|merge request|remote:/i.test(text)) return 'Git result';
  if (/HTTP\/\d|"ok"\s*:\s*true/i.test(text)) return 'HTTP result';
  if (/LISTEN|EADDRINUSE|tsx|server listening/i.test(text)) return 'Server result';
  return 'Tool result';
}


type ToolTimelineEntry = {
  id: string;
  stableKey: string;
  sessionKey: string;
  label: string;
  hint: string | undefined;
  variant: ToolOutputVariant;
  tokenLabel: string | undefined;
  preview: string;
  executingSince: number | undefined;
  detailAvailable: boolean;
  elapsedLabel: string | undefined;
  phaseLabel: 'call' | 'result' | 'history result' | 'call + result';
  sortIndex: number;
};

function renderToolVariantIcon(variant: ToolOutputVariant) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (variant) {
    case 'exec': return <Terminal className={cls} />;
    case 'process': return <Cpu className={cls} />;
    case 'file': return <FileCode2 className={cls} />;
    case 'media': return <ImageIcon className={cls} />;
    case 'git': return <GitBranch className={cls} />;
    case 'http': return <Globe className={cls} />;
    case 'server': return <Server className={cls} />;
    case 'subagent': return <Bot className={cls} />;
    case 'agent-call': return <MessageSquareShare className={cls} />;
    default: return <Wrench className={cls} />;
  }
}

function renderMobileStripDetail(id: string, text: string, variant: ToolOutputVariant) {
  const parsed = parseToolDetail(text);
  if (parsed.kind === 'structured') {
    return (
      <div id={id} className={cn('mobile-tool-strip-detail is-structured', `desktop-tool-detail--${variant}`)}>
        <ToolDetailBody parsed={parsed} compact />
      </div>
    );
  }
  return <pre id={id} className="mobile-tool-strip-detail">{text}</pre>;
}

function buildToolTimelineEntries(messages: ChatMessage[]): ToolTimelineEntry[] {
  const entries: ToolTimelineEntry[] = [];
  const grouped = new Map<string, { key: string; call?: ChatMessage; result?: ChatMessage; index: number }>();

  messages.forEach((message, index) => {
    if (!message.toolCallId) {
      const entry = toToolTimelineEntry(message, index, messages);
      if (entry) entries.push(entry);
      return;
    }
    const key = JSON.stringify([message.sessionKey, message.toolCallId]);
    const group = grouped.get(key) ?? { key, index };
    group.index = Math.min(group.index, index);
    if (message.toolPhase === 'call') group.call = message;
    else group.result = message;
    grouped.set(key, group);
  });

  for (const group of grouped.values()) {
    const entry = toGroupedToolTimelineEntry(group, messages);
    if (entry) entries.push(entry);
  }

  return entries.sort((a, b) => a.sortIndex - b.sortIndex);
}

function toGroupedToolTimelineEntry(group: { key: string; call?: ChatMessage; result?: ChatMessage; index: number }, messages: ChatMessage[]): ToolTimelineEntry | null {
  const message = group.result ?? group.call;
  if (!message) return null;
  const callText = group.call ? displayMessageText(readableText(group.call.toolPreview ?? group.call.text)) : '';
  const resultText = group.result ? displayMessageText(readableText(group.result.toolPreview ?? group.result.text)) : '';
  const preview = [callText, resultText].filter(Boolean).join('\n\n');
  if (isToolOutputPlaceholder(preview)) return null;
  const resultDeltaText = group.result ? toolResultTextForTokenEstimate(resultText) : '';
  const label = toolEntryLabel(message, preview);
  const executing = isToolExecuting(group.call, group.result);
  const hint = group.result?.status === 'failed' ? 'failed' : (executing ? 'executing' : undefined);
  // Named tools already determine the variant; don't scan their output for a
  // fallback agent hint which isn't displayed on grouped entries.
  const variant = toolVariantFromLabel(label) ?? toolOutputVariant(preview, label, agentCallHint(preview));
  const nextMessage = messages[group.index + 1];
  const elapsedMs = groupedToolElapsedMs(group.call, group.result, nextMessage);
  return {
    id: message.id,
    stableKey: `tool-call:${group.key}`,
    sessionKey: message.sessionKey,
    label,
    hint,
    variant,
    tokenLabel: resultDeltaText ? formatTokenDelta(estimateTextTokens(resultDeltaText)) : undefined,
    preview,
    executingSince: executing ? group.call!.createdAt : undefined,
    detailAvailable: Boolean(group.result?.toolDetailAvailable ?? group.call?.toolDetailAvailable),
    elapsedLabel: elapsedMs !== undefined ? formatElapsedMs(elapsedMs) : undefined,
    phaseLabel: group.call && group.result ? 'call + result' : group.result ? 'history result' : 'call',
    sortIndex: group.index,
  };
}

function withToolTimelineClock(entries: ToolTimelineEntry[], liveNow?: number): ToolTimelineEntry[] {
  if (liveNow === undefined) return entries;
  return entries.map(entry => entry.executingSince === undefined ? entry : {
    ...entry,
    hint: `executing · ${formatElapsedMs(Math.max(0, liveNow - entry.executingSince))}`,
  });
}

function useToolTimelineEntries(messages: ChatMessage[]) {
  // Component-owned memoization, not a history/text cache. Clock ticks and
  // detail interactions must not reparse all completed tool output.
  const prepared = useMemo(() => buildToolTimelineEntries(messages), [messages]);
  const hasExecutingTool = prepared.some(entry => entry.executingSince !== undefined);
  const liveNow = useLiveToolNow(hasExecutingTool);
  const entries = useMemo(() => withToolTimelineClock(prepared, liveNow), [prepared, liveNow]);
  return { entries, liveNow };
}

function useLiveToolNow(hasExecutingTool: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasExecutingTool) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasExecutingTool]);
  return hasExecutingTool ? now : undefined;
}

function toToolTimelineEntry(message: ChatMessage, index: number, messages: ChatMessage[]): ToolTimelineEntry | null {
  const preview = displayMessageText(readableText(message.toolPreview ?? message.text));
  if (isToolOutputPlaceholder(preview)) return null;
  const resultText = toolResultTextForTokenEstimate(preview);
  if (!resultText) return null;
  const label = toolEntryLabel(message, preview);
  const hint = agentCallHint(preview);
  const variant = toolOutputVariant(preview, label, hint);
  const nextMessage = messages[index + 1];
  const elapsedMs = nextMessage ? Math.max(0, nextMessage.createdAt - message.createdAt) : undefined;
  return {
    id: message.id,
    stableKey: JSON.stringify([message.sessionKey, 'tool-message', message.toolCallId ?? message.id]),
    sessionKey: message.sessionKey,
    label,
    hint,
    variant,
    tokenLabel: formatTokenDelta(estimateTextTokens(resultText)),
    preview,
    executingSince: undefined,
    detailAvailable: Boolean(message.toolDetailAvailable),
    elapsedLabel: elapsedMs !== undefined ? formatElapsedMs(elapsedMs) : undefined,
    phaseLabel: message.toolPhase === 'result' ? 'history result' : 'result',
    sortIndex: index,
  };
}

function toolEntryLabel(message: ChatMessage, text: string) {
  if (message.toolName) return message.toolName;
  return internalOutputLabel(text);
}

function toolResultTextForTokenEstimate(text: string) {
  const withoutInput = stripToolInputBlocks(text)
    .replace(/^\s*\[tool\s+[^\]\n]+\]\s*/i, '')
    .replace(/^status:\s*[^\n]*$/gim, '')
    .replace(/^\s*\[\s*tool[_\s-]*output\s*\]\s*$/gim, '')
    .trim();
  const outputMatch = withoutInput.match(/(?:^|\n)output:\s*\n([\s\S]*)$/i);
  if (outputMatch?.[1]) return outputMatch[1].trim();
  const errorMatch = withoutInput.match(/(?:^|\n)error:\s*([\s\S]*)$/i);
  if (errorMatch?.[1]) return errorMatch[1].trim();
  return withoutInput;
}

function stripToolInputBlocks(text: string) {
  return text
    .replace(/(?:^|\n)tool input:\s*\n```(?:json)?\s*\n[\s\S]*?\n```/gi, '\n')
    .replace(/(?:^|\n)tool input:\s*\n[\s\S]*?(?=\n(?:status:|error:|output:|\[\s*tool[_\s-]*output\s*\])|$)/gi, '\n');
}

function estimateTextTokens(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function formatTokenDelta(tokens: number) {
  if (tokens <= 0) return undefined;
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `+${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}k tok`;
  }
  return `+${tokens} tok`;
}

function toolOutputVariant(text: string, label: string, hint: string | undefined): ToolOutputVariant {
  const namedVariant = toolVariantFromLabel(label);
  if (namedVariant) return namedVariant;
  const lower = text.toLowerCase();
  if (lower.includes('sessions_spawn') || lower.includes('subagent') || lower.includes('[subagent task]') || hint === 'subagent') return 'subagent';
  if (lower.includes('sessions_send') || lower.includes('agentturn') || lower.includes('agent turn') || hint === 'agent call') return 'agent-call';
  if (label === 'Git result') return 'git';
  if (label === 'HTTP result') return 'http';
  if (label === 'Server result') return 'server';
  if (hint) return 'agent-call';
  return 'generic';
}

// Best-effort visual hint only. Source of truth remains the raw tool output opened below the chip.
function toolTokenLabel(message: ChatMessage) {
  const input = message.inputTokens;
  const output = message.outputTokens;
  const total = message.totalTokens ?? ((input ?? 0) + (output ?? 0) || undefined);
  if (input !== undefined || output !== undefined) return `tok ${formatTokenValue(input)}→${formatTokenValue(output)}`;
  if (total !== undefined) return `tok ${formatTokenValue(total)}`;
  return undefined;
}

function toolCompactSummary(text: string) {
  const parts: string[] = [];
  const status = text.match(/^status:\s*(.+)$/im)?.[1]?.trim();
  if (status) parts.push(`status ${status}`);
  const input = text.match(/tool input:\s*```(?:json)?\s*\n([\s\S]*?)\n```/i)?.[1]?.trim();
  const summarizedInput = summarizeToolInput(input);
  if (summarizedInput) parts.push(summarizedInput);
  const error = text.match(/^error:\s*(.+)$/im)?.[1]?.trim();
  if (error && !status?.toLowerCase().includes('error')) parts.push(`error ${error}`);
  return truncateMiddle(parts.filter(Boolean).join(' · '), 92);
}

function summarizeToolInput(input: string | undefined) {
  if (!input) return undefined;
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 3)
        .map(([key, value]) => `${key}=${compactToolValue(value)}`);
      return entries.length ? `input ${entries.join(', ')}` : undefined;
    }
  } catch {
    // Fall through to plain-text summary.
  }
  const firstLine = input.split('\n').map((line) => line.trim()).filter(Boolean)[0];
  return firstLine ? `input ${firstLine}` : undefined;
}

function compactToolValue(value: unknown) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(truncateMiddle(value, 28));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') return '{…}';
  return String(value);
}

function formatElapsedMs(ms: number) {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const totalSeconds = Math.round(ms / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const keep = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function agentCallHint(text: string) {
  const lower = text.toLowerCase();
  const explicitAgent = text.match(/agentId["'`]?\s*[:=]\s*["'`]([a-z0-9][\w.-]{1,63})["'`]/i)?.[1];
  if (explicitAgent) return compactAgentHint(explicitAgent);
  if (lower.includes('sessions_spawn') || lower.includes('subagent') || lower.includes('[subagent task]')) return 'subagent';
  if (lower.includes('sessions_send') || lower.includes('agentturn') || lower.includes('agent turn')) return 'agent call';
  return undefined;
}

function compactAgentHint(agentId: string) {
  const knownRoles = ['backend-dev', 'web-dev', 'devops', 'product', 'design', 'dev', 'pm', 'ui'];
  return knownRoles.find((suffix) => agentId.endsWith(`-${suffix}`)) ?? agentId;
}

function isToolOutputPlaceholder(text: string) {
  const normalizedLines = stripThinkingLines(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== '```' && line !== '```text');
  return normalizedLines.length > 0 && normalizedLines.every((line) => /^\[\s*tool[_\s-]*output\s*\]$/i.test(line));
}

function stripThinkingLines(text: string) {
  if (!text.includes('{"type":"thinking"')) return text.trim();
  return text.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{"type":"thinking"')) return true;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed?.type !== 'thinking';
    } catch {
      return true;
    }
  }).join('\n').trim();
}


function isHiddenAssistantNoise(message: ChatMessage) {
  if (message.role !== 'assistant') return false;
  if (message.status === 'failed') return false;
  const stripped = stripThinkingLines(readableText(message.text));
  if (isAssistantTurnFailureText(stripped)) return false;
  if (isToolOutputPlaceholder(stripped)) return true;
  return stripped.trim().length === 0;
}

function isSilentReply(text: string) {
  return text.trim().toUpperCase() === 'NO_REPLY';
}

function displayMessageText(rawText: string) {
  const stripped = stripThinkingLines(rawText);
  if (isAssistantTurnFailureText(stripped)) return 'Assistant turn failed before producing content.';
  if (stripped.trim().length > 0) return stripped;
  if (rawText.includes('"type":"thinking"')) return '(thinking…)';
  return rawText;
}

function messageFailureText(message: ChatMessage, displayText: string) {
  if (hasInvalidAssistantOutput(message)) return INVALID_ASSISTANT_OUTPUT_TEXT;
  const suffix = message.failureReason ? ` (${message.failureReason})` : '';
  if (isAssistantTurnFailureText(displayText) || displayText === 'Assistant turn failed before producing content.') return `Assistant turn failed before producing content.${suffix}`;
  if (message.status !== 'failed') return undefined;
  return message.role === 'user'
    ? `Send failed — message was not delivered.${suffix}`
    : `Assistant turn failed before producing content.${suffix}`;
}

function isAssistantTurnFailureText(text: string) {
  return /^\[?assistant turn failed before producing content\]?$/i.test(text.trim());
}

function isLongMessage(text: string) {
  return text.length > 260 || lineCount(text) > 5;
}

function threeLinePreview(text: string) {
  return text.split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 3).join('\n');
}

function lineCount(text: string) {
  return Math.max(1, text.split('\n').length);
}

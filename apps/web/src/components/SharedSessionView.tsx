import { translate, useI18n } from '../lib/i18n';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage, SendDeliveryMode, SendMessageUpload } from '@agentopsdeck/shared';
import { MAX_MESSAGE_CHARS, resolveMessageLimits } from '@agentopsdeck/shared';
import { LongTextReference } from './LongTextReference';
import { api, eventStreamUrl, recoveryScope, recoveryEpoch } from '../api';
import { readSharedImages, SHARED_IMAGE_ACCEPT } from '../lib/shared-upload';
import { CommandNotSubmittedError, CommandOutcomeUnknownError, newCommandKey } from '../lib/command-recovery';
import { sendMessageWithRecovery } from '../lib/message-submission';
import { useMessageRetryUpdates } from '../lib/use-message-retry';
import { applyMessageAdmission } from '../lib/message-admission';
import { useAdmissionHistory } from '../lib/use-admission-history';
import { AdmissionHistoryNotice } from './AdmissionHistoryNotice';
import { hasMatchingRealMessage, mergeMessages } from '../lib/optimistic-messages';
import { mergeSelectionSafeMessages } from '../lib/message-selection';
import { sessionAddress, sharedSessionRoute, type SharedSessionTarget } from '../lib/session-address';
import { createSharedSessionLive, type SharedLiveState } from '../lib/shared-session-live';
import { CommandRecoveryNotice } from './CommandRecoveryNotice';
import { createDesktopMessageProjector, DesktopMessageWithTools, DesktopToolTimeline } from './messages';
import { useProgressiveTailRenderItems } from '../lib/progressive-tail-render';
import { observeDesktopHistoryLayout } from '../lib/desktop-history-layout';
import { Button } from './ui/button';
const LazySharedGrantDirectory = lazy(() => import('./SharedGrantDirectory').then(module => ({ default: module.SharedGrantDirectory })));
const SharedGrantDirectory = (props: React.ComponentProps<typeof LazySharedGrantDirectory>) => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazySharedGrantDirectory {...props} /></Suspense>;
const LazySharedQueuePanel = lazy(() => import('./SharedQueuePanel').then(module => ({ default: module.SharedQueuePanel })));
const SharedQueuePanel = (props: React.ComponentProps<typeof LazySharedQueuePanel>) => <Suspense fallback={<p role="status">{translate('Loading…')}</p>}><LazySharedQueuePanel {...props} /></Suspense>;
const LazySessionSharing = lazy(() => import('./SessionSharing').then(module => ({ default: module.SessionSharing })));
const SessionSharing = (props: React.ComponentProps<typeof LazySessionSharing>) => <Suspense fallback={null}><LazySessionSharing {...props} /></Suspense>;
import { GlobalNotebookTrigger, SessionNotebook } from './SessionNotebook';
import { SessionColorMark } from './SessionColorMark';
import { sessionTone } from '../lib/session-tone';
import type { TranslationKey } from '../lib/i18n';

const sharedStatusLabels: Readonly<Record<string, TranslationKey>> = {
  starting: 'Starting', running: 'run', waiting: 'waiting', finalizing: 'Finalizing', completed: 'Completed',
  failed: 'Failed', interrupted: 'Interrupted', unknown: 'Unknown', idle: 'idle', error: 'error', done: 'done',
  connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', disconnected: 'Disconnected',
  loading: 'Loading…', ready: 'Ready', stale: 'Stale', unavailable: 'Unavailable', unauthorized: 'Unauthorized',
  current: 'Current', syncing: 'Syncing', stopped: 'Stopped', pending: 'Pending', archived: 'Archived',
};

export function sharedStatusLabel(value: string, label: (key: TranslationKey) => string): string {
  return Object.hasOwn(sharedStatusLabels, value) ? label(sharedStatusLabels[value]!) : label('Unknown');
}

const initialState = (): SharedLiveState => ({ historySync: 'loading', executionSync: 'loading', transport: 'connecting', source: 'unknown', denied: false });

/** Intercept before mounting either owner catalog shell; no owner-wide request
 * is needed to follow an explicitly authorized shared session URL. */
export function SharedSessionBoundary({ children, paused = false }: { children: ReactNode; paused?: boolean }) {
  const { t: tr } = useI18n();
  const [route, setRoute] = useState(() => sharedSessionRoute(window.location.hash));
  useEffect(() => {
    const changed = () => setRoute(sharedSessionRoute(window.location.hash));
    window.addEventListener('hashchange', changed);
    window.addEventListener('agentopsdeck:route-changed', changed);
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('agentopsdeck:route-changed', changed); };
  }, []);
  if (route.kind === 'owner') return children;
  if (route.kind === 'invalid') return <main className="p-6 text-sm"><p role="alert">{tr("Invalid session link. No session was opened.")}</p><a href="#/tab/sessions">{tr("Back to sessions")}</a></main>;
  if (route.kind === 'directory') return <SharedGrantDirectory key={recoveryScope()} paused={paused} />;
  return <SharedSessionView key={`${recoveryScope()}:${recoveryEpoch()}:${route.key}`} target={route.target} paused={paused} />;
}

function SharedSessionView({ target, paused }: { target: SharedSessionTarget; paused: boolean }) {
  const { t: tr } = useI18n();
  const key = sessionAddress(target).key;
  const [state, setState] = useState<SharedLiveState>(initialState);
  const messageLimit = resolveMessageLimits(state.history?.limits).maxMessageChars;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const { historyDelayed, refreshAccepted } = useAdmissionHistory(key, messages, !paused && !state.denied);
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [media, setMedia] = useState<SendMessageUpload[]>([]);
  const [readingImages, setReadingImages] = useState(false);
  const imageRead = useRef<AbortController | undefined>(undefined);
  const [deliveryMode, setDeliveryMode] = useState<SendDeliveryMode>('web-only');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueRevision, setQueueRevision] = useState(0);
  const [accessRevision, setAccessRevision] = useState(0);
  const live = useRef<ReturnType<typeof createSharedSessionLive> | undefined>(undefined);
  const submission = useRef(false);
  const mounted = useRef(false);
  const accessEpoch = useRef(0);
  const latestMessages = useRef<ChatMessage[]>([]);
  const scroller = useRef<HTMLElement | null>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; imageRead.current?.abort(); };
  }, []);
  useEffect(() => {
    accessEpoch.current++;
    imageRead.current?.abort(); setMedia([]); setReadingImages(false);
    setState(initialState()); setMessages([]); setOptimistic([]); setSending(false); latestMessages.current = [];
    if (paused) return;
    const controller = createSharedSessionLive({ target, scope: recoveryScope,
      url: () => eventStreamUrl(target),
      history: signal => api.sessionMessages(target, 180, signal),
      execution: signal => api.sharedSessionExecution(target, signal),
      onChange: next => {
        setState(next);
        if (next.denied) { accessEpoch.current++; imageRead.current?.abort(); setMedia([]); setReadingImages(false); setOptimistic([]); }
        const incoming = next.history?.messages ?? [];
        if (latestMessages.current !== incoming) {
          latestMessages.current = incoming;
          setMessages(current => next.history ? mergeSelectionSafeMessages(current, incoming) : []);
        }
      },
    });
    live.current = controller;
    const selectionChanged = () => { if (window.getSelection()?.isCollapsed) setMessages(latestMessages.current); };
    const focus = () => { if (!document.hidden) { controller.ensureConnected(); controller.refresh(); } };
    document.addEventListener('selectionchange', selectionChanged);
    document.addEventListener('visibilitychange', focus);
    window.addEventListener('focus', focus);
    window.addEventListener('pageshow', focus);
    window.addEventListener('online', focus);
    controller.start();
    return () => {
      accessEpoch.current++;
      controller.stop(); live.current = undefined;
      document.removeEventListener('selectionchange', selectionChanged);
      document.removeEventListener('visibilitychange', focus);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pageshow', focus);
      window.removeEventListener('online', focus);
    };
  }, [key, paused, accessRevision]);
  useEffect(() => observeDesktopHistoryLayout(scroller.current), []);
  useEffect(() => { setOptimistic(current => current.filter(message => !hasMatchingRealMessage(messages, message))); }, [messages]);
  const visibleMessages = useMemo(() => mergeMessages(messages, optimistic), [messages, optimistic]);
  const sharedProjector = useMemo(() => createDesktopMessageProjector(), [key]);
  const allSharedRenderItems = useMemo(() => sharedProjector(visibleMessages), [sharedProjector, visibleMessages]);
  const sharedRenderItems = useProgressiveTailRenderItems({
    sessionKey: key,
    items: allSharedRenderItems,
    bypass: !atBottom.current,
    containerRef: scroller,
    followingRef: atBottom,
  });
  useEffect(() => {
    if (atBottom.current && window.getSelection()?.isCollapsed && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, optimistic]);
  const refresh = useCallback(async () => { live.current?.refresh(); setQueueRevision(value => value + 1); }, []);
  useMessageRetryUpdates(key, setOptimistic, refresh);
  async function selectImages(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []); event.target.value = '';
    if (!files.length || sending || paused || state.denied || !state.access?.messagesSend) return;
    imageRead.current?.abort();
    const controller = new AbortController(), scope = recoveryScope(), identity = recoveryEpoch(), epoch = accessEpoch.current;
    imageRead.current = controller; setReadingImages(true); setNotice('');
    const current = () => mounted.current && !controller.signal.aborted && scope === recoveryScope() && identity === recoveryEpoch() && epoch === accessEpoch.current;
    try { const items = await readSharedImages(files, controller.signal); if (current()) setMedia(items); }
    catch { if (current()) setNotice('Invalid images. Select up to 8 PNG, JPEG, GIF or WebP files, 5 MiB each and 20 MiB total.'); }
    finally { if (imageRead.current === controller) { imageRead.current = undefined; if (mounted.current) setReadingImages(false); } }
  }
  function clearImages() { imageRead.current?.abort(); setMedia([]); }
  async function submit() {
    if (submission.current || readingImages || paused || state.denied || !state.access?.messagesSend
      || (deliveryMode === 'mirror' && !state.access.messagesMirror) || state.historySync !== 'ready' || !draft.trim() && !media.length || draft.length > messageLimit) return;
    const payload = draft, attachments = media, scope = recoveryScope(), identity = recoveryEpoch(), epoch = accessEpoch.current;
    const current = () => mounted.current && scope === recoveryScope() && identity === recoveryEpoch() && epoch === accessEpoch.current;
    const commandKey = newCommandKey(), runtime = state.execution?.runtime;
    const busy = runtime ? ['starting', 'running', 'waiting', 'finalizing'].includes(runtime.phase)
      || ['running', 'waiting'].includes(runtime.threadActivity ?? '') : !!state.execution?.hasActiveRun;
    const outgoing: ChatMessage = { id: commandKey, sessionKey: key, role: 'user', text: payload || attachments.map(item => item.name).join(', '), createdAt: Date.now(),
      status: 'sending', queueDisposition: busy && payload.trim() !== '/stop' ? 'waiting' : 'preparing' };
    submission.current = true;
    setSending(true); setNotice(''); setDraft(''); setMedia([]); setOptimistic(current => [...current, outgoing]);
    try {
      const response = await sendMessageWithRecovery(key, payload, deliveryMode, attachments, commandKey);
      if (!current()) return;
      setOptimistic(current => current.map(message => message.id === commandKey ? applyMessageAdmission(message, response) : message));
      refreshAccepted(outgoing, response, refresh);
    } catch (error) {
      if (!current()) return;
      setOptimistic(current => error instanceof CommandNotSubmittedError ? current.filter(message => message.id !== commandKey)
        : current.map(message => message.id === commandKey ? { ...message, status: error instanceof CommandOutcomeUnknownError ? 'outcome_unknown' : 'failed' } : message));
      if (error instanceof CommandNotSubmittedError) { setDraft(current => current || payload); setMedia(attachments); }
      if (error instanceof CommandOutcomeUnknownError) {
        // The receipt notice owns this transient state and its later cleanup.
        setDraft(''); setNotice('');
      } else setNotice(error instanceof Error ? error.message : 'Submission unavailable');
    } finally { submission.current = false; if (current()) setSending(false); }
  }
  const execution = state.execution;
  // These are last-known execution facts, never derived from socket connectivity
  // or assistant text. Even a terminal phase is shown as stale when its read lags.
  const phase = execution?.runtime?.phase ?? (execution?.hasActiveRun ? 'running' : execution?.structuredStatus?.displayStatus ?? execution?.status ?? 'unknown');
  return <main data-font-area="chat" className="flex h-dvh min-h-0 flex-col bg-slate-50 text-sm text-slate-800" aria-label={tr("Shared session")}>
    <header style={{ borderTop: `3px solid ${sessionTone(target.sessionId).accent}` }} className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <a className="text-sm text-blue-700" href="#/shared">← {tr("Shared")}</a>
        <div className="order-first min-w-0 basis-full sm:order-none sm:flex-1 sm:basis-auto"><div className="flex min-w-0 items-center gap-2"><SessionColorMark sessionKey={target.sessionId} /><h1 className="truncate text-sm font-semibold">{tr(state.access?.sessionsShare ? 'My session' : 'Shared session')}</h1></div><p className="truncate text-xs text-slate-500" title={`${target.ownerUserId} / ${target.sessionId}`}>{target.ownerUserId} / {target.sessionId}</p></div>
        <Button size="sm" variant="secondary" disabled={paused} onClick={() => {
          if (state.denied) setAccessRevision(value => value + 1); else void refresh();
        }}>{tr(state.denied ? 'Check access again' : 'Refresh')}</Button>
        <Button size="sm" variant="secondary" disabled={paused || state.denied} aria-expanded={queueOpen} onClick={() => setQueueOpen(value => !value)}>{tr(queueOpen ? 'Hide queue' : 'My queue')}</Button>
        <GlobalNotebookTrigger />
        {!paused && !state.denied && state.access && <SessionNotebook key={`notebook:${recoveryScope()}:${key}`} sessionKey={key} title={target.sessionId} />}
      </div>
      {state.access?.sessionsShare && !paused && !state.denied ? <SessionSharing key={key} sessionKey={key} /> : null}
      <div className="mx-auto mt-3 flex max-w-5xl flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={tr("Shared session status")}>
        <span data-testid="shared-execution">{tr("Execution")}: {sharedStatusLabel(phase, tr)}{state.executionSync !== 'ready' && execution ? ` (${tr('last known')})` : ''}</span>
        {execution?.runtime?.threadActivity ? <span>{tr("Thread")}: {sharedStatusLabel(execution.runtime.threadActivity, tr)}{state.executionSync !== 'ready' ? ` (${tr('last known')})` : ''}</span> : null}
        <span>{tr("Live link")}: {state.access ? state.access.eventsRead ? sharedStatusLabel(state.transport, tr) : tr('unavailable for this access') : tr('checking access')}</span>
        <span>{tr("Messages")}: {sharedStatusLabel(state.historySync, tr)}</span>
        <span>{tr("State sync")}: {sharedStatusLabel(state.executionSync, tr)}</span>
        {state.source !== 'unknown' ? <span>{tr("Node link")}: {sharedStatusLabel(state.source, tr)}</span> : null}
        {execution?.runtime ? <span>{tr("Agent link")}: {sharedStatusLabel(execution.runtime.connection, tr)} · {tr("Runtime sync")}: {sharedStatusLabel(execution.runtime.sync, tr)}</span> : null}
      </div>
    </header>
    <section ref={scroller} className="desktop-session-frame message-selection-surface min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6" aria-label={tr("Shared conversation")}
      onScroll={() => { const element = scroller.current; if (element) atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      <div className="mx-auto flex min-w-0 max-w-5xl flex-col gap-4">
        {queueOpen && !paused && !state.denied ? <SharedQueuePanel sessionKey={key} revision={queueRevision} onChanged={refresh} onDenied={() => live.current?.refresh()} /> : null}
        {state.denied ? <p role="alert">{tr("Shared access is no longer available. Private snapshots have been cleared.")}</p> : null}
        {state.historySync === 'loading' ? <p role="status">{tr("Loading shared messages…")}</p> : null}
        {state.historySync === 'unavailable' ? <p role="status">{tr('Messages unavailable.')}{state.history ? ` ${tr('Showing the last authorized snapshot.')}` : ''}</p> : null}
        {state.history?.hiddenCount ? <p className="text-center text-xs text-slate-500">{tr('{count} older messages not loaded', { count: state.history.hiddenCount })}</p> : null}
        {sharedRenderItems.map(item => item.kind === 'toolGroup'
          ? <DesktopToolTimeline key={`tools:${item.messages[0]?.id}`} messages={item.messages} />
          : <div key={item.message.id} data-message-search-id={item.message.id}><DesktopMessageWithTools message={item.message} attachedTools={item.attachedTools} isRecent={false} onMediaLoad={undefined} /></div>)}
      </div>
    </section>
    <footer className="shrink-0 border-t border-slate-200 bg-white px-3 py-3 sm:px-6">
      <div className="mx-auto max-w-5xl">
        {!paused && !state.denied ? <CommandRecoveryNotice sessionKey={key} onRecovered={refresh} /> : null}
        <form onSubmit={event => { event.preventDefault(); void submit(); }} className="flex items-end gap-2">
          <LongTextReference text={draft} editable><textarea name="sharedsessionview-textarea-1" aria-label={tr("Shared message")} className="min-h-16 w-full min-w-0 flex-1 resize-y rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:opacity-50" rows={2}
            placeholder={tr("Message this shared session")} value={draft} onChange={event => setDraft(event.target.value)} disabled={sending || paused || state.denied || !state.access?.messagesSend} />
          </LongTextReference>
          <Button type="submit" size="sm" disabled={sending || readingImages || paused || state.denied || !state.access?.messagesSend || (deliveryMode === 'mirror' && !state.access.messagesMirror) || state.historySync !== 'ready' || !draft.trim() && !media.length || draft.length > messageLimit}>{tr(sending ? 'Submitting…' : 'Send')}</Button>
        </form>
        <label className="mt-2 block text-xs">{tr('Attach images (up to 8, 5 MiB each, 20 MiB total)')}
          <input type="file" accept={SHARED_IMAGE_ACCEPT} multiple onChange={selectImages} disabled={sending || readingImages || paused || state.denied || !state.access?.messagesSend} className="mt-1 block max-w-full" />
        </label>
        {readingImages ? <p role="status" className="mt-1 text-xs">{tr('Reading images…')}</p> : null}
        {media.length ? <div className="mt-1 flex flex-wrap items-center gap-2 text-xs"><span className="min-w-0 break-all">{media.map(item => item.name).join(', ')}</span><Button size="sm" variant="secondary" onClick={clearImages} disabled={sending}>{tr('Clear attachments')}</Button></div> : null}
        {messageLimit < MAX_MESSAGE_CHARS ? <p className="mt-1 text-xs text-slate-500">{tr('This Connector currently allows {limit} characters. Upgrade it to support longer messages.', { limit: messageLimit })}</p> : null}
        {draft.length > messageLimit ? <p role="alert" className="mt-1 text-xs text-red-600">{tr('Message is too long. Max {limit} characters.', { limit: messageLimit })}</p> : null}
        {state.access?.messagesMirror || deliveryMode === 'mirror' ? <label className="mt-2 flex items-center gap-2 text-xs">
          <input name="sharedsessionview-input-2" type="checkbox" checked={deliveryMode === 'mirror'} disabled={sending || paused || state.denied}
            onChange={event => setDeliveryMode(event.target.checked ? 'mirror' : 'web-only')} />
          {tr('Forward the original reply to this session’s channel')}
        </label> : null}
        {deliveryMode === 'mirror' && !state.access?.messagesMirror ? <p role="status" className="mt-1 text-xs">{tr("Forwarding access is unavailable. Sending is blocked; uncheck forwarding to send web-only.")}</p> : null}
        <p className="mt-2 text-xs text-slate-500">{tr("Text and images · Running sessions use the queue. Sending requires a current execution grant.")}</p>
        {state.access && !state.access.messagesSend ? <p className="mt-1 text-xs text-slate-500">{tr("Read-only for this access. Sending is not authorized.")}</p> : null}
        {state.access && !state.access.eventsRead ? <p className="mt-1 text-xs text-slate-500">{tr("Live updates are unavailable for this access. Refresh manually to read new messages.")}</p> : null}
        {historyDelayed ? <AdmissionHistoryNotice /> : null}
        {notice ? <p className="mt-2 text-xs" role="status">{translate(notice)}</p> : null}
      </div>
    </footer>
  </main>;
}

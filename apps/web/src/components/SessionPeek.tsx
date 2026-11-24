import React, { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '@agentopsdeck/shared';
import { X } from 'lucide-react';
import { api, recoveryScope, subscribeRecoveryScope } from '../api';
import { sessionPreviewCache, previewKey, previewActivityVersion, PREVIEW_REFRESH_MS } from '../lib/session-preview-cache';
import { displayTitle, writeHashRoute } from '../lib/session-utils';
import { useI18n } from '../lib/i18n';
const LazyQuickSessionMessage = lazy(() => import('./QuickSessionMessage').then(module => ({ default: module.QuickSessionMessage })));
const QuickSessionMessage = (props: React.ComponentProps<typeof LazyQuickSessionMessage>) => <Suspense fallback={null}><LazyQuickSessionMessage {...props} /></Suspense>;
import { currentSessionCardDrag } from '../lib/session-card-drag';
import { isSessionVisible, subscribeVisibleSessions } from '../lib/visible-sessions';

export const SESSION_COMPLETED_EVENT = 'agentopsdeck:session-completed-preview';
const HOVER_PREVIEW_EVENT = 'agentopsdeck:session-hover-preview';
type Completion = { key: string; tag: string; session?: SessionSummary };
function warmPreview(scope: string | undefined, key: string, force = false, priority = false, activityVersion?: string) {
  if (!scope || scope !== recoveryScope() || document.visibilityState === 'hidden' || !navigator.onLine) return Promise.resolve();
  return sessionPreviewCache.load(previewKey(scope, key), async signal => {
    const result = await api.sessionMessages(key, 8, signal);
    return result.messages;
  }, force, priority, activityVersion);
}

/** Only actually visible cards prefetch. One bounded cache limits all callers
 * to two concurrent reads; hidden tabs/offline clients do not start reads. */
function usePreviewPrefetch(anchor: React.RefObject<HTMLDivElement | null>, session: SessionSummary) {
  const scope = useSyncExternalStore(subscribeRecoveryScope, recoveryScope);
  const activity = useRef(previewActivityVersion(session));
  activity.current = previewActivityVersion(session);
  useEffect(() => {
    if (!scope || !anchor.current || window.innerWidth < 700 || !matchMedia('(hover: hover)').matches) return;
    let visible = false, timer: ReturnType<typeof setTimeout> | undefined;
    const key = previewKey(scope, session.sessionKey);
    const tick = () => {
      // Mounted chat reads seed this cache already. Do not run a second
      // history lane for the same docked/floating session.
      if (visible && !isSessionVisible(session.sessionKey)) void warmPreview(scope, session.sessionKey, false, false, activity.current);
    };
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      clearTimeout(timer);
      if (visible) timer = setTimeout(tick, 1200);
      else sessionPreviewCache.cancelQueued(key);
    });
    observer.observe(anchor.current);
    const interval = setInterval(tick, PREVIEW_REFRESH_MS);
    const resume = () => {
      if (document.visibilityState === 'hidden') sessionPreviewCache.cancelQueued(key);
      else tick();
    };
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', tick);
    return () => { clearTimeout(timer); clearInterval(interval); observer.disconnect(); sessionPreviewCache.cancelQueued(key);
      document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', tick); };
  }, [anchor, scope, session.sessionKey]);
}

function SessionPeek({ session, completion = false, onClose, onBusyChange, style }: {
  session: SessionSummary; completion?: boolean; onClose: () => void; onBusyChange: (busy: boolean) => void; style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const scope = useSyncExternalStore(subscribeRecoveryScope, recoveryScope);
  const key = previewKey(scope ?? '', session.sessionKey);
  const subscribe = useCallback((listener: () => void) => sessionPreviewCache.subscribe(key, listener), [key]);
  const snapshot = useSyncExternalStore(subscribe, () => sessionPreviewCache.peek(key));
  const messages = snapshot?.messages ?? [];
  const loading = !snapshot || !!snapshot.loading, error = snapshot?.error;
  const summary = !snapshot?.denied && !messages.length ? session.recent?.slice(0, 3000) : undefined;
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyChange = useCallback((value: boolean) => { setBusy(value); onBusyChange(value); }, [onBusyChange]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    const read = async () => {
      await warmPreview(scope, session.sessionKey, completion || attempt > 0, true);
      // Completion can precede projection. Keep catch-up bounded, but do not
      // bypass failure backoff for automatic follow-up reads.
      if (active && recoveryScope() === scope && completion && ++reads < 3 && !sessionPreviewCache.peek(key)?.error)
        timer = setTimeout(() => void read(), 1500);
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [key, session.sessionKey, completion, attempt, scope]);
  return <section className={`session-peek ${completion ? 'session-peek--completion' : ''}`} style={style} role="dialog" aria-modal="false" aria-label={t(completion ? 'Session finished' : 'Session preview')}
    onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <header><div><small>{t(completion ? 'Session finished' : 'Session preview')}</small><strong>{displayTitle(session)}</strong></div>
      <button type="button" aria-label={t('Close preview')} onClick={onClose}><X size={16} /></button></header>
    <div className="session-peek-messages" aria-busy={loading}>
      {loading && !messages.length && !summary && <p role="status">{t('Reading latest messages…')}</p>}
      {summary && <div className="session-peek-message"><small>{t('Last known summary')}</small><p>{summary}</p></div>}
      {!loading && !error && !messages.length && !summary && <p>{t('No recent messages')}</p>}
      {messages.map(message => <div className={`session-peek-message is-${message.role}`} key={message.id}><small>{t(message.role === 'user' ? 'You' : 'Agent')}</small><p>{String(message.text ?? '')}</p></div>)}
      {error && <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('Preview unavailable · retry')}</button>}
    </div>
    {!session.archived && <QuickSessionMessage inline session={session} onClose={onClose} onAccepted={() => setAttempt(value => value + 1)} onBusyChange={busyChange} />}
    <button type="button" className="session-peek-open" onClick={() => { writeHashRoute({ tab: 'sessions', sessionKey: session.sessionKey }); if (!busy) onClose(); }}>{t('Open session')}</button>
  </section>;
}

/** Portal with delayed hover and a grace corridor. Drafts never disappear on
 * pointer leave; touch devices retain the existing explicit quick-send action. */
export function SessionHoverPreview({ session, children }: { session: SessionSummary; children: ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  usePreviewPrefetch(anchor, session);
  const portal = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => clearTimeout(timer.current);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (busy) clearTimeout(timer.current); }, [busy]);
  useEffect(() => {
    const activate = (event: Event) => {
      if ((event as CustomEvent<string>).detail === session.sessionKey) return;
      clearTimeout(timer.current);
      setVisible(false);
      // Keep a draft/in-flight receipt mounted, but never stack hover panels.
      if (!busy) setOpen(false);
    };
    window.addEventListener(HOVER_PREVIEW_EVENT, activate);
    return () => window.removeEventListener(HOVER_PREVIEW_EVENT, activate);
  }, [session.sessionKey, busy]);
  useEffect(() => { const closeAuth = () => { sessionPreviewCache.clear(); close(); }; window.addEventListener('agentopsdeck:auth-required', closeAuth); return () => window.removeEventListener('agentopsdeck:auth-required', closeAuth); }, [close]);
  const enter = () => {
    clear();
    if (currentSessionCardDrag() || window.innerWidth < 700 || !matchMedia('(hover: hover)').matches || document.querySelector('dialog[open], [role="menu"]')) return;
    void warmPreview(recoveryScope(), session.sessionKey, false, true);
    timer.current = setTimeout(() => {
      // The menu may have opened after hover scheduled this callback.
      if (currentSessionCardDrag() || document.querySelector('dialog[open], [role="menu"]')) return;
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 388)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 560)) });
      window.dispatchEvent(new CustomEvent(HOVER_PREVIEW_EVENT, { detail: session.sessionKey }));
      setVisible(true);
      setOpen(true);
    }, 600);
  };
  const leave = () => { clear(); if (!busy) timer.current = setTimeout(() => { if (!portal.current?.contains(document.activeElement)) close(); }, 400); };
  // Capture precedes the card's stopPropagation. Dismiss all hover panels,
  // including another card's retained draft, without losing in-flight receipts.
  const dismissPreviews = () => window.dispatchEvent(new CustomEvent(HOVER_PREVIEW_EVENT));
  return <><div ref={anchor} onMouseEnter={enter} onMouseLeave={leave} onContextMenuCapture={dismissPreviews} onDragStart={() => { clear(); if (!busy) close(); }}>
    {children}
    </div>
    {open && createPortal(<div ref={portal} hidden={!visible} onMouseEnter={clear} onMouseLeave={leave} onFocusCapture={clear} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) leave(); }}>
      <SessionPeek session={session} style={position} onClose={close} onBusyChange={setBusy} />
    </div>, document.body)}
  </>;
}

function CompletionToast({ item, onClose }: { item: Completion; onClose: () => void }) {
  const [session, setSession] = useState(item.session), [busy, setBusy] = useState(false), [interacting, setInteracting] = useState(false);
  useEffect(() => {
    if (session) return;
    let active = true; const scope = recoveryScope();
    void api.sessionsState().then(result => { if (active && scope === recoveryScope()) setSession(result.groups.flatMap(group => group.sessions).find(row => row.sessionKey === item.key)); }).catch(() => {});
    return () => { active = false; };
  }, [item.key, session]);
  useEffect(() => { if (busy || interacting) return; const timer = setTimeout(onClose, 12_000); return () => clearTimeout(timer); }, [busy, interacting, onClose]);
  if (!session) return null;
  return <div onMouseEnter={() => setInteracting(true)} onMouseLeave={() => setInteracting(false)} onFocusCapture={() => setInteracting(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteracting(false); }}>
    <SessionPeek session={session} completion onClose={onClose} onBusyChange={setBusy} />
  </div>;
}

export function SessionCompletionPreviews({ paused }: { paused: boolean }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Completion[]>([]);
  useEffect(() => {
    if (paused) { setItems([]); sessionPreviewCache.clear(); return; }
    const receive = (event: Event) => { if (document.querySelector('.os-desktop-shell')) return; const item = (event as CustomEvent<Completion>).detail; if (item?.key && item.tag && !isSessionVisible(item.key)) setItems(current => current.some(row => row.tag === item.tag) ? current : [...current.slice(0, 3), ...current.slice(3).slice(-16), item]); };
    const unsubscribe = subscribeVisibleSessions(() => setItems(current => current.some(item => isSessionVisible(item.key)) ? current.filter(item => !isSessionVisible(item.key)) : current));
    const clear = () => { setItems([]); sessionPreviewCache.clear(); };
    window.addEventListener(SESSION_COMPLETED_EVENT, receive); window.addEventListener('agentopsdeck:auth-required', clear);
    return () => { unsubscribe(); window.removeEventListener(SESSION_COMPLETED_EVENT, receive); window.removeEventListener('agentopsdeck:auth-required', clear); };
  }, [paused]);
  // Stable close functions live inside the keyed entry to avoid resetting its expiry.
  return !paused && createPortal(<aside className="session-completion-stack" aria-label={t('Session notifications')}>{items.slice(0, 3).map(item => <CompletionEntry key={item.tag} item={item} remove={setItems} />)}</aside>, document.body);
}
function CompletionEntry({ item, remove }: { item: Completion; remove: React.Dispatch<React.SetStateAction<Completion[]>> }) {
  const close = useCallback(() => remove(current => current.filter(row => row.tag !== item.tag)), [item.tag, remove]);
  return <CompletionToast item={item} onClose={close} />;
}

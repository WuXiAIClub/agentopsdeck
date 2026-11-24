import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Pencil, Plus, Save, Undo2 } from 'lucide-react';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import { CARD_TONES, validCardWrite, type CardContent, type CardDocument, type CardSummary, type CardWrite } from '@agentopsdeck/shared';
import { api, ApiResponseError, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { usePageRefreshGuard } from '../lib/use-page-refresh-guard';
import { useWorkspaceBoardRevision } from '../lib/use-workspace-board-revision';
import { cardContentEqual, cardDraftKey, parseCardDraft, readCachedWorkspaceCard, readCachedWorkspaceCardsCatalog, writeCachedWorkspaceCard, writeCachedWorkspaceCardsCatalog, type CardDraft } from '../lib/workspace-card-draft';

const savedEvent = 'agentopsdeck:metric-card-saved';
const blank: CardContent = { title: '', value: '', detail: '', tone: 'blue', progress: null };
export default function WorkspaceMetricCard({ scope, resourceId, onOpen }: { scope: string; resourceId: string; onOpen: (kind: 'metric-card', id: string) => void }) {
  const { t } = useI18n(), catalog = resourceId === 'catalog', draftKey = cardDraftKey(scope, resourceId);
  const [initialSeed] = useState(() => {
    if (scope !== recoveryScope()) return undefined;
    if (catalog) {
      const cachedCatalog = readCachedWorkspaceCardsCatalog(scope);
      return cachedCatalog ? { catalogHit: true, cards: cachedCatalog } : undefined;
    }
    const cached = readCachedWorkspaceCard(scope, resourceId);
    let local: CardDraft | undefined;
    let storageFailed = false;
    try { local = parseCardDraft(sessionStorage.getItem(draftKey)); } catch { storageFailed = true; }
    if (!cached.hit && !local) return storageFailed ? { storageFailed } : undefined;
    const doc = cached.document;
    const rev = local?.revision ?? doc?.revision ?? 0;
    if (local && (!doc || !cardContentEqual(local.content, doc))) {
      return {
        cardHit: cached.hit,
        document: doc,
        draft: local.content,
        pending: local.pending,
        baseRevision: rev,
        error: (local.pending ? 'uncertain' : cached.hit && local.revision !== (doc?.revision ?? 0) ? 'conflict' : undefined) as 'conflict' | 'uncertain' | undefined,
        storageFailed,
      };
    }
    return {
      cardHit: cached.hit,
      document: doc,
      draft: cached.hit ? (doc ? undefined : { ...blank }) : undefined,
      pending: undefined,
      baseRevision: doc?.revision ?? 0,
      error: undefined,
      storageFailed,
    };
  });
  const [cards, setCards] = useState<CardSummary[]>(() => initialSeed?.cards ?? []), [document, setDocument] = useState<CardDocument | undefined>(() => initialSeed?.document);
  const [catalogLoaded, setCatalogLoaded] = useState(() => !!initialSeed?.catalogHit);
  const [draft, setDraft] = useState<CardContent | undefined>(() => initialSeed?.draft), [busy, setBusy] = useState(false), [error, setError] = useState<'read' | 'conflict' | 'uncertain' | 'rejected' | undefined>(() => initialSeed?.error);
  const [storageError, setStorageError] = useState(() => initialSeed?.storageFailed ?? false);
  usePageRefreshGuard(() => !draft && !busy);
  const baseRevision = useRef(initialSeed?.baseRevision ?? 0);
  const [refresh, setRefresh] = useState(0), [confirmDiscard, setConfirmDiscard] = useState(false);
  const pending = useRef<CardWrite | undefined>(initialSeed?.pending), writing = useRef<AbortController | undefined>(undefined), alive = useRef(false), attempted = useRef(0);
  const { revision, notice } = useWorkspaceBoardRevision(scope, resourceId, 'metric-card');
  const valid = () => alive.current && recoveryScope() === scope;
  const persist = (value?: CardDraft) => {
    try { if (value) sessionStorage.setItem(draftKey, JSON.stringify(value)); else sessionStorage.removeItem(draftKey); setStorageError(false); }
    catch { setStorageError(true); }
  };
  const edit = (value: CardContent) => { setDraft(value); persist({ content: value, revision: baseRevision.current }); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; writing.current?.abort(); }; }, [scope]);
  useEffect(() => {
    if (!draft) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [!!draft]);
  useEffect(() => { if (catalog && notice) setRefresh(v => v + 1); }, [catalog, notice]);
  useEffect(() => {
    if (catalog) return;
    if (draft || busy || revision <= (document?.revision ?? 0) || revision <= attempted.current) return;
    attempted.current = revision; setRefresh(v => v + 1);
  }, [catalog, revision, notice, document, busy, draft]);
  useEffect(() => {
    const changed = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.scope === scope && (catalog || d?.resourceId === resourceId) && !draft) setRefresh(v => v + 1); };
    window.addEventListener(savedEvent, changed); return () => window.removeEventListener(savedEvent, changed);
  }, [scope, resourceId, catalog, draft]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(undefined);
    void (async () => {
      try {
        if (catalog) { const result = await api.workspaceCards(controller.signal); if (!controller.signal.aborted && valid()) { writeCachedWorkspaceCardsCatalog(scope, result.cards); setCards(result.cards); setCatalogLoaded(true); } }
        else {
          let result: CardDocument | undefined;
          try { result = await api.workspaceCard(resourceId, controller.signal); }
          catch (e) { if (!(e instanceof ApiResponseError) || e.status !== 404) throw e; }
          if (controller.signal.aborted || !valid()) return;
          writeCachedWorkspaceCard(scope, resourceId, result);
          let local: CardDraft | undefined;
          try { local = parseCardDraft(sessionStorage.getItem(draftKey)); } catch { setStorageError(true); }
          setDocument(result); baseRevision.current = local?.revision ?? result?.revision ?? 0;
          if (local && (!result || !cardContentEqual(local.content, result))) {
            setDraft(local.content); pending.current = local.pending;
            setError(local.pending ? 'uncertain' : local.revision !== (result?.revision ?? 0) ? 'conflict' : undefined);
          } else {
            pending.current = undefined; persist(); baseRevision.current = result?.revision ?? 0;
            setDraft(result ? undefined : { ...blank });
          }
        }
      } catch (e) {
        if (!controller.signal.aborted && valid()) {
          setError('read');
        }
      } finally { if (!controller.signal.aborted && valid()) setBusy(false); }
    })();
    return () => controller.abort();
  }, [scope, resourceId, refresh]);
  const save = async () => {
    if (!draft || busy || !valid() || writing.current) return;
    const value = pending.current ?? { ...draft, revision: baseRevision.current, mutationId: crypto.randomUUID() };
    if (!validCardWrite(value)) return;
    pending.current = value; persist({ content: draft, revision: value.revision, pending: value });
    const controller = new AbortController(); writing.current = controller; setBusy(true); setError(undefined);
    try {
      const result = await api.saveWorkspaceCard(resourceId, value, controller.signal);
      if (!valid()) return;
      writeCachedWorkspaceCard(scope, resourceId, result);
      pending.current = undefined; persist(); baseRevision.current = result.revision; setDocument(result); setDraft(undefined);
      window.dispatchEvent(new CustomEvent(savedEvent, { detail: { scope, resourceId } }));
    } catch (e) {
      if (valid()) {
        const status = e instanceof ApiResponseError ? e.status : 0;
        if ([400, 401, 403, 404, 409, 413, 429].includes(status)) {
          pending.current = undefined; persist({ content: draft, revision: value.revision });
          setError(status === 409 ? 'conflict' : 'rejected');
        } else setError('uncertain');
      }
    }
    finally { writing.current = undefined; if (valid()) setBusy(false); }
  };
  const discard = () => { pending.current = undefined; persist(); setDraft(undefined); setConfirmDiscard(false); setRefresh(v => v + 1); };
  const content = draft ?? document, frozen = busy || !!pending.current;
  return <section className="workspace-metric-card" data-tone={content?.tone ?? 'neutral'} aria-label={t('Custom status card')} aria-busy={busy}>
    <ResourceTitle>{catalog ? t('Custom status cards') : content?.title || t('New status card')}</ResourceTitle>
    <ResourceToolbar>
      <ResourceAction label={t('Refresh')} disabled={busy || !!draft} onClick={() => setRefresh(v => v + 1)}><RefreshCw size={15} /></ResourceAction>
      {!catalog && document && !draft && <ResourceAction label={t('Edit')} onClick={() => { const { title, value, detail, tone, progress } = document; edit({ title, value, detail, tone, progress }); }}><Pencil size={15} /></ResourceAction>}
      {catalog && <ResourceAction label={t('New status card')} disabled={busy || cards.length >= 64} onClick={() => onOpen('metric-card', crypto.randomUUID())}><Plus size={15} /></ResourceAction>}
      {draft && <><ResourceAction label={t(pending.current ? 'Retry same save' : 'Save card')} disabled={busy || error === 'conflict' || !draft.title.trim()} onClick={() => void save()}><Save size={15} /></ResourceAction><ResourceAction label={t('Discard changes')} disabled={busy} onClick={() => setConfirmDiscard(true)}><Undo2 size={15} /></ResourceAction></>}
    </ResourceToolbar>
    {catalog ? <ul>{cards.map(card => <li key={card.resourceId}><button type="button" data-tone={card.tone} onClick={() => onOpen('metric-card', card.resourceId)}>{card.title}</button></li>)}</ul> : draft ? <>
      <fieldset disabled={frozen}>
        <label>{t('Card title')}<input name="workspacemetriccard-input-1" aria-label={t('Card title')} value={draft.title} maxLength={120} onChange={e => edit({ ...draft, title: e.target.value })} /></label>
        <label>{t('Card value')}<input name="workspacemetriccard-input-2" aria-label={t('Card value')} value={draft.value} maxLength={160} onChange={e => edit({ ...draft, value: e.target.value })} /></label>
        <label>{t('Card description')}<textarea name="workspacemetriccard-textarea-3" aria-label={t('Card description')} value={draft.detail} maxLength={4000} onChange={e => edit({ ...draft, detail: e.target.value })} /></label>
        <div className="metric-card-tones" role="group" aria-label={t('Card color')}>{CARD_TONES.map(tone => <button type="button" key={tone} data-tone={tone} aria-pressed={draft.tone === tone} onClick={() => edit({ ...draft, tone })}>{t(tone === 'neutral' ? 'Neutral' : tone === 'blue' ? 'Blue' : tone === 'green' ? 'Green' : tone === 'yellow' ? 'Yellow' : tone === 'red' ? 'Red' : 'Purple')}</button>)}</div>
        <label><input name="workspacemetriccard-input-4" type="checkbox" checked={draft.progress !== null} onChange={e => edit({ ...draft, progress: e.target.checked ? 0 : null })} />{t('Show progress')}</label>
        {draft.progress !== null && <label>{t('Progress')}<input name="workspacemetriccard-input-5" aria-label={t('Progress')} type="range" min={0} max={100} value={draft.progress} onChange={e => edit({ ...draft, progress: Number(e.target.value) })} /><output>{draft.progress}%</output></label>}
      </fieldset>
      {confirmDiscard && <div role="alert" className="metric-card-notice"><p>{t('Discard this draft and load the saved card?')}</p><button type="button" onClick={discard}>{t('Discard and reload')}</button><button type="button" onClick={() => setConfirmDiscard(false)}>{t('Keep editing')}</button></div>}
      {revision > (document?.revision ?? 0) && <p role="status">{t('This card changed elsewhere. Your draft is preserved.')}</p>}
    </> : document ? <div className="metric-card-display"><p className="metric-card-value">{document.value}</p><p className="metric-card-detail">{document.detail}</p>{document.progress !== null && <><progress aria-label={t('Progress')} max={100} value={document.progress} /><output>{document.progress}%</output></>}</div> : null}
    {busy && (catalog ? !catalogLoaded : !content) && <p role="status">{t('Loading…')}</p>}
    {storageError && <p role="alert">{t('Local draft storage unavailable. Keep this panel open until saved.')}</p>}
    {error && <p role="alert">{t(error === 'conflict' ? 'This card changed elsewhere. Your draft is preserved.' : error === 'uncertain' ? 'Save is unconfirmed. Retry the same save or reload; no automatic resend.' : error === 'rejected' ? 'Card save was rejected. Your draft is preserved.' : 'Card unavailable. Retry refresh.')}</p>}
  </section>;
}

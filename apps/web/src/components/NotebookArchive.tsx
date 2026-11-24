import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NOTEBOOK_ARCHIVE_MAX_CHARS } from '@agentopsdeck/shared';
import { api, recoveryScope, recoveryEpoch } from '../api';
import type { NotebookController } from '../lib/session-notebook';
import { useI18n } from '../lib/i18n';
import { useFileCardGuard } from '../lib/workspace-file-card-context';
import { useNotebookController } from './SessionNotebook';
import NotebookFileSync from './NotebookFileSync';
import type { NotebookArchiveSelection } from '../lib/notebook-selection';

/** Code, data and draft are loaded only after an explicit first open. */
export default function NotebookArchive({ sessionKey, id = 'default', paused, hotController, selection, onSelectionHandled, onBusyChange }: {
  sessionKey?: string; id?: string; paused: boolean; hotController: NotebookController;
  selection?: NotebookArchiveSelection | undefined; onSelectionHandled: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n(), scope = recoveryScope();
  const controller = useNotebookController(JSON.stringify(['archive', sessionKey === undefined ? 'hub' : 'session', sessionKey ?? id]), {
    read: () => api.notebookArchive(sessionKey, id), write: value => api.saveNotebookArchive(sessionKey, id, value),
    storage: () => sessionStorage, key: `agentopsdeck.notebook-archive-draft:${JSON.stringify([scope, sessionKey ?? null, id])}`,
    maxChars: NOTEBOOK_ARCHIVE_MAX_CHARS,
  });
  const state = useSyncExternalStore(controller.subscribe, controller.get);
  const hot = useSyncExternalStore(hotController.subscribe, hotController.get);
  const [area, setArea] = useState<'hot' | 'cold'>('hot'), [range, setRange] = useState({ start: 0, end: 0 });
  const receiptKey = `agentopsdeck.notebook-move:${JSON.stringify([scope, sessionKey ?? null, id])}`;
  const [busy, setBusy] = useState(false), lock = useRef(false), [pending, setPending] = useState<string | undefined>(() => {
    try { return sessionStorage.getItem(receiptKey) ?? undefined; } catch { return undefined; }
  });
  const remember = (requestId?: string) => {
    if (requestId) sessionStorage.setItem(receiptKey, requestId); else sessionStorage.removeItem(receiptKey);
    setPending(requestId);
  };
  const [message, setMessage] = useState(''), [query, setQuery] = useState(''), [includeArchive, setIncludeArchive] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof api.searchNotebook>>['results']>([]);
  const preview = useRef<HTMLTextAreaElement>(null);
  const epoch = recoveryEpoch();
  const live = useRef({ paused, onBusyChange }); live.current = { paused, onBusyChange };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange(busy || !!pending); }, [busy, pending, onBusyChange]);
  const current = () => mounted.current && !live.current.paused && recoveryScope() === scope && recoveryEpoch() === epoch;
  const move = async (selectedRange = range, selectedArea = area, expectedSource?: string) => {
    if (lock.current || paused || pending || controller.dirty()) { setMessage(t('Save pending edits before moving text.')); return; }
    lock.current = true; setBusy(true); onBusyChange(true); setMessage('');
    try {
      // Wait for the original save, never delete the local selection first.
      if (expectedSource !== undefined) { await hotController.settled(); await hotController.flush(); }
      const freshHot = hotController.get(), freshCold = controller.get();
      const hotDoc = freshHot.document, coldDoc = freshCold.document;
      const source = selectedArea === 'hot' ? freshHot.text : freshCold.text;
      if (!current() || !hotDoc || !coldDoc || freshHot.phase !== 'ready' || freshCold.phase !== 'ready' ||
          hotController.dirty() || controller.dirty() || (expectedSource !== undefined && source !== expectedSource) ||
          selectedRange.start < 0 || selectedRange.end > source.length || selectedRange.end <= selectedRange.start || selectedRange.end - selectedRange.start > 16000) {
        if (current()) setMessage(t('Notebook changed elsewhere')); return;
      }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.slice(selectedRange.start, selectedRange.end)));
      if (!current()) return;
      // Edits, reconciliation or a resource switch during hashing invalidate
      // the snapshot; the server additionally checks both exact revisions.
      if (hotController.get() !== freshHot || controller.get() !== freshCold || hotController.dirty() || controller.dirty()) {
        setMessage(t('Notebook changed elsewhere')); return;
      }
      const requestId = crypto.randomUUID(); remember(requestId);
      await api.moveNotebook(sessionKey, id, { requestId, hotRevision: hotDoc.revision, coldRevision: coldDoc.revision,
        direction: selectedArea === 'hot' ? 'archive' : 'restore', ranges: [{ ...selectedRange, sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') }] });
      if (!current()) return;
      remember(); setRange({ start: 0, end: 0 }); setResults([]); setMessage(t('Move completed'));
      await Promise.all([hotController.reconcile(), controller.reconcile()]);
    } catch (error) {
      if (!current()) return;
      // A definite HTTP rejection cannot have committed. Network failures keep
      // the original UUID for read-only reconciliation, never auto-resend.
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 409) {
        try { remember(); } catch { /* Keep original UUID if browser storage failed. */ }
        setMessage(error instanceof Error ? error.message : t('Notebook changed elsewhere'));
      } else setMessage(t('Move not confirmed. Check the original receipt; do not repeat the move.'));
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selection || handled.current === selection.requestId) return;
    if (!paused && ['closed', 'loading'].includes(state.phase)) return;
    handled.current = selection.requestId; onSelectionHandled();
    if (selection.scope !== scope || selection.epoch !== epoch || selection.resourceId !== hotController.get().document?.resourceId) {
      setMessage(t('Notebook changed elsewhere')); return;
    }
    if (paused || pending || state.phase !== 'ready') { setMessage(t('Save pending edits before moving text.')); return; }
    setArea('hot'); setRange({ start: selection.start, end: selection.end });
    void move({ start: selection.start, end: selection.end }, 'hot', selection.source);
  }, [selection, paused, pending, state.phase]);
  const receipt = async () => {
    if (!pending || lock.current || paused) return;
    lock.current = true; setBusy(true); onBusyChange(true);
    try {
      await api.notebookMoveReceipt(sessionKey, id, pending);
      if (!current()) return;
      remember(); setRange({ start: 0, end: 0 }); setMessage(t('Move completed'));
      await Promise.all([hotController.reconcile(), controller.reconcile()]);
    } catch (error) {
      if (current()) {
        if ((error as { status?: number }).status === 409) {
          try { remember(); } catch { /* Preserve recovery if storage failed. */ }
          setMessage(t('Notebook changed elsewhere'));
        } else setMessage(t('Move not confirmed. Check the original receipt; do not repeat the move.'));
      }
    }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { if (!paused && controller.get().phase === 'closed') void controller.load(); }, [controller, paused]);
  useFileCardGuard(() => !lock.current && !pending && !controller.dirty() && !hotController.dirty() && state.phase === 'ready' && hot.phase === 'ready');
  const disabled = paused || busy || !!pending || !state.document || state.phase === 'loading' || state.phase === 'conflict';
  return <section className="notebook-archive" aria-label={t('Notebook archive')}>
    <NotebookFileSync sessionKey={sessionKey} id={id} paused={paused || busy || !!pending}
      ready={() => !controller.dirty() && !hotController.dirty() && state.phase === 'ready' && hot.phase === 'ready'}
      onChanged={() => { void controller.reconcile(); void hotController.reconcile(); }} />
    <details><summary>{t('Move or search notebook text')}</summary>
      <label><input name="notebookarchive-input-1" type="checkbox" checked={area === 'cold'} onChange={e => { setArea(e.target.checked ? 'cold' : 'hot'); setRange({ start: 0, end: 0 }); }} />{t('Restore from archive')}</label>
      <p>{t('Select up to 16000 characters below. Save pending edits first. Linked file notebooks require coordinated projection.')}</p>
      <textarea name="notebookarchive-textarea-2" ref={preview} readOnly aria-label={t('Select text to move')} value={area === 'hot' ? hot.text : state.text}
        onSelect={e => setRange({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })} />
      <button type="button" disabled={paused || busy || !!pending || controller.dirty() || hotController.dirty() || state.phase !== 'ready' || hot.phase !== 'ready' || range.end <= range.start || range.end - range.start > 16000} onClick={() => void move()}>{t(area === 'hot' ? 'Archive selected text' : 'Restore selected text')}</button>
      <form onSubmit={async e => { e.preventDefault(); if (paused || lock.current || !query.trim()) return; lock.current = true; setBusy(true);
        try { const found = await api.searchNotebook(sessionKey, id, query, includeArchive); if (current()) setResults(found.results); }
        catch { if (current()) setMessage(t('Notebook unavailable · retrying automatically')); }
        finally { lock.current = false; if (current()) setBusy(false); } }}>
        <input name="notebookarchive-input-3" aria-label={t('Search notebook text')} value={query} maxLength={200} onChange={e => setQuery(e.target.value)} />
        <label><input name="notebookarchive-input-4" type="checkbox" checked={includeArchive} onChange={e => setIncludeArchive(e.target.checked)} />{t('Include cold archive')}</label>
        <button type="submit" disabled={paused || busy || !query.trim()}>{t('Search notebook text')}</button>
      </form>
      <ul>{results.map(row => <li key={`${row.area}:${row.start}`}><button type="button" onClick={() => {
        const doc = row.area === 'hot' ? hot.document : state.document;
        if (!doc || doc.revision !== row.revision || (row.area === 'hot' ? hotController : controller).dirty()) { setMessage(t('Notebook changed elsewhere')); return; }
        setArea(row.area); setRange({ start: row.start, end: row.end });
        requestAnimationFrame(() => { preview.current?.focus(); preview.current?.setSelectionRange(row.start, row.end); });
      }}>{t(row.area === 'hot' ? 'Global notes' : 'Notebook archive')}: {row.text}</button></li>)}</ul>
    </details>
    {message && <p role="status">{message}</p>}
    {pending && <button type="button" disabled={paused || busy} onClick={() => void receipt()}>{t('Check original receipt')}</button>}
    <textarea name="notebookarchive-textarea-5" aria-label={t('Notebook archive')} value={state.text} maxLength={NOTEBOOK_ARCHIVE_MAX_CHARS} disabled={disabled}
      onChange={event => controller.edit(event.target.value)} onBlur={() => void controller.flush()} />
    <span role="status">{state.phase === 'loading' || state.phase === 'closed' ? t('Loading notebook…') : state.phase === 'error' ? t('Notebook unavailable · retrying automatically') : state.phase === 'conflict' ? t('Notebook changed elsewhere') : state.phase === 'saving' ? t('Saving…') : controller.dirty() ? t('Unsaved changes') : t('Saved')}</span>
    <span>{t('{count} / {limit} characters', { count: state.text.length.toLocaleString(), limit: NOTEBOOK_ARCHIVE_MAX_CHARS.toLocaleString() })}</span>
    {state.phase === 'error' && <button type="button" onClick={() => void controller.retry()}>{t('Retry')}</button>}
    {state.phase === 'conflict' && state.remote && <div role="alert">
      <p>{t('Another tab saved this note. Compare before choosing which version to keep.')}</p>
      <details><summary>{t('View saved version')}</summary><pre>{state.remote.text}</pre></details>
      <button type="button" onClick={() => controller.resolve(false)}>{t('Use saved version')}</button>
      {state.remote.resourceId === state.document?.resourceId && <button type="button" onClick={() => controller.resolve(true)}>{t('Save my draft instead')}</button>}
    </div>}
    {state.localUnavailable && <p role="alert">{t('Local draft backup unavailable. Keep this page open until saved.')}</p>}
  </section>;
}

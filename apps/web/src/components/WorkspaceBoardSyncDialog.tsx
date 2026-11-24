import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { parseFileBoardIntent, type FileBoardBinding } from '../lib/workspace-file-board';
import WorkspaceFileBoardBinding from './WorkspaceFileBoardBinding';
import './workspace-file-card.css';

type Source = { resource: string; card: boolean; enabled: boolean; binding: FileBoardBinding | null; pending: boolean };
/** One entry for both generations of board sync. Inspect first; never migrate or replay. */
export default function WorkspaceBoardSyncDialog({ scope, id, initialSession, onClose }: {
  scope: string; id: string; initialSession?: string | undefined; onClose(): void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  const [generation, refresh] = useState(0), [error, setError] = useState(false);
  const [state, setState] = useState<{ title: string; revision: number; sources: Source[] }>();
  const [choice, choose] = useState<string>();
  useLayoutEffect(() => {
    const previous = window.document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useLayoutEffect(() => {
    // Unlink/cancel removes the focused action. Keep keyboard users inside the
    // modal so Escape/Tab continue to work after that state transition.
    if (dialog.current && !dialog.current.contains(window.document.activeElement)) dialog.current.focus();
  }, [state, choice]);
  useEffect(() => {
    const abort = new AbortController(); setState(undefined); setError(false); choose(undefined);
    const sources = [{ resource: id, card: false }, ...(['taskboard', 'statuscard'] as const).map(kind => ({ resource: workspaceFileCardResource(kind, id), card: true }))];
    void Promise.all([api.workspaceBoard(id, abort.signal), Promise.all(sources.map(async source => {
      const result = await (source.card ? api.fileCardBinding : api.fileBoardBinding)(source.resource, abort.signal);
      const raw = sessionStorage.getItem(JSON.stringify([source.card ? 'agentopsdeck.file-card-intent' : 'agentopsdeck.file-board-intent', scope, source.resource]));
      if (raw !== null && !parseFileBoardIntent(raw)) throw Error('Invalid pending binding');
      return { ...source, enabled: result.enabled, binding: result.binding, pending: raw !== null };
    }))]).then(([board, candidates]) => {
      if (abort.signal.aborted || scope !== recoveryScope()) return;
      const existing = candidates.filter(source => source.binding || source.pending);
      const selected = existing.length ? existing : [candidates.find(source => source.enabled) ?? candidates[0]!];
      setState({ title: board.title, revision: board.revision, sources: selected });
      if (selected.length === 1) choose(selected[0]!.resource);
    }).catch(() => { if (!abort.signal.aborted && scope === recoveryScope()) setError(true); });
    return () => abort.abort();
  }, [scope, id, generation]);
  const selected = state?.sources.find(source => source.resource === choice);
  return <div className="workspace-file-card-backdrop" onPointerDown={event => event.stopPropagation()} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="workspace-file-card-dialog" role="dialog" aria-modal="true" aria-label={t('Card file sync')} tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)') ?? [])];
      const first = nodes[0], last = nodes.at(-1), active = window.document.activeElement;
      if (active === dialog.current || !dialog.current?.contains(active) || event.shiftKey && active === first || !event.shiftKey && active === last) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    }}>
      <header><strong>{t('Card file sync')}</strong><button type="button" aria-label={t('Close')} onClick={onClose}>×</button></header>
      {state && <p>{state.title} · {t('Revision')} {state.revision}</p>}
      {!state && !error && <p role="status">{t('Loading…')}</p>}
      {error && <><p role="alert">{t('Unable to inspect existing sync links. Nothing was changed. Refresh before linking.')}</p><button type="button" onClick={() => refresh(value => value + 1)}>{t('Refresh')}</button></>}
      {state && state.sources.length > 1 && <div role="group" aria-label={t('Existing sync requests')}>
        <p>{t('Several existing sync records need inspection. Select one to manage; no new link will be created automatically.')}</p>
        {state.sources.map((source, index) => <button type="button" key={source.resource} aria-pressed={source.resource === choice} onClick={() => choose(source.resource)}>
          {index + 1} · {source.card ? 'card.json' : 'tasks.json'} · {t(source.pending ? 'Binding outcome pending · inspect without resending' : 'Manage card link')}
        </button>)}
      </div>}
      {selected && state && <WorkspaceFileBoardBinding key={`${generation}:${selected.resource}`} embedded card={selected.card} scope={scope} resourceId={selected.resource}
        revision={state.revision} initialSession={initialSession} dirty={false} onClose={onClose} onChanged={binding => {
          // Keep the selected controller mounted: an unlink/cancel may have a
          // remote-cleanup notice that must survive the metadata update.
          setState(previous => previous && { ...previous, sources: previous.sources.map(source =>
            source.resource === selected.resource ? { ...source, binding, pending: false } : source) });
        }} />}
    </div>
  </div>;
}

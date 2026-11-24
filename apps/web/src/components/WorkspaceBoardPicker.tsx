import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutDashboard, Plus, X } from 'lucide-react';
import type { BoardSummary } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';

export type OpenBoardResource = (kind: 'taskboard' | 'statuscard', resourceId: string) => void;
/** Fetch the small catalog only when opened; not one subscription per panel. */
export function WorkspaceBoardPicker({ scope, onOpen, labeled = false, disabled = false }: { scope: string; onOpen: OpenBoardResource; labeled?: boolean; disabled?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [retry, setRetry] = useState(0);
  const [boards, setBoards] = useState<BoardSummary[]>(), [error, setError] = useState(false);
  const [query, setQuery] = useState(''), [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.workspaceBoard>>>();
  const [previewError, setPreviewError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const abort = new AbortController(); let live = true;
    setBoards(undefined); setError(false);
    void api.workspaceBoards(abort.signal).then(result => {
      if (live && scope === recoveryScope()) setBoards(result.boards);
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; abort.abort(); };
  }, [open, retry, scope]);
  useEffect(() => {
    setPreview(undefined); setPreviewError(false);
    if (!open || !selected) return;
    const abort = new AbortController();
    void api.workspaceBoard(selected, abort.signal).then(value => {
      if (!abort.signal.aborted && scope === recoveryScope()) setPreview(value);
    }).catch(() => { if (!abort.signal.aborted) setPreviewError(true); });
    return () => abort.abort();
  }, [open, selected, scope, retry]);
  const choose = (id: string) => {
    if (scope !== recoveryScope()) return;
    setOpen(false); onOpen('taskboard', id);
  };
  return <>
    <button type="button" className={labeled ? 'workspace-labeled-tool' : undefined} data-caption-priority={90} disabled={disabled} aria-label={t('Task boards')} title={t('Task boards')} onClick={() => { setQuery(''); setSelected(''); setOpen(true); }}><LayoutDashboard size={15} />{labeled && <span>{t('Task boards')}</span>}</button>
    {open && createPortal(<dialog ref={dialog} className="workspace-board-picker" aria-label={t('Task boards')} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <header><h2>{t('Task boards')}</h2><button type="button" aria-label={t('Close')} onClick={() => setOpen(false)}><X size={16} /></button></header>
      <p>{t('Find a saved board by name, then preview its tasks and open it in this layout. No ID is needed.')}</p>
      <label className="workspace-board-search">{t('Search task boards')}<input name="workspaceboardpicker-input-1" autoFocus type="search" value={query} onChange={event => { setQuery(event.target.value); setSelected(''); }} placeholder={t('Board name')} /></label>
      <div className="workspace-board-picker-list">
        {error ? <p role="alert">{t('Unable to load task board. Retry refresh.')}<button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></p>
          : !boards ? <p role="status">{t('Loading…')}</p> : boards.filter(board => board.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(board => <button key={board.resourceId} type="button" aria-pressed={selected === board.resourceId} onClick={() => setSelected(board.resourceId)}>
            <strong>{board.title}</strong><small>{t('To do')} {board.counts.todo} · {t('In progress')} {board.counts.doing} · {t('Done')} {board.counts.done}</small>
            <small>{board.updatedAt ? t('Updated: {time}', { time: new Date(board.updatedAt).toLocaleString() }) : t('Not saved yet')}</small>
          </button>)}
        {boards && !boards.some(board => board.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p role="status">{t('No matching task boards')}</p>}
      </div>
      {selected && <section className="workspace-board-preview" aria-label={t('Task preview')}>
        {previewError ? <p role="alert">{t('Unable to load task board. Retry refresh.')}<button type="button" onClick={() => setRetry(value => value + 1)}>{t('Retry')}</button></p> : !preview || preview.resourceId !== selected ? <p role="status">{t('Loading…')}</p> : <>
          <strong>{preview.title}</strong>
          <ul>{[...preview.tasks.filter(task => task.status !== 'done'), ...preview.tasks.filter(task => task.status === 'done')].slice(0, 4).map(task => <li key={task.id}>{task.title}</li>)}</ul>
          {!preview.tasks.length && <p>{t('This board has no tasks yet.')}</p>}
          <button type="button" onClick={() => choose(selected)}>{t('Open in current layout')}</button>
        </>}
      </section>}
      <footer><button type="button" disabled={!boards || boards.filter(board => board.revision > 0).length >= 64} onClick={() => choose(crypto.randomUUID())}><Plus size={15} />{t('New task board')}</button></footer>
    </dialog>, document.body)}
  </>;
}

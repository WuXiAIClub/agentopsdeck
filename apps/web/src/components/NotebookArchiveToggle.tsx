import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { archiveShare, DEFAULT_ARCHIVE_SHARE, dragArchiveShare } from '../lib/notebook-archive-split';

/** One presentation-only divider for native and shared notebooks.
 * Opening is lazy; closing preserves the mounted editor and its unsaved draft. */
export default function NotebookArchiveToggle({ children, openRequest }: { children: ReactNode; openRequest?: string | undefined }) {
  const { t } = useI18n(), id = useId();
  const [opened, setOpened] = useState(false), [mounted, setMounted] = useState(false);
  const [share, setShare] = useState(DEFAULT_ARCHIVE_SHARE), [dragging, setDragging] = useState(false);
  const panel = useRef<HTMLDetailsElement>(null);
  const drag = useRef<{ pointerId: number; y: number; height: number; share: number } | null>(null);
  const finish = () => { drag.current = null; setDragging(false); };
  useEffect(() => {
    if (!openRequest || !panel.current) return;
    panel.current.open = true; setOpened(true); setMounted(true);
  }, [openRequest]);
  return <>
    {opened && <button type="button" className={`notebook-archive-divider${dragging ? ' is-dragging' : ''}`}
      role="separator" aria-label={t('Resize notebook archive')} aria-orientation="horizontal"
      aria-controls={id} aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(share)}
      title={t('Drag to resize · arrow keys also work')}
      onPointerDown={event => {
        if (event.button !== 0 || !panel.current?.parentElement) return;
        const height = panel.current.parentElement.clientHeight;
        if (!height) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, y: event.clientY, height, share }; setDragging(true);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.pointerId === event.pointerId) setShare(dragArchiveShare(start.share, event.clientY - start.y, start.height));
      }}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { finish(); event.currentTarget.releasePointerCapture(event.pointerId); } }}
      onPointerCancel={finish} onLostPointerCapture={finish}
      onKeyDown={event => {
        const step = event.shiftKey ? 10 : 5;
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        setShare(value => event.key === 'Home' ? 15 : event.key === 'End' ? 85 : archiveShare(value + (event.key === 'ArrowUp' ? step : -step)));
      }}><span aria-hidden="true" /></button>}
    <details ref={panel} id={id} className="notebook-archive-toggle" style={{ '--notebook-archive-share': `${share}%` } as CSSProperties}
      onToggle={event => { const next = event.currentTarget.open; setOpened(next); if (next) setMounted(true); else finish(); }}>
      <summary>{t('Notebook archive')}</summary>
      {mounted && <div className="notebook-archive-content">{children}</div>}
    </details>
  </>;
}

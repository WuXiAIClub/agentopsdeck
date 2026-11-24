import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, FileText, SlidersHorizontal, X } from 'lucide-react';
import { applyContextMenuPosition } from '../lib/context-menu-position';
import { useI18n } from '../lib/i18n';

/** Native top layer escapes the board scroller without duplicating task data or reads. */
export function TaskCard({ title, detail, dragging, grip, children, metadata, autoEdit = false, onAutoEdit, onComplete, actionsDisabled = false }: { title: string; detail: string; dragging: boolean; grip: ReactNode; children: ReactNode; metadata?: ReactNode; autoEdit?: boolean; onAutoEdit?: () => void; onComplete?: () => void; actionsDisabled?: boolean }) {
  const { t } = useI18n(), id = useId();
  const [mode, setMode] = useState<'menu' | 'edit' | null>(autoEdit ? 'edit' : null);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const selectInitialTitle = useRef(autoEdit);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = () => { setMode(null); setMenuPoint(null); };
  const dismiss = () => { close(); trigger.current?.focus({ preventScroll: true }); };
  // Consume the creation request so moving columns or restoring a draft cannot reopen it.
  useEffect(() => { if (autoEdit) onAutoEdit?.(); }, [autoEdit, onAutoEdit]);
  useEffect(() => { if (dragging) { setMode(null); setMenuPoint(null); } }, [dragging]);
  useLayoutEffect(() => {
    const node = panel.current, anchor = trigger.current;
    if (!mode || !node || !anchor) return;
    node.showPopover();
    const place = () => {
      if (mode === 'menu' && menuPoint) {
        applyContextMenuPosition(node, menuPoint);
        return;
      }
      const rect = anchor.getBoundingClientRect(), box = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
      const below = rect.bottom + 6;
      node.style.top = `${Math.max(8, Math.min(below + box.height <= innerHeight - 8 ? below : rect.top - box.height - 6, innerHeight - box.height - 8))}px`;
      node.style.transformOrigin = 'top left';
    };
    place();
    if (mode === 'edit') {
      const input = node.querySelector<HTMLInputElement>('input');
      input?.focus({ preventScroll: true });
      if (selectInitialTitle.current) { input?.select(); selectInitialTitle.current = false; }
    }
    if (mode === 'menu') node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) { setMode(null); setMenuPoint(null); } };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } };
    const observer = new ResizeObserver(place); observer.observe(node); observer.observe(anchor);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [mode, menuPoint]);
  return <div ref={root} className="workspace-task-card"
    onContextMenu={event => {
      if (dragging || panel.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation();
      setMenuPoint({ x: event.clientX, y: event.clientY });
      setMode('menu');
    }}
    onKeyDown={event => {
      if (!dragging && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') && !panel.current?.contains(event.target as Node)) {
        event.preventDefault(); event.stopPropagation();
        setMenuPoint(null);
        setMode('menu');
      }
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <div className="workspace-board-task-heading">
      {grip}
      <button ref={trigger} type="button" className="workspace-task-summary" aria-label={title} aria-haspopup="dialog" aria-expanded={mode === 'edit'}
        onClick={() => { if (!dragging) { setMenuPoint(null); setMode('edit'); } }}><span>{title || t('New task')}</span>{detail && <FileText size={13} aria-hidden="true" />}</button>
    </div>
    {metadata}
    {mode && <div ref={panel} id={id} popover="manual" role={mode === 'edit' ? 'dialog' : 'menu'} aria-label={t(mode === 'edit' ? 'Task details' : 'Task actions')}
      className="workspace-task-popover" data-mode={mode} onKeyDown={event => {
        if (mode !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
      {mode === 'menu' ? <>
        <div className="workspace-task-menu-head" aria-hidden="true">{title || t('New task')}</div>
        {onComplete && <button type="button" role="menuitem" disabled={actionsDisabled} onClick={() => { close(); onComplete(); }}><CheckCircle2 size={14} aria-hidden="true" /><span>{t('Mark task complete')}</span></button>}
        <button type="button" role="menuitem" onClick={() => { setMenuPoint(null); setMode('edit'); }}><SlidersHorizontal size={14} aria-hidden="true" /><span>{t('Edit task properties')}</span></button>
      </> : <>
        <header><span>{t('Task details')}</span><button type="button" aria-label={t('Close')} onClick={dismiss}><X size={15} /></button></header>
        {children}
      </>}
    </div>}
  </div>;
}

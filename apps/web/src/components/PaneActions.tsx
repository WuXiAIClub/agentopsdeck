import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/** The same controls stay mounted across breakpoints. Native top-layer popover
 * escapes pane clipping without reparenting notebook/share controllers. */
export function PaneActions({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const pane = content.current?.closest('[data-workspace-pane]') ?? content.current?.closest('[data-font-area="chat"]');
    if (!pane) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 800);
    });
    observer.observe(pane); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element || !narrow) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      if (!element.matches(':popover-open')) return;
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const height = element.offsetHeight;
      element.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, rect.right - 272))}px`;
      element.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 6))}px`;
    };
    const schedule = () => { if (!frame && element.matches(':popover-open')) frame = requestAnimationFrame(place); };
    const toggle = () => {
      cancelAnimationFrame(frame); frame = 0;
      window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
      if (!element.matches(':popover-open')) return;
      place();
      window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    };
    element.addEventListener('toggle', toggle);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('toggle', toggle);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      element.style.removeProperty('left'); element.style.removeProperty('top');
    };
  }, [narrow]);
  return <div className="pane-secondary-actions" data-narrow={narrow}>
    {narrow && <button ref={trigger} type="button" popoverTarget={id} aria-label={t('Pane tools')} title={t('Pane tools')} className="desktop-chat-toolbar-control pane-tools-trigger"><MoreHorizontal size={16} /></button>}
    <div ref={content} id={id} popover={narrow ? 'auto' : undefined} className="pane-tools-content" aria-label={t('Pane tools')}>{children}</div>
  </div>;
}

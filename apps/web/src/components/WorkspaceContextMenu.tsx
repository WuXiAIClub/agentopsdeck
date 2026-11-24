import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { applyContextMenuPosition, handleContextMenuKeyDown } from '../lib/context-menu-position';
import { useI18n } from '../lib/i18n';

/** Top-layer menu is independent of pane clipping and floating z-order. */
export function WorkspaceContextMenu({ point, close, children, label = 'Workspace actions' }: { point: { x: number; y: number }; close: () => void; children: ReactNode; label?: 'Workspace actions' | 'Task actions' }) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useLayoutEffect(() => {
    const node = ref.current!;
    node.showPopover();
    const reposition = () => {
      applyContextMenuPosition(node, point);
    };
    reposition();
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    // Contextmenu can fire between pointerdown/up. Native auto-popover light
    // dismissal treats that opening gesture as an outside click and closes it.
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !node.contains(event.target)) close(); };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null;
    observer?.observe(node);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('agentopsdeck:auth-required', close);
    return () => {
      observer?.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('agentopsdeck:auth-required', close);
    };
  }, [point, close]);
  return createPortal(<div ref={ref} popover="manual" className="workspace-context-menu" role={label === 'Task actions' ? 'menu' : undefined} aria-label={t(label)}
    onToggle={event => { if (event.newState === 'closed') close(); }} onContextMenu={event => event.preventDefault()}
    onClick={event => { if ((event.target as HTMLElement).closest('button:not(:disabled)')) close(); }}
    onKeyDown={event => handleContextMenuKeyDown(event, close)}>{children}</div>, document.body);
}

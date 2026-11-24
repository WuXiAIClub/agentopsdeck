import { useLayoutEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePaneTitleTarget, usePaneToolbarTarget } from './PaneToolbar';
import './resource-cards.css';

/** Only controls enter the caption. Editors, streams and media keep their owner
 * and DOM identity. Standalone pages/dialogs retain a local toolbar. */
export function ResourceToolbar({ children, local = false }: { children: ReactNode; local?: boolean }) {
  const target = usePaneToolbarTarget();
  const content = <div className="resource-card-tools">{children}</div>;
  return target && !local ? createPortal(content, target) : <header className="resource-card-toolbar">{content}</header>;
}

export function ResourceTitle({ children }: { children: ReactNode }) {
  const target = usePaneTitleTarget();
  useLayoutEffect(() => {
    target?.dispatchEvent(new Event('captionchange', { bubbles: true }));
  }, [target, children]);
  const content = typeof children === 'string' ? <h2 className="resource-card-heading">{children}</h2> : children;
  return target ? createPortal(content, target) : <div className="resource-card-title">{content}</div>;
}

export function ResourceAction({ label, priority = 50, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; priority?: number }) {
  return <button type="button" {...props} data-caption-priority={priority} aria-label={label} title={label}>{children}</button>;
}

import { useRef, useState, type ReactNode } from 'react';
import { AnchoredPanel } from './AnchoredPanel';
import { useI18n, type TranslationKey } from '../lib/i18n';

export function PaneStatus({ label, state, children }: { label: TranslationKey; state: string; children: ReactNode }) {
  const { t } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={anchor} type="button" data-caption-priority={110} className="pane-status-indicator" data-state={state} title={t(label)} aria-label={t('Session status')} aria-expanded={open} onClick={() => setOpen(!open)}>
      <i aria-hidden="true" /><span>{t(label)}</span>
    </button>
    <AnchoredPanel open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('Session status')}>{children}</AnchoredPanel>
  </>;
}

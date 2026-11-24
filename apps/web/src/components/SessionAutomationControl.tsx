import { lazy, Suspense, useState } from 'react';
import { Timer } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { CaptionIconButton } from './CaptionIconButton';
const Panel = lazy(() => import('./SessionAutomationPanel'));
export function SessionAutomationControl({ sessionKey }: { sessionKey: string }) {
  const { t } = useI18n(), [open, setOpen] = useState(false);
  return <><CaptionIconButton priority={60} label={t('Bounded automation')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Timer size={15} aria-hidden="true" /></CaptionIconButton>
    {open && <Suspense fallback={<span role="status">{t('Loading…')}</span>}><Panel key={sessionKey} sessionKey={sessionKey} close={() => setOpen(false)} /></Suspense>}</>;
}

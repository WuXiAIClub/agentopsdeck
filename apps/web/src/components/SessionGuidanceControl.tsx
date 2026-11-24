import { lazy, Suspense, useState } from 'react';
import { BookOpenCheck } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { CaptionIconButton } from './CaptionIconButton';
const Panel = lazy(() => import('./SessionGuidancePanel'));
export function SessionGuidanceControl({ sessionKey }: { sessionKey: string }) {
  const { t } = useI18n(), [open, setOpen] = useState(false);
  return <><CaptionIconButton priority={65} label={t('Fixed session guidance')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><BookOpenCheck size={15} aria-hidden="true" /></CaptionIconButton>
    {open && <Suspense fallback={<span role="status">{t('Loading…')}</span>}><Panel key={sessionKey} sessionKey={sessionKey} close={() => setOpen(false)} /></Suspense>}</>;
}

import { lazy, Suspense, useState } from 'react';
import { Target } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { CaptionIconButton } from './CaptionIconButton';

const GoalPanel = lazy(() => import('./SessionGoalPanel'));

export function SessionGoalControl({ sessionKey }: { sessionKey: string }) {
  const { t } = useI18n(), [open, setOpen] = useState(false);
  return <><CaptionIconButton priority={75} label={t('Manage Codex Goal')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Target size={15} aria-hidden="true" /></CaptionIconButton>
    {open ? <Suspense fallback={<span role="status">{t('Loading…')}</span>}><GoalPanel key={sessionKey} sessionKey={sessionKey} close={() => setOpen(false)} /></Suspense> : null}</>;
}

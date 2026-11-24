import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { recoveryScope, sessionInteractionReads, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { CaptionIconButton } from './CaptionIconButton';
import './SessionInteractions.css';

const InteractionPanel = lazy(() => import('./SessionInteractionsPanel'));

export function SessionInteractions({ sessionKey }: { sessionKey: string }) {
  const { t } = useI18n();
  const scope = useSyncExternalStore(subscribeRecoveryScope, recoveryScope) ?? '';
  const subscribe = useCallback((notify: () => void) => scope ? sessionInteractionReads.subscribe(scope, sessionKey, notify) : () => {}, [scope, sessionKey]);
  const snapshot = useCallback(() => sessionInteractionReads.snapshot(scope, sessionKey), [scope, sessionKey]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [scope, sessionKey]);
  const pending = state.data?.requests.filter(r => r.status === 'pending').length ?? 0;
  return <><CaptionIconButton priority={pending ? 110 : 60} data-interaction-session={sessionKey} className={`session-interactions-trigger${pending ? ' has-pending' : ''}`}
    label={t(pending ? 'Agent needs your response' : 'Agent interactions')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
    <MessageCircleQuestion size={14} aria-hidden="true" />{pending ? <span className="interaction-count">{pending}</span> : null}
  </CaptionIconButton>
    {open ? <Suspense fallback={<span role="status">{t('Loading…')}</span>}><InteractionPanel key={`${scope}:${sessionKey}`} scope={scope} sessionKey={sessionKey} state={state} close={() => setOpen(false)} /></Suspense> : null}</>;
}

import { useState } from 'react';
import { recoveryScope } from '../api';
import { messageRetryCache, resendUnknownMessage } from '../lib/message-submission';
import { useI18n } from '../lib/i18n';
import { confirmAction } from './ui/confirm';

export function ResendMessage({ sessionKey, commandKey }: { sessionKey: string; commandKey: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const scope = recoveryScope(), available = !!scope && !!messageRetryCache.get(scope, sessionKey, commandKey);
  return <span className="message-resend-control"><button type="button" disabled={busy || !available}
    title={!available ? t('Original message is no longer available in this tab. Copy it into the composer to send again.') : undefined}
    onClick={async (event) => {
      const pane = event.currentTarget.closest<HTMLElement>('[data-workspace-pane]');
      setBusy(true); setNotice('');
      try {
        const result = await resendUnknownMessage(sessionKey, commandKey, () => confirmAction({ title: t('Send again?'), description: t('The original delivery is still unconfirmed. Resending creates a new message and may execute the task twice. The original server receipt is kept.'), confirmLabel: t('Resend message') }));
        if (result === 'recovered') setNotice(t('Message accepted; no duplicate sent.'));
      } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
      finally {
        setBusy(false);
        if (pane?.isConnected) {
          delete pane.dataset.composerReading;
          delete pane.dataset.composerCollapsed;
          pane.dataset.hoverComposer = 'true';
          pane.querySelector<HTMLTextAreaElement>('.desktop-composer-textarea')?.focus({ preventScroll: true });
        }
      }
    }}>{t(busy ? 'Checking original receipt…' : 'Resend message')}</button>{notice && <span role="status">{notice}</span>}</span>;
}

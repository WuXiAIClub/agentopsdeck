import { useState } from 'react';
import { useI18n, type TranslationKey } from '../lib/i18n.js';

/** Details stay available without displacing the transcript with an HTTP banner. */
export function HistorySyncIssue({ label, detail, onRetry }: { label: TranslationKey; detail?: string | undefined; onRetry: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  return <details className="history-sync-issue">
    <summary aria-label={t(label)}><span aria-hidden="true">!</span> {t(label)}</summary>
    <div className="history-sync-detail">
      <p>{t('Existing messages are kept. Retrying sync does not resend messages.')}</p>
      {label === 'History sync interrupted'
        ? <p>{t('This history warning alone does not mean the Goal or live updates have stopped.')}</p>
        : null}
      {(retryError ?? detail) && <pre>{retryError ?? detail}</pre>}
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setRetryError(undefined);
        try { await onRetry(); } catch (error) { setRetryError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
      }}>{t(busy ? 'Retrying…' : 'Retry')}</button>
    </div>
  </details>;
}

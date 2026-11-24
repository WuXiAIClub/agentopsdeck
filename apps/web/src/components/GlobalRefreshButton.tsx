import { useRef, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { pageRefreshGate } from '../lib/page-refresh';
import { useI18n } from '../lib/i18n';
import { confirmAction } from './ui/confirm';

export function GlobalRefreshButton() {
  const { t } = useI18n();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  async function refresh() {
    if (pending.current) return;
    setBlocked(false);
    if (!pageRefreshGate.ready()) { setBlocked(true); return; }
    pending.current = true; setBusy(true);
    try {
      const confirmed = await confirmAction({ title: t('Refresh and release resources'),
        description: t('Reload this page to release its memory, connections and previews. Saved drafts, notebooks, layouts and sign-in are retained. Agent tasks are not restarted.'),
        confirmLabel: t('Refresh') });
      if (!confirmed) return;
      // A save, recording or send may have started while the modal was open.
      if (!pageRefreshGate.ready()) { setBlocked(true); return; }
      window.location.reload();
    } finally { pending.current = false; setBusy(false); }
  }
  return <>
    <button type="button" className="global-refresh-button" disabled={busy} onClick={() => void refresh()}
      aria-label={t('Refresh and release resources')} title={t('Refresh and release resources')}><RefreshCcw size={17} /></button>
    {blocked ? <div className="global-refresh-blocked" role="status">
      <p>{t('Finish saving, sending, recording or attaching files, and close active terminals before refreshing. Nothing has been cleared.')}</p>
      <button type="button" onClick={() => setBlocked(false)}>{t('Close')}</button>
    </div> : null}
  </>;
}

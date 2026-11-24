import { useEffect, useState } from 'react';
import { api, recoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { websiteBrowserVisit } from '../lib/workspace-website';

/** Mounted only after explicit opt-in; no polling, auto-renewal, saved URLs or
 * credential forwarding. Parent keys by scope/target to prevent frame reuse. */
export default function WorkspaceWebsiteBrowser({ scope, connectionId, serviceId }: { scope: string; connectionId: string; serviceId: string }) {
  const { t } = useI18n();
  const [url, setUrl] = useState(''), [state, setState] = useState<'loading' | 'ready' | 'expired' | 'error'>('loading');
  useEffect(() => {
    const controller = new AbortController();
    let accessId = '', closed = false, expiry: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !controller.signal.aborted && recoveryScope() === scope;
    const close = () => {
      if (accessId && !closed && recoveryScope() === scope) {
        closed = true; void api.websiteAccessClose(connectionId, accessId).catch(() => {});
      }
    };
    void (async () => {
      try {
        if (!valid()) return;
        const lease = await api.websiteAccessOpen(connectionId, serviceId, controller.signal) as { accessId?: unknown; serviceId?: unknown };
        if (!lease || typeof lease.accessId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(lease.accessId) || lease.serviceId !== serviceId) throw Error('Invalid access');
        accessId = lease.accessId;
        if (!valid()) { close(); return; }
        const started = performance.now();
        const response = await api.websiteAccessBrowser(connectionId, accessId, controller.signal);
        if (!valid()) { close(); return; }
        const visit = websiteBrowserVisit(response, window.location.origin);
        const remaining = visit.expiresInMs - (performance.now() - started);
        if (remaining <= 0) throw Error('Expired visit');
        setUrl(visit.url); setState('ready');
        expiry = setTimeout(() => { setUrl(''); setState('expired'); close(); }, remaining);
      } catch {
        close();
        if (valid()) { setUrl(''); setState('error'); }
      }
    })();
    return () => { controller.abort(); clearTimeout(expiry); close(); };
  }, [scope, connectionId, serviceId]);
  if (recoveryScope() !== scope) return null;
  return <>
    <p className="workspace-website-description">{t('Interactive preview · trusted sites only · GET access · expires within 5 minutes')}</p>
    {state === 'loading' && <p role="status">{t('Opening isolated website…')}</p>}
    {state === 'expired' && <p role="status">{t('Website access expired. Return to the snapshot and reopen to continue.')}</p>}
    {state === 'error' && <p role="alert">{t('Interactive preview unavailable. Requires an isolated gateway, browse-enabled site and websites:browse permission.')}</p>}
    {url && state === 'ready' && <iframe title={t('Interactive website preview')} sandbox="allow-scripts" referrerPolicy="no-referrer" src={url} />}
  </>;
}

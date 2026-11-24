import { useEffect, useMemo, useState } from 'react';
import { Globe, RefreshCw, BookOpen, Camera, SlidersHorizontal } from 'lucide-react';
import { ResourceAction, ResourceTitle, ResourceToolbar } from './ResourceToolbar';
import { validWebsiteCatalog, validWebsiteSnapshot, type ConnectorWebsite, type WebsiteSnapshot } from '@agentopsdeck/shared';
import { api, ApiResponseError, recoveryScope, type HubConnection } from '../api';
import { useI18n } from '../lib/i18n';
import { websitePaneTarget, websiteSnapshotDocument } from '../lib/workspace-website';
import WorkspaceWebsiteBrowser from './WorkspaceWebsiteBrowser';
import WorkspaceWebsiteReader from './WorkspaceWebsiteReader';
import WorkspaceWebsiteActions from './WorkspaceWebsiteActions';
import { useFileCardSettings } from '../lib/workspace-file-card-context';

function errorKey(error: unknown) {
  if (error instanceof ApiResponseError) {
    if (error.status === 409) return 'Configure AOD_WEBSITES_JSON on this Connector to enable website snapshots.';
    if (error.status === 403) return 'Website access denied. Ask the Connector operator to grant websites:read.';
    if (error.status === 404) return 'Website unavailable. Check the service catalog and Connector version.';
    if (error.status === 429) return 'Website reader is busy. Retry when another read finishes.';
  }
  return 'Could not read the website. Redirects, unsupported content and large pages are rejected.';
}

export default function WorkspaceWebsite({ scope, resourceId, onOpen }: { scope: string; resourceId: string; onOpen: (kind: 'website', id: string) => void }) {
  const { t } = useI18n();
  const [appliedTarget, setAppliedTarget] = useState<string>();
  const target = useMemo(() => websitePaneTarget(appliedTarget ?? resourceId), [resourceId, appliedTarget]);
  const [connections, setConnections] = useState<HubConnection[]>([]);
  const [connection, setConnection] = useState('');
  const [services, setServices] = useState<ConnectorWebsite[]>([]);
  const [snapshot, setSnapshot] = useState<WebsiteSnapshot>();
  const [srcdoc, setSrcdoc] = useState('');
  const [reading, setReading] = useState(false), [snapshotKey, setSnapshotKey] = useState('');
  const [browserTarget, setBrowserTarget] = useState('');
  const [actionsOpen, setActionsOpen] = useState(false);
  const interactive = Boolean(target && browserTarget === `${scope}:${resourceId}`);
  const [busy, setBusy] = useState(false), [error, setError] = useState<ReturnType<typeof errorKey> | ''>(''), [reload, setReload] = useState(0);
  useFileCardSettings('website', { title: snapshot?.label || t('Connector website · Preview'), connectionId: target?.[0] ?? connection, websiteId: target?.[1] ?? '' }, value => {
    setBrowserTarget(''); setReading(false); setActionsOpen(false);
    setAppliedTarget(value.websiteId ? JSON.stringify([value.connectionId, value.websiteId]) : 'catalog');
    setConnection(value.connectionId); setReload(value => value + 1);
  }, !busy && !interactive);
  useEffect(() => {
    const controller = new AbortController();
    const valid = () => !controller.signal.aborted && recoveryScope() === scope;
    if (!valid()) return () => controller.abort();
    if (interactive) { setBusy(false); return () => controller.abort(); }
    setBusy(true); setError(''); setSnapshot(undefined); setSrcdoc(''); setServices([]);
    void (async () => {
      try {
        if (target) {
          const result = await api.websiteSnapshot(target[0], target[1], controller.signal);
          if (!valid()) return;
          if (!validWebsiteSnapshot(result, target[1])) throw Error('Invalid snapshot');
          const safeDocument = websiteSnapshotDocument(result.content, result.format, document);
          if (valid()) { setSnapshot(result); setSrcdoc(safeDocument); setSnapshotKey(`${scope}:${resourceId}:${reload}`); }
        } else if (connection) {
          const result = await api.websiteCatalog(connection, controller.signal);
          if (!valid()) return;
          if (!validWebsiteCatalog(result)) throw Error('Invalid catalog');
          setServices(result.services);
        } else {
          const result = await api.websiteConnections(controller.signal);
          if (valid()) setConnections(result.connections.filter(item => item.status !== 'disabled'));
        }
      } catch (err) { if (valid()) setError(errorKey(err)); }
      finally { if (valid()) setBusy(false); }
    })();
    return () => controller.abort();
  }, [scope, target, resourceId, connection, reload, interactive]);
  const valid = recoveryScope() === scope;
  const current = snapshotKey === `${scope}:${resourceId}:${reload}`;
  return <section className="workspace-website" aria-label={t('Connector website · Preview')}>
    <ResourceTitle>{current && snapshot?.label || t('Connector website · Preview')}</ResourceTitle>
    <ResourceToolbar>
      {!target && <select name="workspacewebsite-select-1" aria-label={t('Choose a Connector')} value={connection} disabled={!valid || busy} onChange={event => { setError(''); setServices([]); setConnection(event.target.value); }}>
        <option value="">{t('Choose a Connector')}</option>{connections.map(item => <option key={item.id} value={item.id}>{item.environmentLabel || item.label}</option>)}
      </select>}
      {target && !interactive && <ResourceAction label={reading ? t('Snapshot view') : t('Reading view')} disabled={!valid || !current || !snapshot} aria-pressed={reading} onClick={() => setReading(value => !value)}>{reading ? <Camera size={15}/> : <BookOpen size={15}/>}</ResourceAction>}
      {target && <ResourceAction label={interactive ? t('Return to snapshot') : t('Open interactive preview')} disabled={!valid} aria-pressed={interactive} onClick={() => setBrowserTarget(interactive ? '' : `${scope}:${resourceId}`)}><Globe size={15}/></ResourceAction>}
      {target && <ResourceAction label={t('Controlled website actions')} disabled={!valid} aria-pressed={actionsOpen} onClick={() => setActionsOpen(value => !value)}><SlidersHorizontal size={15}/></ResourceAction>}
      {!interactive && <ResourceAction label={t('Refresh website snapshot')} disabled={busy || !valid} onClick={() => setReload(v => v + 1)}><RefreshCw size={15} /></ResourceAction>}
    </ResourceToolbar>
    {!interactive && <p className="workspace-website-description">{t('Read-only snapshot · no scripts, login or background refresh')}</p>}
    {actionsOpen && target && valid && <WorkspaceWebsiteActions key={`${scope}:${resourceId}`} scope={scope} connectionId={target[0]} serviceId={target[1]} />}
    {interactive && target && valid && <WorkspaceWebsiteBrowser key={`${scope}:${resourceId}`} scope={scope} connectionId={target[0]} serviceId={target[1]} />}
    {!interactive && busy && <p role="status">{t('Reading website snapshot…')}</p>}
    {!interactive && error && <div role="alert"><p>{t(error)}</p><button type="button" disabled={busy || !valid} onClick={() => setReload(v => v + 1)}>{t('Retry')}</button></div>}
    {!target && !busy && !error && <ul>{services.map(service => <li key={service.id}><button type="button" disabled={!valid} onClick={() => onOpen('website', JSON.stringify([connection, service.id]))}><Globe size={14} />{service.label}</button></li>)}</ul>}
    {!interactive && snapshot && srcdoc && valid && current && <><p className="workspace-website-time">{t('Snapshot captured')}: {new Date(snapshot.fetchedAt).toLocaleTimeString()}</p>
      {reading && target ? <WorkspaceWebsiteReader key={snapshotKey} scope={scope} snapshot={snapshot} connectionId={target[0]} />
        : <iframe title={t('Isolated website snapshot')} sandbox="" referrerPolicy="no-referrer" srcDoc={srcdoc} />}</>}
  </section>;
}

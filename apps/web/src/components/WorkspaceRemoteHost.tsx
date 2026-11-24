import { useEffect, useMemo, useRef, useState } from 'react';
import { remoteCatalogKey, remoteTelemetryKey, type RemoteCommand, type RemoteDevice, type RemoteOutcome, type RemoteSnapshot } from '@agentopsdeck/shared';
import { api, ApiResponseError } from '../api';
import { useI18n } from '../lib/i18n';
import { useViewportPopover } from '../lib/layout-popover';
import { buildQrSvgPath, encodeQrMatrix } from '../lib/qr-svg';

function normalizeSnapshot(snapshot: RemoteSnapshot, legacyOnly = false): RemoteSnapshot {
  const cleanName = (snapshot.name || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 80) || 'Desktop';
  const seen = new Set<string>();
  const targets: RemoteSnapshot['targets'] = [];
  for (const raw of snapshot.targets || []) {
    const id = (raw?.id || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 160);
    const title = (raw?.title || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 160);
    const kind = raw?.kind === 'notebook' ? 'notebook' : raw?.kind === 'session' ? 'session' : null;
    if (!id || !title || !kind || seen.has(id) || targets.length >= 64) continue;
    seen.add(id);
    if (legacyOnly) {
      targets.push({ id, title, kind });
    } else {
      const cleanSnippet = typeof raw.snippet === 'string'
        ? raw.snippet.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 160)
        : '';
      targets.push({
        id,
        title,
        kind,
        ...(raw.status ? { status: raw.status } : {}),
        ...(typeof raw.unread === 'boolean' && raw.unread ? { unread: true } : {}),
        ...(typeof raw.elapsedSec === 'number' && Number.isFinite(raw.elapsedSec) && raw.elapsedSec >= 0 ? { elapsedSec: Math.min(864000, Math.floor(raw.elapsedSec)) } : {}),
        ...(cleanSnippet ? { snippet: cleanSnippet } : {}),
        ...(typeof raw.tokens === 'number' && Number.isFinite(raw.tokens) && raw.tokens >= 0 ? { tokens: Math.min(1_000_000_000, Math.floor(raw.tokens)) } : {}),
      });
    }
  }
  const active = snapshot.active && seen.has(snapshot.active) ? snapshot.active : null;
  return {
    name: cleanName,
    targets,
    active,
  };
}

export default function WorkspaceRemoteHost({ snapshot, execute }: { snapshot: Omit<RemoteSnapshot, 'name'>; execute: (command: RemoteCommand) => RemoteOutcome | Promise<RemoteOutcome> }) {
  const { t } = useI18n();
  const [name, setName] = useState('Desktop');
  const [enabled, setEnabled] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useViewportPopover(open, summaryRef, popoverRef);
  const legacyModeRef = useRef(false);
  const latest = useRef(normalizeSnapshot({ ...snapshot, name }, legacyModeRef.current));
  latest.current = normalizeSnapshot({ ...snapshot, name }, legacyModeRef.current);
  const handler = useRef(execute); handler.current = execute;
  const host = useRef<{ device: RemoteDevice; hostToken: string; snapshot: string; syncing: boolean; controller: AbortController } | undefined>(undefined);
  const snapshotKey = remoteTelemetryKey(latest.current);

  useEffect(() => {
    if (!enabled) { setDeviceId(''); return; }
    const controller = new AbortController(); let id: string | undefined;
    setError(false); setReady(false);
    const disconnect = () => { controller.abort(); setReady(false); setEnabled(false); setDeviceId(''); };
    window.addEventListener('agentopsdeck:auth-required', disconnect);
    window.addEventListener('pagehide', disconnect);
    void (async () => {
      let initial = normalizeSnapshot(latest.current, legacyModeRef.current);
      let connection: { device: RemoteDevice; hostToken: string };
      try {
        connection = await api.remoteEnable(initial, controller.signal);
      } catch (err) {
        if (err instanceof ApiResponseError && err.status === 400 && !legacyModeRef.current) {
          legacyModeRef.current = true;
          initial = normalizeSnapshot(latest.current, true);
          latest.current = initial;
          connection = await api.remoteEnable(initial, controller.signal);
        } else {
          throw err;
        }
      }
      id = connection.device.id;
      if (controller.signal.aborted) { await api.remoteDisable(id).catch(() => {}); return; }
      host.current = { ...connection, snapshot: remoteTelemetryKey(initial), syncing: false, controller };
      setDeviceId(id);
      setReady(true);
      while (!controller.signal.aborted) {
        const started = performance.now();
        const { command } = await api.remoteReceive(id, connection.hostToken, controller.signal);
        if (!command || controller.signal.aborted) continue;
        // If the local catalog changed before its update reached the Hub, reject
        // stale inputs rather than sending text to the newly focused pane.
        const fresh = command.validForMs > Math.max(0, performance.now() - started - command.waitedMs) + 150;
        const result = fresh && host.current && remoteCatalogKey(host.current.device) === remoteCatalogKey(latest.current) && command.revision === host.current.device.revision
          ? await handler.current(command) : 'unavailable';
        try { await api.remoteAck(id, connection.hostToken, command.id, result, controller.signal); }
        catch (error) {
          // The phone may already have timed out. Keep the mailbox alive, but
          // never replay the delivered command or reinterpret its outcome.
          if (!(error instanceof ApiResponseError && error.status === 409 && error.message === 'remote_command_expired')) throw error;
        }
      }
    })().catch(() => { if (!controller.signal.aborted) setError(true); }).finally(() => {
      if (!controller.signal.aborted) { setReady(false); setEnabled(false); setDeviceId(''); }
      if (id) void api.remoteDisable(id).catch(() => {});
    });
    return () => { controller.abort(); host.current = undefined; window.removeEventListener('agentopsdeck:auth-required', disconnect); window.removeEventListener('pagehide', disconnect);
      if (id) void api.remoteDisable(id).catch(() => {}); };
  }, [enabled]);

  useEffect(() => {
    const connection = host.current;
    if (!ready || !connection || connection.snapshot === snapshotKey) return;
    const timer = setTimeout(() => {
      if (connection.syncing || connection.controller.signal.aborted) return;
      connection.syncing = true;
      void (async () => {
        while (host.current === connection && !connection.controller.signal.aborted && connection.snapshot !== remoteTelemetryKey(latest.current)) {
          let next = normalizeSnapshot(latest.current, legacyModeRef.current);
          let device: RemoteDevice;
          try {
            device = await api.remoteUpdate(connection.device.id, connection.hostToken, next, connection.controller.signal);
          } catch (err) {
            if (err instanceof ApiResponseError && err.status === 400 && !legacyModeRef.current) {
              legacyModeRef.current = true;
              next = normalizeSnapshot(latest.current, true);
              latest.current = next;
              device = await api.remoteUpdate(connection.device.id, connection.hostToken, next, connection.controller.signal);
            } else {
              throw err;
            }
          }
          if (host.current === connection && !connection.controller.signal.aborted) { connection.device = device; connection.snapshot = remoteTelemetryKey(next); }
        }
      })().catch(() => { if (!connection.controller.signal.aborted) { setError(true); setEnabled(false); } }).finally(() => { connection.syncing = false; });
    }, 120);
    return () => clearTimeout(timer);
  }, [snapshotKey, ready]);

  const remoteHref = useMemo(() => {
    const base = typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '';
    return deviceId ? `${base}#/remote?device=${encodeURIComponent(deviceId)}&mode=warroom` : '#/remote';
  }, [deviceId]);

  const qrSvg = useMemo(() => {
    if (!ready || !deviceId || !showQr) return null;
    try {
      return buildQrSvgPath(encodeQrMatrix(remoteHref));
    } catch {
      return null;
    }
  }, [ready, deviceId, remoteHref, showQr]);

  useEffect(() => {
    const closeOnOutsideDown = (event: PointerEvent) => {
      const el = detailsRef.current;
      if (!el?.open) return;
      if (event.target instanceof Node && !el.contains(event.target)) {
        el.open = false;
      }
    };
    window.addEventListener('pointerdown', closeOnOutsideDown, true);
    return () => window.removeEventListener('pointerdown', closeOnOutsideDown, true);
  }, []);

  return <details ref={detailsRef} className="workspace-remote-host" onToggle={e => setOpen(e.currentTarget.open)}><summary ref={summaryRef} aria-label={t('Phone remote')}>{t('Phone remote')}</summary><div ref={popoverRef}>
    <label>{t('Device name')}<input name="workspaceremotehost-input-1" value={name} maxLength={80} disabled={enabled} onChange={e => setName(e.target.value)} /></label>
    <p>{t('Your phone can focus panels, transfer drafts, and explicitly send messages to open sessions.')}</p>
    <button type="button" disabled={!name.trim()} onClick={() => setEnabled(v => !v)}>{t(enabled ? 'Disable remote control' : 'Enable remote control')}</button>
    <p role="status">{error ? t('Remote disconnected. Enable again to reconnect; inputs are not replayed.') : enabled ? t(ready ? 'Remote ready' : 'Connecting…') : t('Remote control is off')}</p>
    {ready && deviceId && (
      <div className="workspace-remote-qr-box" data-testid="workspace-remote-qr">
        <div className="workspace-remote-qr-header">
          <span>{t('Scan for Tactical Mini-Dashboard')}</span>
          <button type="button" className="workspace-remote-qr-toggle" onClick={() => setShowQr(v => !v)}>
            {t(showQr ? 'Hide QR' : 'Show QR')}
          </button>
        </div>
        {qrSvg && (
          <svg
            className="workspace-remote-qr-svg"
            viewBox={`0 0 ${qrSvg.size} ${qrSvg.size}`}
            role="img"
            aria-label={t('Phone remote QR code')}
          >
            <rect width={qrSvg.size} height={qrSvg.size} fill="#ffffff" rx="1.5" />
            <path d={qrSvg.path} fill="#0f172a" />
          </svg>
        )}
      </div>
    )}
    <a href={ deviceId ? `#/remote?device=${encodeURIComponent(deviceId)}&mode=warroom` : '#/remote' } target="_blank" rel="noopener noreferrer">{t('Open phone remote')}</a>
  </div></details>;
}

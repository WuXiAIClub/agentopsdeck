import { useEffect, useRef, useMemo, useSyncExternalStore } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { api, recoveryScope } from '../api';
import { LayoutSync } from '../lib/layout-sync';
import { useI18n } from '../lib/i18n';

export type UseLayoutSyncOptions = {
  enabled?: boolean | undefined;
  paused?: boolean | undefined;
  debounceMs?: number | undefined;
  equivalent?: ((a: string, b: string) => boolean) | undefined;
  merge?: ((input: { local: string; remote: string; base: string | null | undefined; initialBoot: boolean }) => string | null) | undefined;
};

export function useLayoutSync(
  kind: 'current' | 'saved',
  scope: string | undefined,
  value: string,
  apply: (value: string) => boolean,
  options?: UseLayoutSyncOptions,
) {
  const enabled = options?.enabled !== false;
  const paused = options?.paused === true;
  const applyRef = useRef(apply); applyRef.current = apply;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const equivalentRef = useRef(options?.equivalent); equivalentRef.current = options?.equivalent;
  const mergeRef = useRef(options?.merge); mergeRef.current = options?.merge;
  const pendingKey = scope ? `agentopsdeck:layout-sync-pending:${scope}:${kind}` : undefined;
  const sync = useMemo(() => new LayoutSync(value, {
    load: signal => api.workspaceLayouts(kind, signal),
    save: (doc, signal) => api.saveWorkspaceLayouts(kind, doc, signal),
    current: () => enabledRef.current && !!scope && scope === recoveryScope(),
    apply: next => applyRef.current(next),
    visible: () => document.visibilityState !== 'hidden',
    debounceMs: options?.debounceMs,
    equivalent: (a, b) => Boolean(equivalentRef.current?.(a, b)),
    merge: input => mergeRef.current ? mergeRef.current(input) : null,
    pending: () => {
      try {
        const raw = pendingKey && localStorage.getItem(pendingKey);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw);
        return parsed === null || (Number.isSafeInteger(parsed?.revision) && parsed.revision >= 0 && (parsed.content === null || typeof parsed.content === 'string')) ? parsed : null;
      } catch { return undefined; }
    },
    checkpoint: base => {
      if (!pendingKey || scope !== recoveryScope()) return;
      try { if (base === undefined) localStorage.removeItem(pendingKey); else localStorage.setItem(pendingKey, JSON.stringify(base)); } catch { /* Existing local layout remains usable. */ }
    },
  }), [scope, kind, options?.debounceMs]);
  useEffect(() => {
    if (!enabled) {
      sync.stop();
      return;
    }
    let lastFocus = Date.now();
    const focus = () => { if (Date.now() - lastFocus > 30_000) { lastFocus = Date.now(); sync.retry(); } };
    const visibility = () => { if (document.visibilityState !== 'hidden') { lastFocus = Date.now(); sync.retry(); } };
    sync.start(); window.addEventListener('online', sync.retry); window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => { sync.stop(); window.removeEventListener('online', sync.retry); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visibility); };
  }, [sync, enabled]);
  useEffect(() => {
    if (!enabled || paused) return;
    sync.edit(value);
  }, [sync, value, enabled, paused]);
  return sync;
}
export function LayoutSyncStatus({ sync }: { sync: LayoutSync }) {
  const { t } = useI18n();
  const phase = useSyncExternalStore(sync.subscribe, sync.snapshot);
  const label = t(phase === 'conflict' ? 'Layout changed on another device' : phase === 'offline' ? 'Layout saved locally · sync will retry' : phase === 'saved' ? 'Layout synced to your account' : 'Syncing layout…');
  return <details className="layout-sync-status"><summary title={label} aria-label={label}>{phase === 'offline' || phase === 'conflict' ? <CloudOff size={14} /> : <Cloud size={14} />}</summary>
    <div role="status"><small>{label}</small>{phase === 'conflict' ? <><button type="button" onClick={sync.useRemote}>{t('Use account layout')}</button><button type="button" onClick={sync.keepLocal}>{t('Use this device’s layout')}</button></> : phase === 'offline' ? <button type="button" onClick={sync.retry}>{t('Retry')}</button> : null}</div>
  </details>;
}

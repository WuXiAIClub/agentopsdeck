import { useEffect, useRef, useState } from 'react';
import { api, recoveryEpoch, recoveryScope } from '../api';
import type { SessionWorkspace } from './workspace-layout';
import { partialUnreadCoverage } from './layout-unread-status';
import { layoutUnreadEvents } from './layout-unread-events';
import { isSessionVisible } from './visible-sessions';
import { writeCachedMessages } from './session-cache';
import { automaticHistoryReadSchedule } from './history-read-scheduler';
import { requestGovernor } from './request-governor';
import { selectUnreadSessionsToPreload } from './hot-sessions';
export { selectUnreadSessionsToPreload };

/** One account-scoped reader for all layouts; never one poll per card. Historical
 * and unsupported sessions stay unknown, not falsely reported complete/read. */
export function useLayoutUnread(scope: string | undefined, workspaces: SessionWorkspace[]) {
  const allKeys = [...new Set(workspaces.flatMap(w => w.panes.flatMap(p => p.sessionKey ? [p.sessionKey] : [])))].sort();
  const overflow = allKeys.length > 1024, keys = JSON.stringify(allKeys.slice(0, 1024));
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.completionSummary>>['items']>([]), [unavailable, setUnavailable] = useState(false);
  const [partial, setPartial] = useState(false), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), lock = useRef(false), reload = useRef<() => Promise<void>>(async () => {});
  const preloadedThrough = useRef(new Map<string, number>());
  useEffect(() => {
    const epoch = recoveryEpoch(); let gone = false, reading = false, dirty = false;
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    preloadedThrough.current.clear();
    setRows([]); setUnavailable(false); setPartial(false); setLoading(true);
    const current = () => !gone && recoveryScope() === scope && recoveryEpoch() === epoch;
    const load = async () => {
      if (!scope || !current() || document.hidden || !navigator.onLine) return;
      if (reading) { dirty = true; return; }
      dirty = false;
      reading = true;
      try {
        const sessions: string[] = JSON.parse(keys), result: typeof rows = [];
        for (let i = 0; i < sessions.length; i += 256) {
          if (!current()) return;
          result.push(...(await api.completionSummary(sessions.slice(i, i + 256))).items);
        }
        if (current()) {
          setRows(result);
          setUnavailable(false);
          setPartial(partialUnreadCoverage(sessions, result, overflow));
          const gov = requestGovernor.snapshot();
          const maxPreload = gov.regime === 'boosted' ? 4 : Math.min(3, Math.max(1, gov.effectiveConcurrency));
          if (gov.allowBackgroundPreload) for (const candidate of selectUnreadSessionsToPreload(result, preloadedThrough.current, isSessionVisible, maxPreload)) {
            preloadedThrough.current.set(candidate.sessionKey, candidate.throughSequence);
            void api.sessionMessages(candidate.sessionKey, 200, undefined, undefined, false, automaticHistoryReadSchedule(() => 4)).then(page => {
              if (current() && page.historyStatus !== 'cached') {
                writeCachedMessages(candidate.sessionKey, page.messages, { hiddenCount: page.hiddenCount, updatedAt: page.updatedAt ?? Date.now() });
              }
            }).catch(() => {
              if (preloadedThrough.current.get(candidate.sessionKey) === candidate.throughSequence) {
                preloadedThrough.current.delete(candidate.sessionKey);
              }
            });
          }
        }
      } catch { if (current()) setUnavailable(true); }
      finally {
        reading = false;
        if (current()) { setLoading(false); if (dirty) wake(); }
      }
    };
    const wake = () => {
      clearTimeout(eventTimer);
      const delayMs = Math.max(80, Math.round(120 * requestGovernor.intervalMultiplier()));
      eventTimer = setTimeout(() => { if (current()) void load(); }, delayMs);
    };
    reload.current = load; void load();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const schedulePoll = () => {
      const intervalMs = Math.max(10_000, Math.round(15_000 * requestGovernor.intervalMultiplier()));
      pollTimer = setTimeout(() => { void load(); if (!gone) schedulePoll(); }, intervalMs);
    };
    schedulePoll();
    const stopEvents = scope ? layoutUnreadEvents.subscribe(scope, new Set(JSON.parse(keys) as string[]), wake) : undefined;
    document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => { gone = true; stopEvents?.(); clearTimeout(pollTimer); clearTimeout(eventTimer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); window.removeEventListener('online', wake); };
  }, [scope, keys, overflow]);
  const count = (workspace: SessionWorkspace) => {
    const sessions = new Set(workspace.panes.map(p => p.sessionKey));
    return new Set(rows.filter(row => sessions.has(row.sessionKey) && row.unread).map(row => row.displayTarget)).size;
  };
  const active = (workspace: SessionWorkspace) => workspace.panes.find(p => {
    if (!p.sessionKey) return false;
    const host = [...document.querySelectorAll<HTMLElement>('[data-workspace-pane][data-active="true"]')].find(el => el.dataset.remotePane === p.id);
    if (!host || host.hidden || host.dataset.collapsed === 'true') return false;
    const rect = host.getBoundingClientRect();
    return rect.width > 32 && rect.height > 40 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  })?.sessionKey;
  const markActive = async (workspace: SessionWorkspace) => {
    const sessionKey = active(workspace), epoch = recoveryEpoch();
    const current = () => recoveryScope() === scope && recoveryEpoch() === epoch && !document.hidden && active(workspace) === sessionKey;
    if (!scope || !sessionKey || lock.current || !current()) return;
    lock.current = true; setBusy(true);
    try {
      const proof = await api.observeCompletion(sessionKey);
      if (!current()) return;
      await api.readCompletion(sessionKey, proof.token, proof.throughSequence, crypto.randomUUID());
      if (current()) await reload.current();
    } catch { if (current()) setUnavailable(true); }
    finally { lock.current = false; if (recoveryScope() === scope) setBusy(false); }
  };
  const canMark = (workspace: SessionWorkspace) => {
    // Use the incoming active identity during render, not the previous DOM
    // commit. The mutation still rechecks actual visibility immediately.
    const sessionKey = workspace.panes.find(p => p.id === workspace.active)?.sessionKey;
    return !loading && !unavailable && rows.some(row => row.sessionKey === sessionKey && row.unread);
  };
  return { count, markActive, canMark, busy, unavailable, partial, loading, refresh: () => reload.current() };
}

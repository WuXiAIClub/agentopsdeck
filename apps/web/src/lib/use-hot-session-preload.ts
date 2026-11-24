import { useEffect, useRef } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { api, recoveryEpoch, recoveryScope } from '../api';
import { readCachedMessages, writeCachedMessages } from './session-cache';
import { isSessionVisible } from './visible-sessions';
import { automaticHistoryReadSchedule } from './history-read-scheduler';
import { requestGovernor } from './request-governor';
import { configureHotSessionScopeResolver, rankHotSessionsForPreload } from './hot-sessions';

configureHotSessionScopeResolver(() => recoveryScope() || 'default');

export function useHotSessionPreload(opts: {
  sessions: readonly SessionSummary[];
  activeSessionKey?: string | undefined;
  openSessionKeys?: readonly string[];
  mobile?: boolean;
  limit?: number;
  initialMessageLimit?: number;
}) {
  const preloadedRef = useRef(new Map<string, number>());
  const inflightRef = useRef(new Set<string>());
  const limit = opts.limit ?? (opts.mobile ? 1 : 3);
  const msgLimit = opts.initialMessageLimit ?? (opts.mobile ? 50 : 200);
  const openSig = opts.openSessionKeys?.join('\n') ?? '';
  const topSig = opts.sessions.slice(0, 24).map(s => `${s.sessionKey}:${s.status}:${s.hasActiveRun ? 1 : 0}:${s.lastActiveAt ?? 0}:${s.pinned ? 1 : 0}`).join('|');

  useEffect(() => {
    if (opts.mobile && opts.activeSessionKey) return;
    const gov = requestGovernor.snapshot();
    if (!opts.sessions.length || (typeof document !== 'undefined' && document.hidden) || (typeof navigator !== 'undefined' && navigator.onLine === false) || !gov.allowBackgroundPreload) return;
    const now = Date.now(), scope = recoveryScope(), epoch = recoveryEpoch();
    const effectiveLimit = opts.mobile ? 1 : (gov.regime === 'boosted' ? limit + 1 : Math.min(limit, Math.max(1, gov.effectiveConcurrency)));
    const minResampleIntervalMs = Math.round(4_000 * gov.intervalMultiplier);
    const candidates = rankHotSessionsForPreload(opts.sessions, {
      activeSessionKey: opts.activeSessionKey,
      openSessionKeys: new Set(opts.openSessionKeys ?? []),
      isVisible: isSessionVisible,
      hasFreshCache: s => {
        if (s.status === 'running' || s.hasActiveRun) return false;
        const c = readCachedMessages(s.sessionKey);
        return Boolean(c?.messages.length && ((s.lastActiveAt ?? 0) > 0 ? c.updatedAt >= (s.lastActiveAt ?? 0) : now - c.updatedAt < 60_000));
      },
      limit: effectiveLimit * 2,
      now,
    }).filter(c => {
      if (inflightRef.current.has(c.sessionKey)) return false;
      const stamp = Math.max(c.session.lastActiveAt ?? 0, c.session.runCompletedAt ?? 0, c.session.status === 'running' || c.session.hasActiveRun ? now : 0);
      const prev = preloadedRef.current.get(c.sessionKey);
      return prev === undefined || (stamp > 0 && prev + minResampleIntervalMs < stamp);
    }).slice(0, effectiveLimit);

    if (!candidates.length) return;
    const controllers: AbortController[] = [];
    const delayMs = Math.round((opts.mobile ? 350 : 120) * gov.intervalMultiplier);
    const timer = window.setTimeout(() => {
      for (const c of candidates) {
        if (recoveryScope() !== scope || recoveryEpoch() !== epoch || isSessionVisible(c.sessionKey) || !requestGovernor.allowBackgroundPreload()) continue;
        const ctrl = new AbortController();
        controllers.push(ctrl);
        const stamp = Math.max(c.session.lastActiveAt ?? 0, c.session.runCompletedAt ?? 0, 1);
        inflightRef.current.add(c.sessionKey);
        preloadedRef.current.set(c.sessionKey, stamp);
        void api.sessionMessages(c.sessionKey, msgLimit, ctrl.signal, undefined, false, automaticHistoryReadSchedule(() => c.priority))
          .then(p => {
            if (recoveryScope() === scope && recoveryEpoch() === epoch && p.historyStatus !== 'cached' && p.messages.length > 0) {
              writeCachedMessages(c.sessionKey, p.messages, { hiddenCount: p.hiddenCount, updatedAt: p.updatedAt ?? Date.now() });
            }
          })
          .catch(() => { if (preloadedRef.current.get(c.sessionKey) === stamp) preloadedRef.current.delete(c.sessionKey); })
          .finally(() => { inflightRef.current.delete(c.sessionKey); });
      }
    }, delayMs);
    return () => { window.clearTimeout(timer); controllers.forEach(c => c.abort()); };
  }, [topSig, opts.activeSessionKey, openSig, opts.mobile, limit, msgLimit]);
}

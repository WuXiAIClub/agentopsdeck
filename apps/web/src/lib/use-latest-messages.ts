import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { automaticHistoryReadSchedule } from './history-read-scheduler';

// Track the transport separately from initial-content loading: cached content
// must remain visible, and a background read must not reset scroll intent.
export function useLatestMessages(sessionKey: string | undefined, hasContent = false, initialReadPriority?: () => number) {
  const priority = useRef(initialReadPriority);
  priority.current = initialReadPriority;
  const [pending, setPending] = useState<ReadonlyMap<symbol, string>>(() => new Map());
  const [cachedKey, setCachedKey] = useState<string>();
  const cached = useRef<string | undefined>(undefined);
  const reads = useRef(new Set<AbortController>());
  useEffect(() => () => {
    for (const controller of reads.current) controller.abort();
    reads.current.clear();
  }, [sessionKey]);
  const selection = useRef({ key: sessionKey, read: false, hasContent });
  if (selection.current.key !== sessionKey) selection.current = { key: sessionKey, read: false, hasContent };
  selection.current.hasContent = hasContent;
  const readLatestMessages = useCallback(async (key: string, limit: number, foreground = false, calibration = false) => {
    const token = Symbol();
    const selected = selection.current;
    const first = selected.key === key && !selected.read;
    // The view already hydrates navigation/disk cache. That cache is display
    // continuity, not a completed revalidation: returning it here could defer
    // the first network read until the next 60s SSE safety calibration.
    const announce = foreground || (first && !selected.hasContent);
    if (selected.key === key) selected.read = true;
    const controller = new AbortController();
    reads.current.add(controller);
    if (announce) setPending(current => new Map(current).set(token, key));
    try {
      // Resume can wake every pane together. Keep all automatic attempts in
      // the shared budget, not just the initial read; the active pane retains
      // its higher queue priority and explicit manual reads may still bypass.
      const schedule = !foreground && priority.current
        ? automaticHistoryReadSchedule(() => priority.current?.() ?? 2)
        : undefined;
      const page = await api.sessionMessages(key, limit, controller.signal, undefined, calibration, schedule);
      if (!controller.signal.aborted && selection.current.key === key) {
        cached.current = page.historyStatus === 'cached' ? key : undefined;
        setCachedKey(cached.current);
      }
      return page;
    } finally {
      reads.current.delete(controller);
      if (announce) setPending(current => {
        const next = new Map(current);
        next.delete(token);
        return next;
      });
    }
  }, []);
  const isHistoryCached = useCallback(() => selection.current.key !== undefined && cached.current === selection.current.key, []);
  return { readLatestMessages, isHistoryCached, cachedHistory: sessionKey !== undefined && cachedKey === sessionKey,
    refreshing: sessionKey !== undefined && [...pending.values()].includes(sessionKey) };
}

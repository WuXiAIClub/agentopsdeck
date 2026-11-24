import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import { recoveryScope, subscribeRecoveryScope } from '../api';
import { useI18n } from '../lib/i18n';
import { maxSessionRailWidth, navigationRailWidth, parseSessionRailPreference, sessionRailWidth, type SessionRailPreference } from '../lib/session-rail';

/** Geometry only, scoped to this origin + authenticated user. Never stores chat data. */
export function useSessionRail(viewport: number) {
  const scope = useSyncExternalStore(subscribeRecoveryScope, recoveryScope);
  const key = scope ? `agentopsdeck.session-rail.v1:${scope}` : undefined;
  function read(): SessionRailPreference {
    try { return parseSessionRailPreference(key ? localStorage.getItem(key) : null); } catch { return { version: 1 }; }
  }
  const [stored, setStored] = useState(() => ({ key, value: read() }));
  const value = stored.key === key ? stored.value : read();
  const [draft, setDraft] = useState<{ key: typeof key; width: number }>();
  function save(next: SessionRailPreference) {
    setStored({ key, value: next });
    try { if (key) localStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage blocked: keep this page usable. */ }
  }
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === key || event.key === null) { setStored({ key, value: read() }); setDraft(undefined); } };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [key]);
  return {
    width: sessionRailWidth(draft?.key === key ? draft?.width ?? value.width : value.width, viewport),
    collapsed: value.collapsed ?? viewport < 900,
    navigationCollapsed: value.navigationCollapsed ?? false,
    setNavigationCollapsed: (navigationCollapsed: boolean) => save({ ...value, navigationCollapsed }),
    setCollapsed: (collapsed: boolean) => { setDraft(undefined); save({ ...value, collapsed }); },
    preview: (width?: number) => setDraft(width === undefined ? undefined : { key, width }),
    commit: (width: number) => { setDraft(undefined); save({ ...value, width: sessionRailWidth(width, viewport) }); },
    reset: () => { setDraft(undefined); const { width: _, ...rest } = value; save(rest); },
  };
}

export function SessionRailDivider({ rail, viewport }: { rail: ReturnType<typeof useSessionRail>; viewport: number }) {
  const { t } = useI18n();
  const drag = useRef<{ id: number; x: number; width: number } | undefined>(undefined);
  const [active, setActive] = useState(false);
  const current = useRef(rail); current.current = rail;
  const cancel = () => { drag.current = undefined; setActive(false); current.current.preview(); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('blur', cancel); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape); current.current.preview(); };
  }, []);
  const nextWidth = (event: PointerEvent) => drag.current!.width + event.clientX - drag.current!.x;
  return <div role="separator" aria-orientation="vertical" aria-label={t('Resize session list')}
    aria-controls="desktop-session-list" aria-valuemin={160} aria-valuemax={maxSessionRailWidth(viewport)} aria-valuenow={rail.width}
    tabIndex={0} title={t('Drag to resize · double-click to reset')} className={`session-rail-divider${active ? ' is-resizing' : ''}`}
    style={{ left: (rail.navigationCollapsed ? 28 : navigationRailWidth(viewport)) + rail.width }}
    onPointerDown={event => { if (event.button !== 0 || !event.isPrimary) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, width: rail.width }; setActive(true); }}
    onPointerMove={event => { if (drag.current?.id === event.pointerId) rail.preview(nextWidth(event)); }}
    onPointerUp={event => { if (drag.current?.id !== event.pointerId) return; const width = nextWidth(event); drag.current = undefined; setActive(false); rail.commit(width); event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }} onDoubleClick={() => { cancel(); rail.reset(); }}
    onKeyDown={event => {
      if (drag.current) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); rail.commit(rail.width + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10)); }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); rail.commit(event.key === 'Home' ? 160 : maxSessionRailWidth(viewport)); }
      if (event.key === 'Enter') { event.preventDefault(); rail.reset(); }
    }} />;
}

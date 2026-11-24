import { useEffect, useRef, useState } from 'react';
import { displayKey, validDisplay, type DisplayProfile } from './display-layout';

type DetailedScreen = Screen & { label?: string; left?: number; top?: number; isInternal?: boolean };
type ScreenDetails = EventTarget & { currentScreen: DetailedScreen };
type DisplayWindow = Window & { getScreenDetails?: () => Promise<ScreenDetails> };
function profile(screen: DetailedScreen, detailed = false): DisplayProfile | undefined {
  const value: DisplayProfile = { width: screen.width, height: screen.height };
  if (detailed) {
    if (screen.label !== undefined) value.label = screen.label;
    if (screen.left !== undefined) value.left = screen.left;
    if (screen.top !== undefined) value.top = screen.top;
    if (screen.isInternal !== undefined) value.internal = screen.isInternal;
  }
  return validDisplay(value) ? value : undefined;
}
/** One local probe while visible; moving a window need not trigger resize.
 * No requests, no automatic permission prompt, no viewport/zoom bindings. */
export function useDisplayProfile(active: boolean) {
  const [current, setCurrent] = useState(() => profile(window.screen));
  const [precise, setPrecise] = useState(false);
  const details = useRef<ScreenDetails | undefined>(undefined);
  const request = useRef<() => Promise<DisplayProfile | undefined>>(async () => profile(window.screen));
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, settle: ReturnType<typeof setTimeout> | undefined;
    let permission: PermissionStatus | undefined;
    let epoch = 0;
    let pending: Promise<DisplayProfile | undefined> | undefined;
    setPrecise(false);
    const read = () => profile(details.current?.currentScreen ?? window.screen, !!details.current);
    const publish = () => { if (disposed || document.hidden) return; const value = read(); if (value) setCurrent(old => old && displayKey(old) === displayKey(value) ? old : value); };
    const changed = () => { clearTimeout(settle); settle = setTimeout(publish, 350); };
    const detach = () => { details.current?.removeEventListener('currentscreenchange', changed); details.current?.removeEventListener('screenschange', changed); details.current = undefined; };
    const enable = (): Promise<DisplayProfile | undefined> => {
      if (disposed) return Promise.resolve(undefined);
      if (pending) return pending;
      const api = (window as DisplayWindow).getScreenDetails;
      if (!api) { publish(); return Promise.resolve(read()); }
      const generation = ++epoch;
      pending = (async () => {
        try {
          const next = await api.call(window);
          // A late response must not undo revocation or attach listeners after
          // account/setting cleanup. Do not return a stale profile for binding.
          if (disposed || generation !== epoch || permission?.state === 'denied') return;
          detach(); details.current = next; setPrecise(true);
          next.addEventListener('currentscreenchange', changed); next.addEventListener('screenschange', changed);
          publish(); return read();
        } catch { if (!disposed && generation === epoch) { detach(); setPrecise(false); publish(); return read(); } }
      })();
      const operation = pending;
      void operation.finally(() => { if (pending === operation) pending = undefined; });
      return operation;
    };
    request.current = enable;
    const checkPermission = () => {
      if (permission?.state === 'granted') { if (active || pending || details.current) void enable(); }
      else { epoch++; pending = undefined; detach(); setPrecise(false); publish(); }
    };
    if ((window as DisplayWindow).getScreenDetails && navigator.permissions) {
      void navigator.permissions.query({ name: 'window-management' as PermissionName }).then(value => {
        if (disposed) return; permission = value; value.addEventListener('change', checkPermission);
        if (value.state !== 'prompt') checkPermission();
      }).catch(() => { /* Unsupported permission: bind remains an explicit action. */ });
    }
    const poll = () => { clearTimeout(timer); if (!document.hidden) { changed(); if (active) timer = setTimeout(poll, 2000); } };
    window.addEventListener('resize', changed); window.addEventListener('focus', poll); document.addEventListener('visibilitychange', poll);
    poll();
    return () => { disposed = true; epoch++; clearTimeout(timer); clearTimeout(settle); detach(); permission?.removeEventListener('change', checkPermission); window.removeEventListener('resize', changed); window.removeEventListener('focus', poll); document.removeEventListener('visibilitychange', poll); };
  }, [active]);
  return { current, precise, request: () => request.current() };
}

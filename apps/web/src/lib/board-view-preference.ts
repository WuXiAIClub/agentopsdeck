import { useCallback, useSyncExternalStore } from 'react';

const changed = 'agentopsdeck:board-view-preference';
// Storage can be blocked or full. Keep display controls usable without touching
// the board document, draft, file binding, or network.
const fallback = new Map<string, boolean>();
export function boardViewKey(scope: string, resourceId: string) {
  return `agentopsdeck.board-view.v1:${JSON.stringify([scope, resourceId])}`;
}
export function readBoardHideDone(key: string): boolean {
  if (fallback.has(key)) return fallback.get(key)!;
  try { return localStorage.getItem(key) === 'hide-done'; } catch { return false; }
}
export function saveBoardHideDone(key: string, hidden: boolean) {
  try {
    localStorage.setItem(key, hidden ? 'hide-done' : 'show-all');
    fallback.delete(key);
  } catch { fallback.set(key, hidden); }
  window.dispatchEvent(new CustomEvent(changed, { detail: key }));
}
export function useBoardHideDone(scope: string, resourceId: string) {
  const key = boardViewKey(scope, resourceId);
  const subscribe = useCallback((notify: () => void) => {
    const local = (event: Event) => { if ((event as CustomEvent).detail === key) notify(); };
    const remote = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      try { if (event.storageArea !== localStorage) return; } catch { return; }
      fallback.delete(key); notify();
    };
    window.addEventListener(changed, local); window.addEventListener('storage', remote);
    return () => { window.removeEventListener(changed, local); window.removeEventListener('storage', remote); };
  }, [key]);
  const read = useCallback(() => readBoardHideDone(key), [key]);
  const hidden = useSyncExternalStore(subscribe, read, () => false);
  return [hidden, (value: boolean) => saveBoardHideDone(key, value)] as const;
}

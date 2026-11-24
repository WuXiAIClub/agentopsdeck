import { useLayoutEffect, useRef } from 'react';

// Mounted chat surfaces, not selected list rows or background controllers.
const surfaces = new Map<object, string[]>();
const listeners = new Set<() => void>();
export const isSessionVisible = (key: string) => [...surfaces.values()].some(keys => keys.includes(key));
// Notes and duplicate surfaces of the same session do not spend this budget.
export const visibleSessionCount = () => new Set([...surfaces.values()].flat()).size;
export function subscribeVisibleSessions(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useVisibleSessions(keys: string[]) {
  const owner = useRef({});
  const signature = JSON.stringify(keys);
  useLayoutEffect(() => () => {
    surfaces.delete(owner.current);
    listeners.forEach(listener => listener());
  }, []);
  useLayoutEffect(() => {
    // Replace the registry entry atomically: cleanup/re-add on every layout
    // change would briefly hide all panes, then wake every history controller.
    surfaces.set(owner.current, JSON.parse(signature));
    listeners.forEach(listener => listener());
  }, [signature]);
}

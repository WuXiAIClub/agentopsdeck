import { useSyncExternalStore } from 'react';
import { recoveryScope, subscribeRecoveryScope } from '../api';

export type CompletionEffect = 'flash' | 'heartbeat' | 'glow' | 'off';
const changed = 'agentopsdeck:completion-effect';
export function parseCompletionEffect(value: string | null): CompletionEffect {
  return value === 'heartbeat' || value === 'glow' || value === 'off' ? value : 'flash';
}
function key() { return `agentopsdeck.completion-effect.v1:${recoveryScope() ?? 'anonymous'}`; }
function read(): CompletionEffect {
  try { return parseCompletionEffect(localStorage.getItem(key())); } catch { return 'flash'; }
}
function subscribe(listener: () => void) {
  const off = subscribeRecoveryScope(listener);
  window.addEventListener(changed, listener); window.addEventListener('storage', listener);
  return () => { off(); window.removeEventListener(changed, listener); window.removeEventListener('storage', listener); };
}
export function useCompletionEffect() { return useSyncExternalStore(subscribe, read, () => 'flash' as const); }
export function saveCompletionEffect(value: CompletionEffect) {
  localStorage.setItem(key(), value); window.dispatchEvent(new Event(changed));
}

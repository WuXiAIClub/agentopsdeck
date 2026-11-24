import { useCallback, useEffect, useSyncExternalStore, type SetStateAction } from 'react';
import type { SendMessageUpload } from '@agentopsdeck/shared';
import { recoveryScope } from '../api';
import { createComposerMediaStore } from './composer-media-store';

// Concurrent panes own independent drafts; error-boundary remounts retain them.
const store = createComposerMediaStore();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useComposerMedia(sessionKey: string) {
  const scope = recoveryScope() ?? '';
  const key = JSON.stringify([scope, sessionKey]);
  const media = useSyncExternalStore(subscribe, () => store.read(scope, key));
  useEffect(() => {
    if (recoveryScope() === scope) { store.activate(scope); notify(); }
    const clear = () => { store.clear(); notify(); };
    window.addEventListener('agentopsdeck:auth-required', clear);
    return () => window.removeEventListener('agentopsdeck:auth-required', clear);
  }, [key]);
  const setMedia = useCallback((value: SetStateAction<SendMessageUpload[]>, restore = false) => {
    // Late upload completions from an old account/session must not replace a
    // different composer's attachments after navigation or authentication loss.
    if (!scope || recoveryScope() !== scope) return;
    store.update(scope, key, value, restore);
    notify();
  }, [key, scope]);
  return [media, setMedia] as const;
}

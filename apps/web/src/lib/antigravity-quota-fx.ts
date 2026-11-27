import { useCallback, useEffect, useState } from 'react';

export const ANTIGRAVITY_QUOTA_FX_STORAGE_KEY = 'agentopsdeck.antigravity-quota-fx';
export const ANTIGRAVITY_QUOTA_FX_CHANGE_EVENT = 'agentopsdeck:antigravity-quota-fx-change';
export const ANTIGRAVITY_QUOTA_PULSE_EVENT = 'agentopsdeck:antigravity-quota-pulse';

export type AntigravityQuotaPulseDetail = {
  sessionKey: string;
  kind: 'message' | 'tool';
  at: number;
};

export function readAntigravityQuotaFxEnabled(): boolean {
  try {
    const raw = localStorage.getItem(ANTIGRAVITY_QUOTA_FX_STORAGE_KEY);
    return raw !== 'false';
  } catch {
    return true;
  }
}

export function writeAntigravityQuotaFxEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ANTIGRAVITY_QUOTA_FX_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* Ignore storage quota errors */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ANTIGRAVITY_QUOTA_FX_CHANGE_EVENT, { detail: { enabled } }));
  }
}

export function emitAntigravityQuotaPulse(detail: { sessionKey: string; kind: 'message' | 'tool' }): void {
  if (typeof window === 'undefined' || !detail.sessionKey) return;
  if (!readAntigravityQuotaFxEnabled()) return;
  const payload: AntigravityQuotaPulseDetail = {
    sessionKey: detail.sessionKey,
    kind: detail.kind,
    at: Date.now(),
  };
  window.dispatchEvent(new CustomEvent<AntigravityQuotaPulseDetail>(ANTIGRAVITY_QUOTA_PULSE_EVENT, { detail: payload }));
}

export function useAntigravityQuotaFxEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => readAntigravityQuotaFxEnabled());

  useEffect(() => {
    const onChange = () => setEnabled(readAntigravityQuotaFxEnabled());
    window.addEventListener(ANTIGRAVITY_QUOTA_FX_CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(ANTIGRAVITY_QUOTA_FX_CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const update = useCallback((next: boolean) => {
    setEnabled(next);
    writeAntigravityQuotaFxEnabled(next);
  }, []);

  return [enabled, update];
}

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { WorkspacePreferences, WorkspaceSessionStyle } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { sessionTone } from '../lib/session-tone';
import { useI18n } from '../lib/i18n';

type Workspace = {
  value: WorkspacePreferences;
  ready: boolean;
  saving: boolean;
  error: string;
  reload: () => Promise<void>;
  change: (edit: (value: WorkspacePreferences) => WorkspacePreferences) => Promise<boolean>;
};
const empty = (): WorkspacePreferences => ({ revision: 0, groups: [], sessions: {} });
const Context = createContext<Workspace>({ value: empty(), ready: false, saving: false, error: '', reload: async () => {}, change: async () => false });
export const useWorkspacePreferences = () => useContext(Context);
export function useSessionTone(key: string) {
  const { value } = useWorkspacePreferences();
  return sessionTone(key, value.sessions[key]?.color);
}

export function WorkspacePreferencesProvider({ children, paused }: { children: React.ReactNode; paused: boolean }) {
  const [value, setValue] = useState(empty);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const state = useRef(value); state.current = value;
  const pending = useRef(false);
  const active = useRef<AbortController | undefined>(undefined);
  const scope = recoveryScope();
  async function reload() {
    if (paused || pending.current) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setReady(false); setError('');
    try {
      const result = await api.workspacePreferences(controller.signal);
      if (controller.signal.aborted || recoveryScope() !== scope) return;
      state.current = result; setValue(result); setReady(true);
    } catch (e) {
      if (!controller.signal.aborted && recoveryScope() === scope) setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    pending.current = false; setSaving(false);
    setValue(empty()); state.current = empty(); setReady(false);
    if (!paused) void reload();
    return () => { active.current?.abort(); };
  }, [scope, paused]);
  async function change(edit: (value: WorkspacePreferences) => WorkspacePreferences) {
    if (paused || !ready || pending.current || recoveryScope() !== scope) return false;
    pending.current = true; setSaving(true); setError('');
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    try {
      const result = await api.saveWorkspacePreferences(edit(structuredClone(state.current)), controller.signal);
      if (controller.signal.aborted || recoveryScope() !== scope) return false;
      state.current = result; setValue(result); return true;
    } catch (e) {
      if (!controller.signal.aborted && recoveryScope() === scope) {
        setReady(false); // Unknown save or conflict: reload before any further edit.
        setError(e instanceof Error ? e.message : String(e));
      }
      return false;
    } finally {
      if (active.current === controller && !controller.signal.aborted && recoveryScope() === scope) {
        pending.current = false; setSaving(false);
      }
    }
  }
  return <Context.Provider value={{ value, ready, saving, error, reload, change }}>{children}</Context.Provider>;
}

export function WorkspacePreferenceNotice() {
  const { error, reload, saving } = useWorkspacePreferences();
  const { t } = useI18n();
  return error ? <div className="workspace-preference-error" role="alert">{error} <button type="button" disabled={saving} onClick={() => void reload()}>{t('Reload preferences')}</button></div> : null;
}
export function updateSessionStyle(value: WorkspacePreferences, key: string, style: Partial<WorkspaceSessionStyle>) {
  value.sessions[key] = { ...value.sessions[key], ...style };
  return value;
}

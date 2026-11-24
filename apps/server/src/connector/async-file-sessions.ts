import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, validConnectorOwnerOutput } from './connector-owner-domain.js';
import type { BoardBindingSessionRead } from './board-bindings-http.js';
import type { WorkspaceSessionRead } from './workspace-http.js';

type NativeFileSessions = {
  codex: {
    readonly enabled: boolean;
    boardToolsAvailable(): boolean;
    isSessionListReady(): boolean;
    refreshSessions(): Promise<unknown>;
  };
  sdk: { readonly claude?: { readonly ready: boolean } | undefined; readonly copilot?: { readonly ready: boolean } | undefined };
};

/** Original journal facts live in the sole worker; native readiness remains at
 * the original executor. Neither a Deck entry nor a configured directory can
 * create native enrollment, and these observations never confer authority. */
export function createAsyncFileSessions(owner: Pick<AsyncConnectorOwner, 'command'>,
  native: NativeFileSessions, catalog: { getSession(key: string): unknown }) {
  const observe = async (sessionKey: string) => {
    const value = await owner.command('fileSessionObserve', { sessionKey });
    if (!validConnectorOwnerOutput('fileSessionObserve', value)
      || value && value.runtime !== sessionRuntimeId(sessionKey)) throw new ConnectorOwnerUnavailable();
    return value;
  };
  const sdkReady = (runtime: 'claude-code' | 'ghcp') =>
    (runtime === 'claude-code' ? native.sdk.claude : native.sdk.copilot)?.ready === true;
  const boardBindingSession: BoardBindingSessionRead = async key => {
    const current = await observe(key);
    if (!current || current.deleted) return;
    if (current.runtime === 'codex') {
      if (!current.boardTools || !native.codex.boardToolsAvailable()) return;
      return { runtime: current.runtime, sessionId: key.slice(6), ready: native.codex.enabled };
    }
    return current.sessionId === null ? undefined
      : { runtime: current.runtime, sessionId: current.sessionId, ready: sdkReady(current.runtime) };
  };
  const workspaceSession: WorkspaceSessionRead = async key => {
    let current = await observe(key);
    if (!current || current.deleted) return { exists: false, ready: false };
    if (current.runtime !== 'codex') return { exists: current.sessionId !== null, ready: sdkReady(current.runtime) };
    // Preserve the original create-before-first-list race handling. Refresh is
    // a native read, not a turn start; deletion is rechecked after that await.
    if (native.codex.enabled && !native.codex.isSessionListReady()) {
      await native.codex.refreshSessions();
      current = await observe(key);
    }
    if (!current || current.runtime !== 'codex' || current.deleted) return { exists: false, ready: false };
    return { exists: !!catalog.getSession(key), ready: native.codex.enabled && native.codex.isSessionListReady() };
  };
  return { boardBindingSession, workspaceSession };
}

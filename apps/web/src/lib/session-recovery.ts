import type { SessionSummary } from '@agentopsdeck/shared';
import { sessionAddress } from './session-address.js';
import { hasObservedRunningExecution, isSessionBusy } from './live-session.js';
import { sessionPresentation } from './session-presentation.js';

export function canRequestSessionRecovery(session: SessionSummary) {
  try {
    if (sessionAddress(session.sessionKey).shared || !session.runtime?.turnId) return false;
    const runtimeId = session.sessionRef?.runtimeId ?? session.source;
    if (runtimeId === 'codex') {
      const ownedBackgroundBlock = session.runtime.connection === 'connected'
        && session.runtime.operation !== 'compact'
        && ['completed', 'failed', 'interrupted'].includes(session.runtime.phase)
        && session.runtime.executionProtection?.state === 'blocked'
        && session.runtime.executionProtection.reason === 'background-work'
        && session.runtime.executionProtection.nativeTurnId === session.runtime.turnId;
      if (ownedBackgroundBlock) return true;
      return sessionPresentation(session).state === 'error'
        && (isSessionBusy(session) || session.runtime.sync !== 'current'
          || session.runtime.connection !== 'connected');
    }
    if (runtimeId === 'claude-code' || runtimeId === 'ghcp' || runtimeId === 'antigravity') {
      return session.runtime.phase === 'unknown' && session.runtime.connection === 'connected';
    }
    return false;
  } catch { return false; }
}

export function canStopSessionBackgroundTerminals(session: SessionSummary) {
  try {
    const runtime = session.runtime;
    const runtimeId = session.sessionRef?.runtimeId ?? session.source;
    if (sessionAddress(session.sessionKey).shared || runtimeId !== 'codex') return false;
    if (!runtime?.turnId || runtime.connection !== 'connected' || runtime.operation === 'compact') return false;
    if (!['completed', 'failed', 'interrupted'].includes(runtime.phase)) return false;
    if (runtime.executionProtection?.state !== 'blocked' || runtime.executionProtection.reason !== 'background-work') return false;
    if (runtime.executionProtection.nativeTurnId !== runtime.turnId) return false;
    if (runtime.threadActivity === undefined || runtime.threadActivity === 'idle') return !hasObservedRunningExecution(session);
    // Codex may report threadActivity === 'running' while only post-turn
    // background terminals remain alive. A live successor turn changes
    // executionProtection.nativeTurnId away from runtime.turnId.
    return runtime.threadActivity === 'running';
  } catch { return false; }
}

export function createSessionRecoveryRequest() {
  let current: AbortController | undefined;
  return {
    begin() {
      if (current) return undefined;
      current = new AbortController();
      return current;
    },
    current(controller: AbortController) { return current === controller && !controller.signal.aborted; },
    finish(controller: AbortController) { if (current === controller) current = undefined; },
    cancel() { current?.abort(); current = undefined; },
  };
}

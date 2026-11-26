import type { SessionSummary } from '@agentopsdeck/shared';
import { sessionAddress } from './session-address.js';
import { hasObservedRunningExecution, isSessionBusy } from './live-session.js';
import { sessionPresentation } from './session-presentation.js';

export function canRequestSessionRecovery(session: SessionSummary) {
  try {
    if (sessionAddress(session.sessionKey).shared || !session.runtime?.turnId) return false;
    const runtimeId = session.sessionRef?.runtimeId;
    if (runtimeId === 'codex') {
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
    return !sessionAddress(session.sessionKey).shared && session.sessionRef?.runtimeId === 'codex'
      && !!runtime?.turnId && runtime.connection === 'connected'
      && runtime.operation !== 'compact'
      && ['completed', 'failed', 'interrupted'].includes(runtime.phase)
      && (runtime.threadActivity === undefined || runtime.threadActivity === 'idle')
      && !hasObservedRunningExecution(session)
      && runtime.executionProtection?.state === 'blocked'
      && runtime.executionProtection.reason === 'background-work';
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

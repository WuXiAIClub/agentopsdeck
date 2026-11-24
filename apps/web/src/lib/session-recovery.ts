import type { SessionSummary } from '@agentopsdeck/shared';
import { sessionAddress } from './session-address.js';
import { isSessionBusy } from './live-session.js';
import { sessionPresentation } from './session-presentation.js';

export function canRequestSessionRecovery(session: SessionSummary) {
  try {
    return !sessionAddress(session.sessionKey).shared && session.sessionRef?.runtimeId === 'codex'
      && sessionPresentation(session).state === 'error'
      && !!session.runtime?.turnId && (isSessionBusy(session) || session.runtime.sync !== 'current'
        || session.runtime.connection !== 'connected');
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

import type { SessionSummary } from '@agentopsdeck/shared';

/** Shared by the legacy projection and the async observation owner. Keep
 * native lifecycle vocabulary identical; presentation never grants execution. */
export function gatewayEventRunState(eventName: string, payload: any): NonNullable<SessionSummary['structuredStatus']>['runState'] | undefined {
  if (eventName === 'agent' && payload?.stream === 'lifecycle') {
    const data = payload?.data;
    switch (data?.phase) {
      case 'start': case 'finishing': return 'running';
      case 'end': case 'error':
        // A lifecycle error may precede retry of the SAME native run.
        if (data.yielded === true || data.livenessState === 'blocked') return 'waiting';
        if ((data.yielded !== undefined && data.yielded !== false)
          || (data.aborted !== undefined && data.aborted !== false)
          || (data.livenessState !== undefined && data.livenessState !== '')) return 'unknown';
        if (data.phase === 'error') return data.fallbackExhaustedFailure === true ? 'failed' : 'unknown';
        if ((data.stopReason !== undefined && data.stopReason !== 'end_turn') || data.error !== undefined) return 'unknown';
        return 'idle';
      default: return undefined;
    }
  }
  if (eventName !== 'run' && !eventName.startsWith('run.') && !payload?.run && !payload?.activeRun && !payload?.currentRun) return;
  const row = payload?.activeRun ?? payload?.currentRun ?? payload?.run ?? payload;
  if (row?.hasActiveRun === true || row?.running === true || row?.busy === true || payload?.hasActiveRun === true) return 'running';
  const values = [row?.status, row?.state, row?.phase, row?.runStatus]
    .filter((value) => value !== undefined && value !== null && value !== '');
  const states = values.map((value) => {
    switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
      case 'running': case 'in_progress': case 'processing': case 'queued': case 'started': case 'starting': return 'running';
      case 'waiting': case 'blocked': case 'waiting_for_input': return 'waiting';
      case 'failed': case 'error': case 'crashed': case 'timeout': case 'timed_out':
      case 'aborted': case 'cancelled': case 'canceled': return 'failed';
      case 'idle': case 'done': case 'completed': case 'finished': case 'succeeded': return 'idle';
      case 'unknown': return 'unknown';
      default: return undefined;
    }
  });
  if (states.includes('running')) return 'running';
  if (states.includes(undefined)) return;
  if (row?.waitingForInput === true || states.includes('waiting')) return 'waiting';
  if (states.includes('unknown')) return 'unknown';
  if (states.includes('failed')) return 'failed';
  if (states.includes('idle')) return 'idle';
  switch (eventName) {
    case 'run.started': case 'run.running': return 'running';
    case 'run.completed': return 'idle';
    case 'run.failed': case 'run.aborted': case 'run.cancelled': case 'run.canceled': return 'failed';
    default: return undefined;
  }
}

export function gatewayRunId(payload: any): string | undefined {
  const values = [payload?.runId, payload?.activeRun?.runId, payload?.activeRun?.id,
    payload?.currentRun?.runId, payload?.currentRun?.id, payload?.run?.runId, payload?.run?.id].filter((value) => value !== undefined);
  if (!values.length || values.some((value) => typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 512)) return;
  return values.every((value) => value === values[0]) ? values[0] : undefined;
}

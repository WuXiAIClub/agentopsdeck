import { requestGovernor } from './request-governor.js';

/** Bound event storms, not user actions. Explicit refresh/send still use the
 * direct API path. Ordinary and Preview transport share this upstream budget.
 * Idle sessions use the shared 60s revision calibration; this budget applies
 * to event-triggered history reads, not an additional polling loop. */
export function historyRefreshInterval(sessionCount: number, foreground: boolean, multiplier = 1) {
  let base: number;
  if (sessionCount <= 1) base = foreground ? 400 : 800;
  else if (sessionCount <= 2) base = foreground ? 600 : 1_000;
  else base = sessionCount > 4 ? (foreground ? 2_000 : 4_000) : 1_000;
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  return Math.max(200, Math.min(12_000, Math.round(base * m)));
}

/** Adaptive event-triggered refresh interval using live requestGovernor telemetry. */
export function adaptiveHistoryRefreshInterval(sessionCount: number, foreground: boolean) {
  return historyRefreshInterval(sessionCount, foreground, requestGovernor.intervalMultiplier());
}

/** Adaptive safety calibration interval for active/busy sessions so single-session
 * or low-density layouts detect newly produced replies and status transitions faster. */
export function activeSessionSafetyInterval(sessionCount: number, foreground: boolean, busyOrCached: boolean, multiplier = 1) {
  if (!busyOrCached) return 60_000;
  let base: number;
  if (sessionCount <= 1) base = foreground ? 1_500 : 3_000;
  else if (sessionCount <= 2) base = foreground ? 2_500 : 5_000;
  else base = foreground ? 5_000 : 15_000;
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  return Math.max(900, Math.min(30_000, Math.round(base * m)));
}

/** Adaptive safety calibration interval for active/busy sessions governed by live telemetry. */
export function adaptiveActiveSessionSafetyInterval(sessionCount: number, foreground: boolean, busyOrCached: boolean) {
  return activeSessionSafetyInterval(sessionCount, foreground, busyOrCached, requestGovernor.intervalMultiplier());
}

/** Losing SSE must not turn every completed pane into a 10-second poller.
 * Unknown/running sessions retain the fast fallback; reconnect/send invalidate
 * independently. A positive idle fact is required, never inferred from focus. */
export function historyFallbackInterval(session: { status: string; hasActiveRun?: boolean; runtime?: { phase: string } }, unchanged = 0, multiplier = 1) {
  const active = session.hasActiveRun || session.runtime && ['starting', 'running', 'waiting', 'finalizing', 'unknown'].includes(session.runtime.phase);
  const idle = !active && (session.status === 'idle' || session.status === 'failed');
  // A state change/invalidation resets the exponent. Active/unknown reaches a
  // 15s safety ceiling; positively idle work gradually backs off to one minute.
  const base = Math.min(idle ? 60_000 : 15_000, (idle ? 15_000 : 3_000) * 2 ** Math.min(unchanged, 5));
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  if (idle) return base;
  return Math.max(1_800, Math.min(30_000, Math.round(base * m)));
}

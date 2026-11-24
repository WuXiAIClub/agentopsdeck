import type { SessionSummary, WorkspacePreferences } from '@agentopsdeck/shared';
import { hasObservedRunningExecution, hasQueueBlockingRun, sessionRunOutcome } from './live-session.js';
import { sessionPresentation } from './session-presentation.js';
import { estimateSessionBuiltinCredits } from './usage-credits.js';
import type { SavedLayout } from './saved-layouts.js';
import { isSessionPane } from './workspace-layout.js';

export type OverviewState = 'run' | 'completed' | 'attention' | 'idle';
/** Metadata only: never open transcripts to compute dashboard counts. Unknown or
 * disconnected execution is not an idle/completed session. */
export function overviewState(session: SessionSummary): OverviewState {
  const runtime = session.runtime;
  if (hasObservedRunningExecution(session)) return 'run';
  if (runtime && (runtime.connection === 'disconnected' || runtime.sync === 'error'
    || runtime.phase === 'unknown' || runtime.threadActivity === 'unknown')) return 'attention';
  if (hasQueueBlockingRun(session)) return 'run';
  if (runtime?.executionProtection?.state === 'blocked' && sessionPresentation(session).state === 'error') return 'attention';
  const outcome = sessionRunOutcome(session);
  if (outcome === 'completed') return 'completed';
  if (outcome === 'interrupted' && runtime?.threadActivity === 'idle') return 'idle';
  if (outcome || (runtime && runtime.sync !== 'current')) return 'attention';
  if (!runtime && (session.status === 'unknown' || session.status === 'failed' || session.status === 'pending_subagent')) return 'attention';
  return 'idle';
}

/** Keep the category small, but expose the reason instead of a generic badge. */
export function overviewLabel(session: SessionSummary) {
  const presentation = sessionPresentation(session);
  if (presentation.state === 'running' || presentation.state === 'error'
    || presentation.label === 'Interrupted') return presentation.label;
  const state = overviewState(session);
  return state === 'run' ? 'Run' : state === 'completed' ? 'Done' : state === 'attention' ? 'Needs attention' : 'Idle';
}
export function overviewSessions(sessions: readonly SessionSummary[]) {
  return [...new Map(sessions.map(session => [session.sessionKey, session])).values()].filter(session => !session.hidden && !session.archived);
}

export type DashboardTokenDimension = 'agent' | 'env' | 'tag' | 'group' | 'layout';

export type DashboardTokenGroup = {
  runtime: string;
  key: string;
  label: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCredits: number;
  ghcpCredits: number;
};

export type DashboardTokenSummaryOptions = {
  dimension?: DashboardTokenDimension;
  preferences?: WorkspacePreferences;
  savedLayouts?: readonly SavedLayout[];
};

function resolveEnvironmentLabel(session: SessionSummary): string {
  const idx = session.sessionKey.indexOf(':');
  if (idx > 0) {
    const prefix = session.sessionKey.slice(0, idx);
    if (prefix && prefix !== 'agent' && prefix !== 'codex' && prefix !== 'claude-code' && prefix !== 'ghcp') {
      return prefix;
    }
  }
  return session.sessionRef?.nodeId ?? session.source ?? 'local';
}

function resolveDimensionBuckets(
  session: SessionSummary,
  dimension: DashboardTokenDimension,
  preferences?: WorkspacePreferences,
  layoutMembership?: Map<string, string[]>,
): Array<{ key: string; label: string }> {
  if (dimension === 'env') {
    const env = resolveEnvironmentLabel(session);
    return [{ key: env, label: env }];
  }
  if (dimension === 'group') {
    const groupId = preferences?.sessions[session.sessionKey]?.groupId;
    if (groupId) {
      const found = preferences?.groups.find(g => g.id === groupId);
      const label = found?.name || groupId;
      return [{ key: `group:${groupId}`, label }];
    }
    return [{ key: 'ungrouped', label: 'Ungrouped' }];
  }
  if (dimension === 'tag') {
    const tags = preferences?.sessions[session.sessionKey]?.tags?.filter(Boolean) ?? [];
    if (tags.length > 0) {
      return tags.map(tag => ({ key: `tag:${tag}`, label: `#${tag}` }));
    }
    return [{ key: 'untagged', label: 'Untagged' }];
  }
  if (dimension === 'layout') {
    const layouts = layoutMembership?.get(session.sessionKey) ?? [];
    if (layouts.length > 0) {
      return layouts.map(name => ({ key: `layout:${name}`, label: name }));
    }
    return [{ key: 'unassigned-layout', label: 'Not in saved layout' }];
  }
  const runtime = session.sessionRef?.runtimeId ?? session.agentId ?? session.source ?? 'agent';
  return [{ key: runtime, label: runtime }];
}

export function summarizeDashboardTokens(
  sessions: readonly SessionSummary[],
  options: DashboardTokenSummaryOptions = {},
) {
  const dimension: DashboardTokenDimension = options.dimension ?? 'agent';
  const visible = overviewSessions(sessions);
  const byBucket = new Map<string, DashboardTokenGroup>();

  const layoutMembership = new Map<string, string[]>();
  if (dimension === 'layout' && options.savedLayouts?.length) {
    for (const saved of options.savedLayouts) {
      const sessionKeys = new Set<string>();
      for (const pane of saved.workspace.panes) {
        if (isSessionPane(pane)) sessionKeys.add(pane.sessionKey);
      }
      for (const sKey of sessionKeys) {
        const list = layoutMembership.get(sKey) ?? [];
        list.push(saved.name || saved.id);
        layoutMembership.set(sKey, list);
      }
    }
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalEstimatedCredits = 0;
  let totalGhcpCredits = 0;
  let countedSessions = 0;

  for (const session of visible) {
    const native = session.nativeUsage;
    const rawIn = native ? native.inputTokens : session.inputTokens;
    const rawOut = native ? native.outputTokens : session.outputTokens;
    const inTokens = typeof rawIn === 'number' && Number.isSafeInteger(rawIn) && rawIn >= 0 ? rawIn : null;
    const outTokens = typeof rawOut === 'number' && Number.isSafeInteger(rawOut) && rawOut >= 0 ? rawOut : null;
    if (inTokens === null && outTokens === null) continue;

    const runtime = session.sessionRef?.runtimeId ?? session.agentId ?? session.source ?? 'agent';
    const isGhcp = runtime === 'ghcp' || (session.agentId ?? '').toLocaleLowerCase().includes('ghcp') || (session.modelProvider ?? '').toLocaleLowerCase().includes('copilot');
    const inVal = inTokens ?? 0;
    const outVal = outTokens ?? 0;
    const estCredits = estimateSessionBuiltinCredits(inVal, outVal, isGhcp ? 'ghcp' : runtime, session.model);
    const ghcpCreditVal = isGhcp ? estCredits : 0;

    const buckets = resolveDimensionBuckets(session, dimension, options.preferences, layoutMembership);
    for (const bucket of buckets) {
      const current = byBucket.get(bucket.key) ?? {
        runtime: bucket.label,
        key: bucket.key,
        label: bucket.label,
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCredits: 0,
        ghcpCredits: 0,
      };
      current.sessions += 1;
      current.inputTokens += inVal;
      current.outputTokens += outVal;
      current.estimatedCredits += estCredits;
      current.ghcpCredits += ghcpCreditVal;
      byBucket.set(bucket.key, current);
    }

    totalInput += inVal;
    totalOutput += outVal;
    totalEstimatedCredits += estCredits;
    totalGhcpCredits += ghcpCreditVal;
    countedSessions += 1;
  }

  return {
    dimension,
    countedSessions,
    totalInput,
    totalOutput,
    totalEstimatedCredits,
    totalGhcpCredits,
    groups: [...byBucket.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)),
  };
}

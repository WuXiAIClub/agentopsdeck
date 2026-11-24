import type { AgentSummary, ChatMessage, SendDeliveryMode, SessionSummary, SessionsState } from '@agentopsdeck/shared';
import { readableText } from '../components/messages';
import { sessionMessageCount } from './session-message-count';
export { hasMatchingRealMessage, mergeMessages } from './optimistic-messages';

export type Tab = 'dashboard' | 'sessions' | 'agents' | 'media' | 'channels' | 'gateway' | 'users';

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};
export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function readStructuredSessionStatus(session: SessionSummary): NonNullable<SessionSummary['structuredStatus']> {
  if (session.structuredStatus) return session.structuredStatus;
  const runState = session.hasActiveRun && session.status !== 'failed'
    ? 'running'
    : session.status === 'pending_subagent'
      ? 'idle'
      : (session.status ?? 'idle');
  const pendingSubagentCount = session.pendingSubagentCount ?? 0;
  const childState = pendingSubagentCount > 0 ? 'pending' : 'idle';
  return {
    runState,
    childState,
    pendingSubagentCount,
    hasActiveRun: runState === 'running',
    displayStatus: session.status ?? (childState === 'pending' ? 'pending_subagent' : runState),
  };
}

export function effectiveSessionStatus(session: SessionSummary): SessionSummary['status'] {
  return readStructuredSessionStatus(session).displayStatus;
}

export function sessionStatusLabel(status: SessionSummary['status']) {
  return status === 'pending_subagent' ? 'PendingSub' : status;
}

export function formatAgo(ts?: number) {
  if (!ts) return 'unknown';
  const deltaMs = Date.now() - ts;
  const minutes = Math.max(0, Math.round(deltaMs / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;

  const date = new Date(ts);
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  if (isSameLocalDay(date, new Date())) return `today ${time}`;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameLocalDay(date, yesterday)) return `yesterday ${time}`;

  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date).replace(',', '');
}

function isSameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}


export function agentRank(agentId: string) {
  if (agentId === 'main') return 0;
  if (agentId.endsWith('-pm')) return 0;
  if (agentId.endsWith('-product')) return 1;
  if (agentId.endsWith('-dev')) return 2;
  if (agentId.endsWith('-backend-dev') || agentId.endsWith('-web-dev')) return 2;
  if (agentId.endsWith('-devops')) return 3;
  if (agentId.endsWith('-design') || agentId.endsWith('-ui')) return 4;
  return 50;
}

export function shortAgent(agentId: string) {
  const knownRoles = ['backend-dev', 'web-dev', 'devops', 'product', 'design', 'dev', 'pm', 'ui'];
  const role = knownRoles.find((suffix) => agentId.endsWith(`-${suffix}`));
  return role ? role : agentId;
}


export function displayTitle(session: SessionSummary) {
  const rawTitle = session.title?.trim();
  if (!rawTitle || rawTitle === session.sessionKey || rawTitle.startsWith('agent:')) return friendlySessionName(session);
  return rawTitle.replace(/^agent:/, '');
}

export function friendlySessionName(session: SessionSummary) {
  const rawSessionKey = rawSessionKeyForDisplay(session);
  const parts = rawSessionKey.split(':');
  if (parts[0] === 'agent' && parts.length >= 4) {
    const surface = titleCase(parts[2] ?? 'session');
    const kind = parts[3] ? ` · ${titleCase(parts[3])}` : '';
    return `${surface}${kind}`;
  }
  return compactKey(rawSessionKey);
}

function rawSessionKeyForDisplay(session: SessionSummary) {
  const remoteSessionKey = (session as SessionSummary & { remoteSessionKey?: unknown }).remoteSessionKey;
  if (typeof remoteSessionKey === 'string' && remoteSessionKey.trim()) return remoteSessionKey.trim();
  return decodeWrappedHubSessionKey(session.sessionKey) ?? session.sessionKey;
}

function decodeWrappedHubSessionKey(sessionKey: string) {
  const idx = sessionKey.indexOf(':');
  if (idx <= 0) return undefined;
  const encoded = sessionKey.slice(idx + 1);
  if (!encoded || encoded.includes(':')) return undefined;
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = atob(padded);
    return decoded.includes(':') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function compactKey(key: string) {
  const parts = key.split(':');
  if (parts.length <= 3) return key;
  const tail = parts.at(-1) ?? '';
  return `${parts.slice(0, 3).join(':')}…${tail.slice(0, 8)}`;
}

export function navLabel(tab: Tab) {
  return ({ dashboard: 'Dashboard', sessions: 'Chats', agents: 'Agents', media: 'Media', channels: 'Channels', gateway: 'Gateway', users: 'Users' } as const)[tab];
}

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const candidateWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return candidateWindow.SpeechRecognition ?? candidateWindow.webkitSpeechRecognition;
}

export function getVoiceUnavailableReason(): string | undefined {
  if (!window.isSecureContext) {
    return 'Voice input requires HTTPS or localhost. Open this Hub over HTTPS and allow microphone access.';
  }
  if (!getSpeechRecognitionConstructor()) {
    return 'This browser does not support speech recognition. You can still type and send normally.';
  }
  return undefined;
}

export function defaultDeliveryMode(session: SessionSummary): SendDeliveryMode {
  return isChannelSession(session) ? 'mirror' : 'web-only';
}

export function readDeliveryMode(session: SessionSummary): SendDeliveryMode {
  if (isChannelSession(session)) return 'mirror';
  const stored = window.localStorage.getItem(deliveryModeStorageKey(session.sessionKey));
  return stored === 'web-only' ? 'web-only' : defaultDeliveryMode(session);
}

export function deliveryModeStorageKey(sessionKey: string) {
  return `agentopsdeck.deliveryMode.${sessionKey}`;
}

export function isChannelSession(session: SessionSummary) {
  const parts = session.sessionKey.toLowerCase().split(':');
  const offset = parts[0] === 'agent' ? 2 : 0;
  const channel = parts[offset];
  const shape = parts[offset + 1];
  const to = parts.slice(offset + 2).join(':');
  return Boolean(
    channel === 'feishu'
      && shape
      && to
      && ['direct', 'group', 'channel', 'thread'].includes(shape),
  );
}

export function readHashRoute(): { tab?: Tab; sessionKey?: string; desktop?: boolean } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return {};
  if (raw === 'desktop' || raw === 'os-desktop' || raw === 'tab/desktop') {
    return { tab: 'sessions', desktop: true };
  }
  const [kind, ...rest] = raw.split('/');
  if (kind === 'session' && rest.length > 0) {
    try { return { sessionKey: decodeURIComponent(rest.join('/')) }; }
    catch { return {}; } // Root routing shows the invalid-link view.
  }
  if (kind === 'tab' && isTab(rest[0])) return { tab: rest[0] };
  if (isTab(kind)) return { tab: kind };
  return {};
}

export function writeHashRoute(route: { tab?: Tab; sessionKey?: string; desktop?: boolean }) {
  const isImmersiveDesktop =
    typeof document !== 'undefined' &&
    document.documentElement?.dataset?.osDesktopImmersive === 'true';
  const next = route.sessionKey
    ? `#/session/${encodeURIComponent(route.sessionKey)}`
    : (route.desktop ?? (isImmersiveDesktop && (route.tab ?? 'sessions') === 'sessions'))
      ? '#/desktop'
      : `#/tab/${route.tab ?? 'sessions'}`;
  if (window.location.hash !== next) {
    window.history.replaceState(null, '', next);
    window.dispatchEvent(new CustomEvent('agentopsdeck:route-changed'));
  }
}

export function isTab(value: unknown): value is Tab {
  return value === 'dashboard' || value === 'sessions' || value === 'agents' || value === 'media' || value === 'channels' || value === 'gateway' || value === 'users';
}

export function dashboardMetrics(sessions: SessionsState, agents: AgentSummary[]) {
  const reported = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const agentIds = new Set<string>();
  for (const agent of agents) agentIds.add(agent.id);
  const metrics = {
    sessions: 0, agents: 0, running: 0, failed: 0, messages: 0,
    inputTokens: 0, outputTokens: 0, contextTokens: 0,
    inputReported: 0, outputReported: 0, projectedReported: 0, estimatedTokens: 0,
  };
  for (const group of sessions.groups) {
    agentIds.add(group.agentId);
    for (const session of group.sessions) {
      metrics.sessions++;
      const status = effectiveSessionStatus(session);
      if (status === 'running') metrics.running++;
      if (status === 'failed') metrics.failed++;
      metrics.messages += estimateMessageCount(session);
      if (reported(session.inputTokens)) {
        metrics.inputTokens += session.inputTokens;
        metrics.inputReported++;
      }
      if (reported(session.outputTokens)) {
        metrics.outputTokens += session.outputTokens;
        metrics.outputReported++;
      }
      if (reported(session.totalTokens)) {
        metrics.contextTokens += session.totalTokens;
        metrics.projectedReported++;
      }
      metrics.estimatedTokens += estimateSessionListTokens(session);
    }
  }
  metrics.agents = agentIds.size;
  return metrics;
}

export function sessionMetrics(session: SessionSummary, _messages: ChatMessage[]) {
  return {
    messageCount: sessionMessageCount(session),
    estimatedTokens: estimateSessionListTokens(session),
  };
}

export function estimateMessageCount(session: SessionSummary) {
  return sessionMessageCount(session) ?? 0;
}

export function estimateSessionListTokens(session: SessionSummary) {
  if (Number.isFinite(Number(session.totalTokens))) return Number(session.totalTokens);
  if (Number.isFinite(Number(session.estimatedTokens))) return Number(session.estimatedTokens);
  return estimateTextTokens([session.title, session.recent, session.sessionKey].filter(Boolean).join('\n'));
}

export function estimateMessagesTokens(messages: ChatMessage[]) {
  return messages.reduce((sum, message) => sum + estimateTextTokens(readableText(message.text)), 0);
}

export function estimateTextTokens(text: string) {
  if (!text || text === '(empty)') return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

const numberFormatter = new Intl.NumberFormat('en-US');
const compactNumberFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatNumber(value: number) {
  return numberFormatter.format(Math.round(value));
}

export function formatCompactNumber(value: number | undefined) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return compactNumberFormatter.format(Number(value));
}

export function formatTokenValue(value: number | undefined) {
  return Number.isFinite(Number(value)) ? formatCompactNumber(Number(value)) : 'n/a';
}

export function displayModelName(session: SessionSummary) {
  const raw = [session.modelProvider, session.model].filter(Boolean).join('/') || session.model || 'n/a';
  return raw
    .replace(/^github-copilot\//, '')
    .replace(/^openrouter\//, '')
    .replace(/^anthropic\//, '')
    .replace(/^google\//, '')
    .replace(/^openai\//, '');
}

export { contextUsageValues, formatContextUsage, formatCompactionCount } from './context-usage.js';

export function matchesSessionSearch(session: SessionSummary, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return sessionSearchText(session).includes(needle);
}

function sessionSearchText(session: SessionSummary) {
  return [
    displayTitle(session),
    session.title,
    session.recent,
    session.agentId,
    session.source,
    effectiveSessionStatus(session),
    sessionStatusLabel(effectiveSessionStatus(session)),
    compactKey(session.sessionKey),
    session.sessionKey,
  ].filter(Boolean).join('\n').toLowerCase();
}

export function titleCase(value: string) {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

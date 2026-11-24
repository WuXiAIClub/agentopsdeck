import type { DeckStore } from '../projection/deck-store.js';
import type { SessionExecutionSnapshot, SessionSummary } from '@agentopsdeck/shared';

export type SessionStatusDisplay = Pick<SessionSummary, 'modelProvider' | 'model' | 'inputTokens' | 'outputTokens'
  | 'totalTokens' | 'contextTokens' | 'compactionCount'>;

/** Display metadata is never execution or permission evidence. */
export function sessionStatusText(sessionKey: string, state: { status: SessionExecutionSnapshot['status'];
  hasActiveRun?: SessionExecutionSnapshot['hasActiveRun']; runtime?: SessionExecutionSnapshot['runtime'] },
  session: SessionStatusDisplay | undefined, gateway: string) {
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
  return [
    'AgentOpsDeck status (last known projection, not a live runtime probe)',
    ...(!sessionKey.startsWith('codex:') && !sessionKey.startsWith('hermes:') ? [`- Gateway: ${gateway}`] : []),
    `- Session: ${sessionKey}`,
    `- Status: ${state.status}`,
    `- Active run: ${state.hasActiveRun === undefined ? 'unknown' : state.hasActiveRun ? 'yes' : 'no'}`,
    `- Execution: ${state.runtime?.phase ?? 'unknown'}`,
    `- Runtime connection: ${state.runtime?.connection ?? 'unknown'}`,
    `- Response sync: ${state.runtime?.sync ?? 'unknown'}`,
    `- Model: ${[session?.modelProvider, session?.model].filter(Boolean).join('/') || 'unknown'}`,
    `- Tokens in/out/total: ${[session?.inputTokens, session?.outputTokens, session?.totalTokens].map(count).join(' / ')}`,
    `- Context: ${count(session?.contextTokens)}`,
    `- Compactions: ${count(session?.compactionCount)}`,
  ].join('\n');
}

// A local report, not a native command or terminal run event. Legacy and
// versioned URLs use the same projection without starting either runtime.
export function reportSessionStatus(store: Pick<DeckStore, 'getSessionExecution' | 'getSession' | 'getGateway' | 'addMessage'>,
  sessionKey: string, id: string, input: string) {
  const state = store.getSessionExecution(sessionKey);
  if (!state) return undefined;
  // Usage/model remain display metadata; never use the legacy getter's
  // transcript-derived status to report execution or authorize new work.
  const session = store.getSession(sessionKey);
  const text = sessionStatusText(sessionKey, state, session,
    !sessionKey.startsWith('codex:') && !sessionKey.startsWith('hermes:') ? store.getGateway().status : '');
  const now = Date.now();
  store.addMessage({ id, sessionKey, role: 'user', text: input, status: 'sent', createdAt: now });
  store.addMessage({ id: `local-status:${id}`, sessionKey, role: 'assistant', text, status: 'sent', createdAt: now });
  return { status: 'ok' as const, idempotencyKey: id, deliveryMode: 'web-only' as const, deliver: false, media: [] };
}

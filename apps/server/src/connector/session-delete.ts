import { synchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import type { CodexAppServer } from '../codex/app-server.js';
import type { HermesRuntime } from '../hermes/runtime.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { DeckStore } from '../projection/deck-store.js';
import { isRecord, SessionDeletionConflict } from '../commands/turn-queue.js';

// HTTP adapters retain their own authentication and error envelopes. The
// Connector owns native deletion and projection updates, including for legacy URLs.
export async function deleteConnectorSession(deps: {
  gateway: Pick<GatewayWsClient, 'requestBound'>;
  store: Pick<DeckStore, 'removeSession'>;
  refreshSessions: (options?: { maxAgeMs?: number }) => Promise<void>;
  codex?: Pick<CodexAppServer, 'owns' | 'remove'>;
  hermes?: Pick<HermesRuntime, 'remove'>;
  claude?: { ready: boolean; remove(key: string, authorize: () => void, acknowledge: () => void): Promise<void> };
  copilot?: { ready: boolean; remove(key: string, authorize: () => void, acknowledge: () => void): Promise<void> };
  antigravity?: { ready: boolean; remove(key: string, authorize: () => void, acknowledge: () => void): Promise<void> };
}, sessionKey: string, authorize: () => void, acknowledged: (result: Record<string, unknown>) => void) {
  const guard = () => synchronousEffectAuthority(authorize);
  guard();
  if (sessionKey.startsWith('claude-code:') || sessionKey.startsWith('ghcp:') || sessionKey.startsWith('antigravity:')) {
    const runtime = sessionKey.startsWith('claude-code:') ? deps.claude : sessionKey.startsWith('ghcp:') ? deps.copilot : deps.antigravity;
    if (!runtime?.ready) throw new SessionDeletionConflict('SDK runtime is not ready for deletion');
    await runtime.remove(sessionKey, guard, () => acknowledged({ ok: true, status: 'delete_accepted' }));
    return { ok: true };
  }
  if (sessionKey.startsWith('hermes:')) {
    if (!deps.hermes) throw new SessionDeletionConflict('Hermes is unavailable; enable or upgrade this Connector before deleting');
    await deps.hermes.remove(sessionKey, guard, () => acknowledged({ ok: true, status: 'delete_accepted' }));
    return { ok: true };
  }
  if (deps.codex?.owns(sessionKey)) {
    await deps.codex.remove(sessionKey, guard, () => acknowledged({ ok: true, status: 'delete_accepted' }));
    return { ok: true };
  }
  await deps.refreshSessions({ maxAgeMs: 5_000 }).catch(() => undefined);
  guard();
  // Resolve is not read-only in OpenClaw: it can migrate stored aliases.
  // Describe binds the native canonical key to the receipt/lifecycle key
  // before deletion; never silently retarget an already admitted command.
  const target = await deps.gateway.requestBound('sessions.describe', {
    key: sessionKey, includeDerivedTitles: false, includeLastMessage: false,
  }, undefined, guard);
  guard();
  if (!isRecord(target.payload) || (target.payload.session !== null && (!isRecord(target.payload.session)
    || typeof target.payload.session.key !== 'string' || !target.payload.session.key.trim()))) throw new Error('Invalid session deletion target');
  if (target.payload.session === null || target.payload.session.key !== sessionKey) {
    throw new SessionDeletionConflict('Session deletion requires a current canonical target');
  }
  // Native sessions.delete uses key (unlike chat.send's sessionKey).
  // A failed/lost response never authorizes a second native mutation.
  const { payload } = await deps.gateway.requestBound('sessions.delete', { key: sessionKey }, target.connectionId, guard);
  if (!isRecord(payload) || payload.ok !== true || payload.key !== sessionKey || typeof payload.deleted !== 'boolean') {
    throw new Error('Invalid session deletion acknowledgement');
  }
  // Acceptance is a bounded fact, not a copy of native archive paths/data.
  acknowledged({ ok: true, status: 'delete_accepted' });
  deps.store.removeSession(sessionKey);
  return { ok: true };
}

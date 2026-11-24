import type { SessionSummary, SessionSettingsResult } from '@agentopsdeck/shared';

export type SessionEdit = SessionSettingsResult | { sessionKey: string; pinned: boolean };

export function applySessionEdit(session: SessionSummary, result: SessionEdit): SessionSummary {
  if (session.sessionKey !== result.sessionKey) return session;
  if ('pinned' in result) return { ...session, pinned: result.pinned };
  // An unversioned ACK is a historical outcome, not the current settings.
  // Keep projection/cache unchanged until the ordered snapshot read arrives.
  return session;
}

export type SessionRuntimeDraft = {
  model: string;
  thinking: string;
};

/** Background projections may advance while the user is typing. Sync only clean fields. */
export function reconcileRuntimeDraft(draft: SessionRuntimeDraft, previous: SessionRuntimeDraft, current: SessionRuntimeDraft): SessionRuntimeDraft {
  return {
    model: draft.model === previous.model ? current.model : draft.model,
    thinking: draft.thinking === previous.thinking ? current.thinking : draft.thinking,
  };
}

export function sessionRuntimeDraft(session: SessionSummary): SessionRuntimeDraft {
  const sessionWithRuntime = session as SessionSummary & { thinking?: string; thinkingLevel?: string };
  return {
    // Codex selects its provider separately; a slash may already belong to the
    // provider's actual model ID. Only OpenClaw uses provider-qualified IDs.
    model: session.sessionRef?.runtimeId === 'codex' || session.source === 'codex'
      ? session.model ?? ''
      : session.modelProvider && session.model ? `${session.modelProvider}/${session.model}` : (session.model ?? ''),
    thinking: sessionWithRuntime.thinkingLevel ?? sessionWithRuntime.thinking ?? '',
  };
}

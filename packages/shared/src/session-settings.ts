// A settings ACK is a patch, never a session snapshot. null clears a setting;
// omission leaves it unchanged. Runtime state and message text are not results.
export type SessionSettingsResult = {
  sessionKey: string;
  settings: { title?: string; model?: string | null; modelProvider?: string | null; thinkingLevel?: string | null; goalControl?: 'create' | 'edit' | 'pause' | 'resume' | 'clear' };
};

export function readSessionSettingsResult(value: unknown, sessionKey: string): SessionSettingsResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>, settings = body.settings;
  if (body.sessionKey !== sessionKey || !settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const fields = Object.entries(settings);
  if (fields.length === 1 && fields[0]![0] === 'goalControl') {
    const action = fields[0]![1];
    return typeof action === 'string' && ['create', 'edit', 'pause', 'resume', 'clear'].includes(action)
      ? { sessionKey, settings: { goalControl: action as NonNullable<SessionSettingsResult['settings']['goalControl']> } } : undefined;
  }
  if (!fields.length || fields.some(([key, value]) => !['title', 'model', 'modelProvider', 'thinkingLevel'].includes(key)
    || (value === null ? key === 'title' : typeof value !== 'string' || !value.trim() || value.length > (key === 'title' ? 120 : 4096)))) return undefined;
  // Copy only the bounded settings, ignoring envelope fields from older peers.
  return { sessionKey, settings: Object.fromEntries(fields) };
}

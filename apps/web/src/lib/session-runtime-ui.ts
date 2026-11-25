import type { SessionSummary, SendMessageUpload } from '@agentopsdeck/shared';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';

/** A create receipt may arrive before its directory projection. Preserve the
 * selected runtime so fallback cards never offer OpenClaw-only mutations. */
export function newSessionSource(agentId: string): NonNullable<SessionSummary['source']> {
  return agentId === 'claude-code' || agentId === 'ghcp' || agentId === 'antigravity' || agentId === 'codex' || agentId === 'hermes'
    ? agentId : 'web';
}

/** Conservative UI affordances for the initial owner-only SDK adapters.
 * Server authorization remains authoritative; unknown capability is never
 * interpreted as an OpenClaw model catalog or permission to mutate native. */
export function sessionRuntimeUi(session: Pick<SessionSummary, 'source' | 'controlCapabilities'>) {
  const source = session.source;
  const sdk = source === 'claude-code' || source === 'ghcp' || source === 'antigravity';
  const configuredModel = source === 'hermes';
  return {
    sdk, configuredModel,
    attachments: sdk ? session.controlCapabilities?.attachments === true : !configuredModel,
    compact: source === 'antigravity' ? false : sdk ? session.controlCapabilities?.compact === true : !configuredModel,
    deleteSession: true,
    modelCatalog: configuredModel ? undefined : sdk ? source : source === 'codex' ? 'codex' : 'openclaw',
  };
}

export const sdkAttachmentHint = 'SDK attachments: images or UTF-8 text/data; 5 MiB each, 20 MiB total, 100,000 text characters total.';
export const sdkAttachmentAccept = '.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.yaml,.yml,.xml';
export function sdkAttachmentsSupported(session: Pick<SessionSummary, 'source'>, media: SendMessageUpload[]) {
  if (session.source !== 'claude-code' && session.source !== 'ghcp' && session.source !== 'antigravity') return true;
  let total = 0, textChars = 0;
  return media.length <= 8 && media.every(item => {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(item.dataUrl);
    if (!match || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/markdown', 'text/csv',
      'application/json', 'application/yaml', 'application/xml'].includes(match[1]!)) return false;
    if (item.mimeType !== undefined && item.mimeType !== match[1]) return false;
    const bytes = match[2]!.length * 3 / 4 - (match[2]!.endsWith('==') ? 2 : match[2]!.endsWith('=') ? 1 : 0);
    total += bytes;
    if (bytes <= 0 || bytes > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) return false;
    if (!match[1]!.startsWith('image/')) {
      try {
        const data = Uint8Array.from(atob(match[2]!), char => char.charCodeAt(0));
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        if (text.includes('\0') || (textChars += text.length) > MAX_MESSAGE_CHARS) return false;
      } catch { return false; }
    }
    return true;
  });
}

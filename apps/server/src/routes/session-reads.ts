import type { Hono } from 'hono';
import type { ChatMessage } from '@agentopsdeck/shared';
import type { SessionReadAuthority } from '../auth/session-read-authority.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { EventSnapshotRead } from './events.js';
import { readIndexedToolMessage } from '../codex/indexed-tool-output.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';

const MESSAGE_LIST_DEFAULT_LIMIT = 180;
const MESSAGE_LIST_MAX_LIMIT = 500;

/** Original legacy wire, shared by both roots. Observation does not confer
 * command/transaction authority. close retains the original physical reads. */
export function registerSessionReadRoutes(app: Hono, deps: {
  store: DeckStore;
  refreshSessions(options?: { maxAgeMs?: number }): Promise<void>;
  refreshMessages(key: string, options?: { maxAgeMs?: number }): Promise<void>;
  authority: SessionReadAuthority;
  snapshot?: EventSnapshotRead;
}) {
  const readAuthority = deps.authority;
  const capture: EventSnapshotRead = deps.snapshot ?? (read => read(undefined));
  app.get('/api/sessions/state', (c) => readAuthority.run(c.req.raw, async () => {
    const includeHidden = c.req.query('includeHidden') === '1' || c.req.query('includeHidden') === 'true';
    const includeArchived = c.req.query('includeArchived') === '1' || c.req.query('includeArchived') === 'true';
    await deps.refreshSessions({ maxAgeMs: 2_000 }).catch(() => undefined);
    return capture(() => c.json(deps.store.getSessionsState({ includeHidden, includeArchived })));
  }));

  app.get('/api/sessions/:sessionKey', (c) => readAuthority.run(c.req.raw, async () => {
    await deps.refreshSessions({ maxAgeMs: 2_000 }).catch(() => undefined);
    return capture(() => {
      const session = deps.store.getSession(c.req.param('sessionKey'));
      return session ? c.json(session) : c.json({ error: 'session not found' }, 404);
    });
  }));

  app.get('/api/sessions/:sessionKey/messages', (c) => readAuthority.run(c.req.raw, async () => {
    const sessionKey = c.req.param('sessionKey');
    await deps.refreshMessages(sessionKey, { maxAgeMs: 1_500 }).catch(() => undefined);
    const limit = parseMessageListLimit(c.req.query('limit'));
    const before = c.req.query('before');
    if (before !== undefined && (!before.length || before.length > 4096)) return c.json({ error: 'Invalid history anchor' }, 400);
    return capture(() => {
      const page = deps.store.getMessageHistoryPage(sessionKey, limit, before);
      if (!page) return c.json({ error: 'History anchor unavailable; refresh history' }, 409);
      const messages = summarizeMessagesForList(page.messages, limit);
      return c.json({
        messages,
        totalCount: page.totalCount,
        hiddenCount: page.hiddenCount,
        updatedAt: Date.now(),
        revision: stableGatewayRowsRevision(messages),
      });
    });
  }));

  app.get('/api/sessions/:sessionKey/messages/:messageId', (c) => readAuthority.run(c.req.raw, async check => {
    const sessionKey = c.req.param('sessionKey');
    const messageId = c.req.param('messageId');
    if (!deps.store.hasMessage(sessionKey, messageId)) {
      await deps.refreshMessages(sessionKey, { maxAgeMs: 3_000 }).catch(() => undefined);
    }
    await check();
    const message = await capture(() => deps.store.getMessage(sessionKey, messageId));
    if (!message) return c.json({ error: 'message not found' }, 404);
    let detail;
    try { detail = await readIndexedToolMessage(message); }
    catch { await check(); return c.json({ error: 'Tool detail source changed; refresh history' }, 409); }
    await check();
    return capture(() => {
      if (deps.store.getMessage(sessionKey, messageId) !== message) {
        return c.json({ error: 'Tool detail projection changed; retry' }, 409);
      }
      return c.json({ message: detail, updatedAt: Date.now() });
    });
  }));

  app.get('/api/sessions/:sessionKey/activity', (c) => readAuthority.run(c.req.raw, () =>
    capture(() => c.json({ activity: deps.store.getActivity(c.req.param('sessionKey')), updatedAt: Date.now() }))),
  );


  return { close: () => readAuthority.close(), get pending() { return readAuthority.pending; } };
}

function parseMessageListLimit(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return MESSAGE_LIST_DEFAULT_LIMIT;
  return Math.min(MESSAGE_LIST_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function summarizeMessagesForList(messages: ChatMessage[], limit = MESSAGE_LIST_DEFAULT_LIMIT): ChatMessage[] {
  const visibleMessages = messages.length > limit ? messages.slice(-limit) : messages;
  return visibleMessages.map((message) => {
    if (!isInternalOutputMessage(message)) return message;
    if (message.role === 'tool' && message.toolPhase !== undefined) return message;
    const text = readableText(message.text);
    const lineCount = Math.max(1, text.split('\n').length);
    const preview = text.slice(0, 1_000).split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).join('\n') || '[tool output]';
    return {
      ...message,
      text: preview,
      toolPreview: preview,
      toolDetailAvailable: true,
      toolLineCount: lineCount,
    };
  });
}

function isInternalOutputMessage(message: ChatMessage) {
  if (message.role === 'tool') return true;
  const text = readableText(message.text);
  if (!text || text === '(empty)') return false;
  // Assistant turns stay conversation unless the whole turn is a normalized tool
  // transcript emitted by Gateway. This keeps LLM text visible while still
  // collapsing synthetic [tool ...] assistant rows into the tool timeline.
  if (message.role === 'assistant') return isNormalizedToolTranscript(text);
  return /^(HTTP\/\d|LISTEN\s|Command still running|Process still running|remote:|\[[\w/-]+\s+[0-9a-f]{7}\]|>\s*@agentopsdeck\/|M\s+apps\/|\{\s*"ok"\s*:)/m.test(text);
}

function isNormalizedToolTranscript(text: string) {
  const stripped = text.trim();
  if (!/^\[tool\s+[^\]\n]+\]/i.test(stripped)) return false;
  return /\n\s*tool input:\s*\n/i.test(stripped) || /\n\s*\[tool output\]/i.test(stripped) || /\n\s*(status|error|output):\s*/i.test(stripped);
}

function readableText(value: unknown): string {
  if (typeof value === 'string') return value.trim() || '(empty)';
  if (value === null || value === undefined) return '(empty)';
  if (Array.isArray(value)) return value.map(readableText).filter((item) => item !== '(empty)').join('\n\n') || '(empty)';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readSessionSettingsResult, type SessionSettingsResult } from '@agentopsdeck/shared';
import { registerSettingsReceipts } from '../commands/http.js';
import type { CommandReceipts } from '../commands/receipts.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { CodexAppServer } from '../codex/app-server.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { SessionDeletionConflict } from '../commands/turn-queue.js';
import { readGoalControl } from '@agentopsdeck/shared';
import { GoalControlConflict } from '../codex/goal-control.js';

// Canonical Connector and admin legacy routes share the same native writer.
// The legacy address is presentation only: admission and storage use native IDs.
export function registerSessionSettingsRoutes(app: Hono, path: string, deps: {
  store: DeckStore; gateway: GatewayWsClient; codex?: CodexAppServer;
  receipts: CommandReceipts; actor: (c: Context) => string;
  sessionKey: (c: Context) => string;
  settingsAdmission: (sessionKey: string) => boolean;
  refreshSessions: (options?: { maxAgeMs?: number }) => Promise<void>;
  sdkModelUpdate?: (key: string, model: string | null, authorize: () => void, acknowledge: (model: string) => void) => void;
  sdkSettingsAdmission?: (key: string) => void;
}) {
  app.get(`${path}/goal`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const actor = deps.actor(c), key = deps.sessionKey(c);
      const check = () => {
        if (c.req.raw.signal.aborted) throw new HTTPException(408);
        if (deps.actor(c) !== actor) throw new HTTPException(403);
        if (deps.receipts.sessionDeletion(key)) throw new HTTPException(409);
      };
      check();
      if (!deps.codex?.owns(key) || !deps.store.getSession(key)) return c.json({ error: 'Codex goal unavailable' }, 404);
      return c.json(await deps.codex.readGoalControl(key, check));
    } catch (error) {
      return c.json({ error: 'Goal unavailable; no settings were changed' }, error instanceof HTTPException ? error.status : 409);
    }
  });
  registerSettingsReceipts(app, path, {
    receipts: deps.receipts, sessionKey: deps.sessionKey,
    scope: c => JSON.stringify([deps.actor(c), deps.sessionKey(c)]),
    settingsAdmission: c => deps.settingsAdmission(deps.sessionKey(c)),
    present: (c, receipt) => receipt.result && receipt.state === 'accepted'
      ? { ...receipt, result: { ...receipt.result, body: { ...receipt.result.body, sessionKey: c.req.param('sessionKey') } } } : receipt,
  });
  app.patch(path, async c => {
    // An admitted receipt is not evidence that a settings write was sent.
    // In particular, a failed native preflight GET must not permanently fence
    // the message queue. Never infer this boundary from the HTTP status alone.
    let writeMayHaveStarted = false;
    try {
      const actor = deps.actor(c), sessionKey = deps.sessionKey(c);
      const authorize = () => {
        if (c.req.raw.signal.aborted) throw new HTTPException(408, { message: 'Request interrupted' });
        if (deps.actor(c) !== actor) throw new HTTPException(403, { message: 'Session authorization changed' });
        if (deps.receipts.sessionDeletion(sessionKey)) throw new HTTPException(409, { message: 'Session lifecycle conflict' });
      };
      const begin = () => { authorize(); c.get('beginSettingsWrite')(); writeMayHaveStarted = true; };
      const acknowledge = (settings: SessionSettingsResult['settings']) => {
        const body = readSessionSettingsResult({ sessionKey, settings }, sessionKey);
        if (!body) throw new Error('Invalid settings acknowledgement');
        c.get('acknowledgeSettings')({ status: 200, body });
      };
      authorize();
      await deps.refreshSessions({ maxAgeMs: 5_000 }).catch(() => undefined);
      authorize();
      const body = c.get('settingsPayload');
      if (Object.hasOwn(body, 'goal')) {
        const control = readGoalControl(body.goal);
        if (Object.keys(body).length !== 1 || !control) return c.json({ error: 'Invalid goal control' }, 400);
        if (!deps.codex?.owns(sessionKey) || !deps.store.getSession(sessionKey)) return c.json({ error: 'Codex goal unavailable' }, 404);
        await deps.codex.changeGoal(sessionKey, control, authorize, begin, () => acknowledge({ goalControl: control.action }));
        return c.json({ ok: true });
      }
      if (['claude-code', 'ghcp'].includes(sessionRuntimeId(sessionKey))) {
        if (!deps.sdkSettingsAdmission) return c.json({ error: 'SDK settings are unavailable' }, 409);
        deps.sdkSettingsAdmission(sessionKey);
      }
      if (!Object.hasOwn(body, 'model')) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) return c.json({ error: 'Invalid session title' }, 400);
        if (!deps.store.getSession(sessionKey)) return c.json({ error: 'Session not found' }, 404);
        begin();
        deps.store.renameSession(sessionKey, body.title, session => acknowledge({ title: session.title }));
        return c.json({ ok: true }); // Middleware returns the persisted ACK only.
      }
      const model = body.model === null ? null : typeof body.model === 'string' ? body.model.trim() : undefined;
      if (sessionKey.startsWith('hermes:')) return c.json({ error: 'Configure Hermes model settings in its dedicated home' }, 409);
      const thinking = body.thinking === null ? null : typeof body.thinking === 'string' ? body.thinking.trim() : undefined;
      if (model === undefined || model === '' || (model?.length ?? 0) > 4096
        || (Object.hasOwn(body, 'thinking') && (thinking === undefined || thinking === '' || (thinking?.length ?? 0) > 4096))) return c.json({ error: 'Invalid session settings' }, 400);
      if (['claude-code', 'ghcp'].includes(sessionRuntimeId(sessionKey))) {
        if (!deps.sdkModelUpdate) return c.json({ error: 'SDK model settings are unavailable' }, 409);
        if (thinking !== undefined && thinking !== null) return c.json({ error: 'SDK thinking overrides are not supported' }, 400);
        // The SDK callback currently reports a transactional ACK, not the
        // start of the write. Preserve uncertainty if that adapter throws.
        writeMayHaveStarted = true;
        deps.sdkModelUpdate(sessionKey, model, authorize, applied => {
          begin();
          acknowledge({ model: applied, modelProvider: null });
        });
      } else if (deps.codex?.owns(sessionKey)) {
        // Model IDs belong to the selected native provider, not a AgentOpsDeck-wide
        // vendor allowlist. Syntax/length is checked above; native validates use.
        if (!deps.store.getSession(sessionKey)) return c.json({ error: 'Session not found' }, 404);
        begin();
        deps.codex.updateSessionRuntime(sessionKey, { model, ...(thinking !== undefined ? { thinking } : {}) }, session => acknowledge({
          model: session.model || null, modelProvider: session.modelProvider ?? null,
          ...(thinking !== undefined ? { thinkingLevel: thinking === null ? null : session.thinkingLevel ?? thinking } : {}),
        }));
      } else {
        const current = deps.store.getSession(sessionKey);
        const { payload: result } = await deps.gateway.requestBound<{ resolved?: { model?: string; modelProvider?: string; thinkingLevel?: string; thinking?: string } }>('sessions.patch', {
          key: sessionKey, model, ...(current?.agentId ? { agentId: current.agentId } : {}),
          ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
        }, undefined, begin);
        const appliedThinking = thinking === undefined || thinking === null ? thinking
          : result?.resolved?.thinkingLevel?.trim() || result?.resolved?.thinking?.trim() || thinking;
        acknowledge({ model: result?.resolved?.model ?? model, modelProvider: result?.resolved?.modelProvider ?? null,
          ...(appliedThinking !== undefined ? { thinkingLevel: appliedThinking } : {}) });
        // Native ACK is durable before any local projection/config failure.
        deps.store.persistSessionThinkingOverride(sessionKey, appliedThinking);
        await deps.refreshSessions({ maxAgeMs: 0 }).catch(() => undefined);
      }
      return c.json({ ok: true });
    } catch (error) {
      // The request has unwound without reaching any write boundary. A 5xx
      // receipt cannot express this evidence (it intentionally means unknown),
      // so reject this intent durably instead. Same-key recovery never replays
      // it; a future explicit settings action needs a new preflight and key.
      if (!writeMayHaveStarted && !(error instanceof SessionDeletionConflict || error instanceof GoalControlConflict)
        && !(error instanceof HTTPException && error.status < 500)) {
        return c.json({ error: 'Settings preflight failed; no settings write was dispatched' }, 409);
      }
      // Keep prewrite denials machine-readable for receipt settlement. The
      // middleware preserves unknown after dispatch and an already stored ACK.
      return error instanceof SessionDeletionConflict || error instanceof GoalControlConflict ? c.json({ error: error.message }, 409)
        : error instanceof HTTPException ? c.json({ error: error.message }, error.status)
        : c.json({ error: 'Settings write could not be confirmed' }, 502);
    }
  });
}

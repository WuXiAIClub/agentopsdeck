import type { DeckStore } from '../projection/deck-store.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import type { OpenClawQueuedTurn } from './turn-queue.js';
import { TurnAuthorizationError } from '../commands/turn-queue.js';
import type { AuthorizeTurn } from '../connector/execution-grants.js';
import type { OpenClawExecutions } from './executions.js';
import type { MirrorOutbox } from '../messages/mirror.js';
import { agentIdFromSessionKey, localOpenClawCliSessionKey, shouldUseOpenClawCliFallback, startOpenClawAgentFallback } from './cli.js';

// One runtime writer, shared by idle admissions and queued turns. HTTP routes
// never invoke this directly; only the Connector worker may dispatch a turn.
export function createOpenClawDispatch(options: {
  gateway: GatewayWsClient;
  store: DeckStore;
  allowCliFallback: boolean;
  message: (text: string) => string;
  authorizeTurn: AuthorizeTurn;
  executions: OpenClawExecutions;
  mirrorOutbox?: MirrorOutbox;
  onSettled?: () => void;
  startCli?: typeof startOpenClawAgentFallback;
}) {
  const cliLifetimes = new Set<Promise<void>>();
  let stopped = false, closing: Promise<void> | undefined;
  const assertOpen = () => { if (stopped) throw new Error('OpenClaw dispatch closed'); };
  const dispatch = async (input: OpenClawQueuedTurn, attachments: unknown[]) => {
    const turn = structuredClone(input);
    assertOpen();
    const { sessionKey, id: idempotencyKey, payload } = turn;
    const { store } = options;
    const target = { runtime: 'openclaw' as const, sessionKey };
    const authorized = () => options.authorizeTurn(payload.actorId, target, 'messages:send', payload.executionGrant)
      && (payload.deliveryMode !== 'mirror' || options.authorizeTurn(payload.actorId, target, 'messages:mirror', payload.executionGrant));
    if (!authorized()) throw new TurnAuthorizationError();
    const expected = options.executions.get(sessionKey);
    const beforeSend = () => {
      assertOpen();
      const current = options.executions.get(sessionKey);
      if (!expected || !current || current.commandId !== idempotencyKey || current.origin !== 'gateway'
        || current.phase !== 'starting' || current.reason || current.runId
        || current.revision !== expected.revision) throw new Error('OpenClaw dispatch ownership changed before send');
      if (!authorized()) throw new TurnAuthorizationError();
    };
    try {
      const reply = await options.gateway.requestBound('agent', { sessionKey, message: options.message(payload.message),
        deliver: false, idempotencyKey, attachments }, undefined, beforeSend);
      if (!options.executions.bindGatewayConnection(sessionKey, idempotencyKey, reply.connectionId)) {
        throw new Error('OpenClaw dispatch identity changed before connection binding');
      }
      return reply.payload;
    } catch (error) {
      // A lost ACK must never trigger a second runtime invocation.
      if (!options.allowCliFallback || !shouldUseOpenClawCliFallback(error, 'agent') || attachments.length) throw error;
      if (!authorized()) throw new TurnAuthorizationError();
      beforeSend();
      if (!options.executions.useCli(sessionKey, idempotencyKey)) throw new Error('OpenClaw CLI dispatch identity unavailable');
      const session = store.getSession(sessionKey);
      const cliSessionKey = localOpenClawCliSessionKey(sessionKey, session?.agentId);
      const agentId = session?.agentId ?? agentIdFromSessionKey(cliSessionKey) ?? 'main';
      const started = await (options.startCli ?? startOpenClawAgentFallback)(cliSessionKey, agentId, sessionKey, payload.message, idempotencyKey, (result) => {
        try {
          if (!options.executions.finishCli(sessionKey, idempotencyKey, result.ok ? 'completed' : 'failed', db => {
            if (!result.ok || payload.deliveryMode !== 'mirror'
              || options.executions.get(sessionKey)?.phase !== 'completed') return;
            if (!options.mirrorOutbox || !payload.explicitRoute) throw new Error('Mirror native reply admission missing');
            options.mirrorOutbox.recordCliReplyInTransaction(db, { sessionKey, idempotencyKey, after: turn.createdAt,
              inputText: payload.message, explicitRoute: payload.explicitRoute,
              ...(payload.actorId ? { actorId: payload.actorId } : {}),
              ...(payload.executionGrant ? { executionGrant: payload.executionGrant } : {}) }, result.replyText);
          })) return;
          if (options.executions.get(sessionKey)?.phase !== (result.ok ? 'completed' : 'failed')) {
            store.projectOpenClawExecution(sessionKey);
            return;
          }
          const now = Date.now();
          if (result.ok) {
            for (const message of result.messages) store.addMessage(message);
            if (!result.messages.some((message) => message.role === 'assistant' && message.text.trim())) {
              store.addMessage({ id: `cli:${idempotencyKey}:assistant`, sessionKey, role: 'assistant',
                text: result.text || '(no assistant text returned)', createdAt: now, updatedAt: now, status: 'sent' });
            }
          } else store.addMessage({ id: `cli:${idempotencyKey}:failed`, sessionKey, role: 'assistant',
            text: result.error, createdAt: now, updatedAt: now, status: 'failed', failureReason: result.error });
          store.upsertSession({ sessionKey, agentId, title: session?.title ?? 'Remote CLI session',
            recent: result.ok ? result.text : result.error, status: result.ok ? 'idle' : 'failed', source: 'web', lastActiveAt: now });
          store.projectOpenClawExecution(sessionKey);
        } catch { store.invalidateOpenClawExecutionFacts(); }
        finally { options.onSettled?.(); }
      }, lifetime => {
        cliLifetimes.add(lifetime);
        void lifetime.then(() => cliLifetimes.delete(lifetime), () => cliLifetimes.delete(lifetime));
      });
      if (!started.ok) throw new Error(started.error);
      return { status: 'started', fallback: 'openclaw-cli', cliSessionKey };
    }
  };
  return Object.assign(dispatch, {
    stopAdmissions: () => { stopped = true; },
    drainCli: () => Promise.allSettled([...cliLifetimes]).then(() => {}),
    close: () => {
      stopped = true;
      return closing ??= Promise.allSettled([...cliLifetimes]).then(() => {});
    },
  });
}

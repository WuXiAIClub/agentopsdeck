import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { codexAdmissionMatches } from '../codex/dispatch-admission.js';
import { createTurnAuthorizer } from './execution-grants.js';
import { validConnectorCodexDispatchInput, type ConnectorCodexDispatchCommands } from './connector-codex-dispatch-domain.js';
import { validCodexQueuePayload, type CodexQueuePayload } from './connector-codex-queue-plan-domain.js';
import { BOARD_CONTEXT_MAX_CHARS } from './workspace-board-file-format.js';
import { LOCAL_FILE_BOARD_OWNER, type FileBoardPolicy } from './workspace-board-file-policy.js';
import { workspaceFileContext } from './workspace-file-context.js';

type Ref = ConnectorCodexDispatchCommands['codexDispatchReady']['input'];
export type ConnectorCodexContextCommands = {
  codexQueueContext: { input: Ref; output: (Ref & { context: string }) | null };
};
export const connectorCodexContextSteps = Object.freeze({ codexQueueContext: 258 });
export const isConnectorCodexContextKind = (kind: string): kind is keyof ConnectorCodexContextCommands => kind === 'codexQueueContext';
export const validConnectorCodexContextInput = (v: unknown): v is Ref => validConnectorCodexDispatchInput('codexDispatchReady', v);
export function validConnectorCodexContextOutput(v: unknown): boolean {
  if (v === null) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'context')) return false;
  const { context, ...ref } = v as Ref & { context: unknown };
  return typeof context === 'string' && context.length <= BOARD_CONTEXT_MAX_CHARS && validConnectorCodexContextInput(ref);
}
export function codexContextReplyMatches(input: Ref, v: NonNullable<ConnectorCodexContextCommands['codexQueueContext']['output']>): boolean {
  return v.sessionKey === input.sessionKey && v.commandId === input.commandId && v.connectionId === input.connectionId
    && v.proof.count === input.proof.count && v.proof.digest === input.proof.digest;
}

/** The original FIFO proof supplies identity, never caller actor/authorized
 * flags. Grant checks may persist revocation, so this is NOT a projection read.
 * Constructors create original schema only: no watcher, file write or timer. */
export function createConnectorCodexContextCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore, policy?: FileBoardPolicy) {
  const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
  const allowed = (actor: string, key: string) => key.startsWith('codex:')
    && !!policy?.policies.some(p => p.owner === actor && p.runtime === 'codex')
    && !owner.commands.sessionDeletion(key) && tokens?.hasScope(actor, 'boards:files') === true
    && authorize(actor === LOCAL_FILE_BOARD_OWNER ? 'local:daily' : actor, { runtime: 'codex', sessionKey: key }, 'messages:send');
  const boards = policy ? owner.createFileBoards(policy.root, allowed) : undefined;
  const cards = policy ? owner.createFileCards(policy.root, allowed) : undefined;
  return (input: Ref): ConnectorCodexContextCommands['codexQueueContext']['output'] => {
    if (!validConnectorCodexContextInput(input) || !tokens) throw Error('connector_storage_unavailable');
    if (!owner.sdkCommandAdmissionOpen || owner.commands.sessionDeletion(input.sessionKey)
      || owner.codexExecutions.isDeletedTerminal(input.sessionKey)) return null;
    const fact = owner.codexExecutions.get(input.sessionKey);
    const continuing = fact?.commandId === input.commandId && fact.connectionId === input.connectionId
      && fact.phase === 'starting' && fact.preparation === 'ready' && !fact.reason && !fact.runId;
    const entries = codexAdmissionMatches<CodexQueuePayload>(owner.turns, input.sessionKey, input.proof,
      entry => validCodexQueuePayload(entry.payload) && !!authorize(entry.payload.actorId,
        { runtime: 'codex', sessionKey: input.sessionKey }, 'messages:send', entry.payload.executionGrant), continuing ? 'dispatching' : 'queued');
    if (!entries || entries[0]?.id !== input.commandId) return null;
    const original = entries[0]!.payload;
    const context = workspaceFileContext(boards, cards, allowed, input.sessionKey, original.actorId, original.executionGrant);
    return { ...input, proof: { ...input.proof }, context };
  };
}

import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { createTurnAuthorizer, type ExecutionGrantAuthority } from './execution-grants.js';
import { TurnAuthorizationError } from '../commands/turn-queue.js';
import { admitCodexQueued, settleCodexDispatchFailure, codexAdmissionMatches, CodexAdmissionConflict, type CodexAdmissionProof } from '../codex/dispatch-admission.js';
import type { CodexBatch } from '../codex/queued-batch.js';
import { validTurnContextProof, type TurnContextProof } from '../codex/turn-context.js';
import type { CodexExecution, CodexDispatchFailureExpected, CodexDispatchFailureOutcome } from '../codex/executions.js';
import { validConnectorExecutionOutput } from './connector-execution-domain.js';
import { validOwnedThreadLoadInput, type OwnedThreadLoadInput } from '../codex/owned-thread-load.js';
import { validNativeResumeReceipt, type NativeResumeReceipt } from '../codex/native-resume.js';

type Ref = { sessionKey: string; commandId: string; connectionId: string; proof: CodexAdmissionProof };
type PreparationRef = Ref & { revision: number };
export type ConnectorCodexDispatchCommands = {
  codexOwnedLoadBegin: { input: OwnedThreadLoadInput; output: NativeResumeReceipt | null };
  codexOwnedLoadAcknowledge: { input: NativeResumeReceipt; output: boolean };
  codexOwnedLoadFinish: { input: NativeResumeReceipt; output: boolean };
  codexDispatchClaim: { input: Ref & { preparing: boolean; blockedGoalInput: boolean; batch?: CodexBatch; context?: TurnContextProof;
    predecessor?: CodexDispatchFailureExpected };
    output: { proof: CodexAdmissionProof; execution: CodexExecution; completionOwnerId?: string } | null };
  codexDispatchReady: { input: Ref; output: boolean };
  codexPreparationReady: { input: PreparationRef; output: boolean };
  codexPreparationFinish: { input: PreparationRef; output: boolean };
  codexDispatchFailure: { input: { sessionKey: string; commandId: string; proof: CodexAdmissionProof;
    expected: CodexDispatchFailureExpected; failure: 'authorization' | 'compaction_authorization' | 'unknown' }; output: CodexDispatchFailureOutcome | null };
};
export type ConnectorCodexDispatchKind = keyof ConnectorCodexDispatchCommands;
export const connectorCodexDispatchSteps = Object.freeze({ codexDispatchClaim: 215, codexDispatchReady: 216, codexDispatchFailure: 221,
  codexPreparationReady: 244, codexPreparationFinish: 245, codexOwnedLoadBegin: 366,
  codexOwnedLoadAcknowledge: 367, codexOwnedLoadFinish: 368 });
export const isConnectorCodexDispatchKind = (kind: string): kind is ConnectorCodexDispatchKind => Object.hasOwn(connectorCodexDispatchSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, any> => !!v && typeof v === 'object'
  && !Array.isArray(v) && required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const id = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && !/[\x00-\x1f\x7f]/.test(v)
  && Buffer.byteLength(JSON.stringify(v)) <= max;
const proof = (v: unknown): v is CodexAdmissionProof => fields(v, ['count', 'digest']) && Number.isSafeInteger(v.count)
  && v.count >= 1 && v.count <= 16 && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest);
function batch(v: unknown): v is CodexBatch {
  return fields(v, ['separator', 'members']) && typeof v.separator === 'string' && !!v.separator && v.separator.length <= 512
    && Array.isArray(v.members) && v.members.length >= 2 && v.members.length <= 16 && v.members.every((m: unknown) =>
      fields(m, ['id', 'createdAt', 'imageCount']) && id(m.id, 512) && typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)
      && Number.isSafeInteger(m.imageCount) && m.imageCount >= 0 && m.imageCount <= 8);
}
export function validConnectorCodexDispatchInput(kind: ConnectorCodexDispatchKind, v: unknown): boolean {
  if (kind === 'codexOwnedLoadBegin') return validOwnedThreadLoadInput(v);
  if (kind === 'codexOwnedLoadAcknowledge' || kind === 'codexOwnedLoadFinish') return validNativeResumeReceipt(v);
  if (kind === 'codexPreparationReady' || kind === 'codexPreparationFinish') {
    return fields(v, ['sessionKey', 'commandId', 'connectionId', 'proof', 'revision'])
      && id(v.sessionKey, 4096) && v.sessionKey.startsWith('codex:') && id(v.commandId, 512) && id(v.connectionId, 128)
      && proof(v.proof) && Number.isSafeInteger(v.revision) && v.revision >= 1;
  }
  if (kind === 'codexDispatchFailure') return fields(v, ['sessionKey', 'commandId', 'proof', 'expected', 'failure'])
    && id(v.sessionKey, 4096) && v.sessionKey.startsWith('codex:') && id(v.commandId, 512) && proof(v.proof)
    && (v.failure === 'authorization' || v.failure === 'compaction_authorization' || v.failure === 'unknown')
    && (v.expected === null || fields(v.expected, ['commandId', 'connectionId', 'revision'])
      && id(v.expected.commandId, 512) && id(v.expected.connectionId, 128)
      && Number.isSafeInteger(v.expected.revision) && v.expected.revision >= 1);
  return fields(v, ['sessionKey', 'commandId', 'connectionId', 'proof', ...(kind === 'codexDispatchClaim' ? ['preparing', 'blockedGoalInput'] : [])],
    kind === 'codexDispatchClaim' ? ['batch', 'context', 'predecessor'] : []) && id(v.sessionKey, 4096) && v.sessionKey.startsWith('codex:')
    && id(v.commandId, 512) && id(v.connectionId, 128) && proof(v.proof)
    && (kind !== 'codexDispatchClaim' || typeof v.preparing === 'boolean' && typeof v.blockedGoalInput === 'boolean'
      && (v.predecessor === undefined || v.predecessor === null || fields(v.predecessor, ['commandId', 'connectionId', 'revision'])
        && id(v.predecessor.commandId, 512) && id(v.predecessor.connectionId, 128)
        && Number.isSafeInteger(v.predecessor.revision) && v.predecessor.revision >= 1)
      && (v.batch === undefined || batch(v.batch)) && (v.context === undefined || fields(v.context, ['hash', 'originalLength'])
        && !v.preparing && validTurnContextProof(v.context as TurnContextProof)));
}
export function validConnectorCodexDispatchOutput(kind: ConnectorCodexDispatchKind, v: unknown): boolean {
  if (kind === 'codexOwnedLoadBegin') return v === null || validNativeResumeReceipt(v);
  if (kind === 'codexDispatchFailure') return v === null || v === 'blocked' || v === 'outcome_unknown';
  return kind !== 'codexDispatchClaim' ? typeof v === 'boolean' : v === null || fields(v, ['proof', 'execution'], ['completionOwnerId']) && proof(v.proof)
    && validConnectorExecutionOutput('codexExecutionRead', v.execution) && v.execution.phase === 'starting'
    && !v.execution.runId && !v.execution.reason
    && (v.completionOwnerId === undefined || id(v.completionOwnerId, 512) && !v.execution.batch && !v.execution.preparation);
}
/** Shape validation alone must not bind a foreign claim to this executor. */
export function connectorCodexDispatchReplyMatches(input: ConnectorCodexDispatchCommands['codexDispatchClaim']['input'],
  value: ConnectorCodexDispatchCommands['codexDispatchClaim']['output']): boolean {
  return value === null || value.execution.sessionKey === input.sessionKey && value.execution.commandId === input.commandId
    && value.execution.connectionId === input.connectionId && value.proof.count === input.proof.count
    && value.execution.preparation === (input.preparing ? 'active' : undefined)
    && (input.batch === undefined ? value.execution.batch === undefined : !!value.execution.batch
      && value.execution.batch.separator === input.batch.separator
      && value.execution.batch.members.length === input.batch.members.length
      && value.execution.batch.members.every((member, index) => {
        const original = input.batch!.members[index]!;
        return member.id === original.id && member.createdAt === original.createdAt && member.imageCount === original.imageCount;
      }));
}
type Payload = { text: string; images: unknown[]; actorId?: string; executionGrant?: ExecutionGrantAuthority };
export function executeConnectorCodexDispatch<K extends ConnectorCodexDispatchKind>(kind: K,
  input: ConnectorCodexDispatchCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorCodexDispatchCommands[K]['output'] {
  if (!validConnectorCodexDispatchInput(kind, input) || !tokens) throw Error('connector_storage_unavailable');
  const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens.hasScope(actor, scope));
  const authorized = (entry: { sessionKey: string; payload: Payload }) =>
    typeof entry.payload?.text === 'string' && Array.isArray(entry.payload.images) && entry.payload.images.length <= 8
    && authorize(entry.payload.actorId, { runtime: 'codex', sessionKey: entry.sessionKey }, 'messages:send', entry.payload.executionGrant);
  const allowed = (entry: { sessionKey: string; payload: Payload }) => owner.sdkCommandAdmissionOpen === true && authorized(entry);
  const preparationAuthorized = (entry: { sessionKey: string; payload: Payload }) => authorized(entry)
    && authorize(entry.payload.actorId, { runtime: 'codex', sessionKey: entry.sessionKey }, 'runs:compact', entry.payload.executionGrant);
  const preparationAllowed = (entry: { sessionKey: string; payload: Payload }) => owner.sdkCommandAdmissionOpen === true && preparationAuthorized(entry);
  let value: unknown;
  const loadAllowed = (v: OwnedThreadLoadInput) => {
    const entries = codexAdmissionMatches<Payload>(owner.turns, v.sessionKey, v.proof, allowed, 'dispatching');
    const fact = owner.codexExecutions.get(v.sessionKey);
    return !!entries && entries[0]?.id === v.commandId
      && JSON.stringify(entries.map(e => e.id)) === JSON.stringify(fact?.batch?.members.map(m => m.id) ?? [v.commandId]);
  };
  if (kind === 'codexOwnedLoadBegin') {
    value = owner.codexExecutions.ownedThreadLoads.begin(input as OwnedThreadLoadInput, loadAllowed);
  } else if (kind === 'codexOwnedLoadAcknowledge') {
    value = owner.codexExecutions.ownedThreadLoads.acknowledge(input as NativeResumeReceipt);
  } else if (kind === 'codexOwnedLoadFinish') {
    value = owner.codexExecutions.ownedThreadLoads.finish(input as NativeResumeReceipt, loadAllowed);
  } else if (kind === 'codexDispatchClaim') {
    const v = input as ConnectorCodexDispatchCommands['codexDispatchClaim']['input'];
    try { value = admitCodexQueued<Payload>(owner, v.sessionKey, v.commandId, v.connectionId, v.proof,
      v.preparing ? preparationAllowed : allowed, v); }
    catch (error) {
      if (!(error instanceof CodexAdmissionConflict || error instanceof TurnAuthorizationError)) throw error;
      value = null; // Proven pre-dispatch refusal, never replay or release a claim.
    }
    // Capture the original single-row identity before ACK consumes the FIFO.
    // This is completion provenance, NOT an authorization snapshot. Mixed,
    // batched and delegated turns retain the original no-trigger behavior.
    if (value && !v.preparing && !v.batch) {
      const entries = codexAdmissionMatches<Payload>(owner.turns, v.sessionKey, (value as { proof: CodexAdmissionProof }).proof,
        allowed, 'dispatching');
      const original = entries?.length === 1 && entries[0]?.id === v.commandId ? entries[0].payload : undefined;
      if (original?.actorId && !original.executionGrant
        && owner.turns.interactionOwner('codex', v.sessionKey, [v.commandId]) === original.actorId) {
        value = { ...(value as NonNullable<ConnectorCodexDispatchCommands['codexDispatchClaim']['output']>),
          completionOwnerId: original.actorId };
      }
    }
  } else if (kind === 'codexPreparationReady' || kind === 'codexPreparationFinish') {
    const v = input as PreparationRef;
    const matches = (fact: CodexExecution | undefined) => !!fact && fact.sessionKey === v.sessionKey
      && fact.commandId === v.commandId && fact.connectionId === v.connectionId && fact.revision === v.revision
      && fact.phase === 'starting' && fact.preparation === 'active' && !fact.runId && !fact.reason;
    const checkQueue = () => {
      const entries = codexAdmissionMatches<Payload>(owner.turns, v.sessionKey, v.proof, preparationAllowed, 'dispatching');
      if (!entries || entries[0]?.id !== v.commandId) throw new CodexAdmissionConflict();
      const fact = owner.codexExecutions.get(v.sessionKey);
      if (JSON.stringify(entries.map(e => e.id)) !== JSON.stringify(fact?.batch?.members.map(m => m.id) ?? [v.commandId]))
        throw new CodexAdmissionConflict();
    };
    try {
      if (!matches(owner.codexExecutions.get(v.sessionKey))) value = false;
      else if (kind === 'codexPreparationReady') { checkQueue(); value = true; }
      else value = owner.codexExecutions.finishPreparation(v, () => { checkQueue(); });
    } catch (error) {
      if (!(error instanceof CodexAdmissionConflict || error instanceof TurnAuthorizationError)) throw error;
      value = false;
    }
  } else if (kind === 'codexDispatchFailure') {
    const v = input as ConnectorCodexDispatchCommands['codexDispatchFailure']['input'];
    value = settleCodexDispatchFailure<Payload>(owner, v.sessionKey, v.commandId, v.expected, v.proof,
      v.failure !== 'unknown', v.failure === 'compaction_authorization' ? preparationAuthorized : allowed);
  } else {
    const v = input as ConnectorCodexDispatchCommands['codexDispatchReady']['input'];
    const fact = owner.codexExecutions.get(v.sessionKey);
    value = !!fact && fact.commandId === v.commandId && fact.connectionId === v.connectionId
      && fact.phase === 'starting' && !fact.runId && !fact.reason && !fact.preparation
      && !owner.codexExecutions.nativeResumes.pending(v.sessionKey)
      && !!codexAdmissionMatches<Payload>(owner.turns, v.sessionKey, v.proof, allowed, 'dispatching');
  }
  if (!validConnectorCodexDispatchOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorCodexDispatchCommands[K]['output'];
}

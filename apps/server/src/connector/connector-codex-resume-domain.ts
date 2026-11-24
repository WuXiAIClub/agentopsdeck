import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { createTurnObserver } from './execution-grants.js';
import { validCodexQueuePayload } from './connector-codex-queue-plan-domain.js';
import { validNativeResumeInput, validNativeResumeReceipt, type NativeResumeInput, type NativeResumeReceipt } from '../codex/native-resume.js';

export type ConnectorCodexResumeCommands = {
  codexResumePrepare: { input: NativeResumeInput; output: NativeResumeReceipt | null };
  codexResumeBegin: { input: NativeResumeReceipt; output: boolean };
  codexResumeFinish: { input: { receipt: NativeResumeReceipt; outcome: 'acknowledged' | 'not_dispatched' }; output: boolean };
};
export type ConnectorCodexResumeKind = keyof ConnectorCodexResumeCommands;
export const connectorCodexResumeSteps = Object.freeze({ codexResumePrepare: 252, codexResumeBegin: 253, codexResumeFinish: 254 });
export const isConnectorCodexResumeKind = (kind: string): kind is ConnectorCodexResumeKind => Object.hasOwn(connectorCodexResumeSteps, kind);
export function validConnectorCodexResumeInput(kind: ConnectorCodexResumeKind, v: unknown): boolean {
  if (kind === 'codexResumePrepare') return validNativeResumeInput(v);
  if (kind === 'codexResumeBegin') return validNativeResumeReceipt(v);
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 2) return false;
  const p = v as Record<string, unknown>;
  return validNativeResumeReceipt(p.receipt) && typeof p.outcome === 'string'
    && ['acknowledged', 'not_dispatched'].includes(p.outcome);
}
export function validConnectorCodexResumeOutput(kind: ConnectorCodexResumeKind, v: unknown): boolean {
  return kind === 'codexResumePrepare' ? v === null || validNativeResumeReceipt(v) : typeof v === 'boolean';
}
export function executeConnectorCodexResume<K extends ConnectorCodexResumeKind>(kind: K,
  input: ConnectorCodexResumeCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  maintenance?: () => void): ConnectorCodexResumeCommands[K]['output'] {
  if (!validConnectorCodexResumeInput(kind, input)) throw Error('connector_storage_unavailable');
  const authorize = createTurnObserver(owner.executionGrants, (actor, scope) => tokens?.hasScope(actor, scope) === true);
  // Called INSIDE the original intent transaction on prepare AND begin. Never
  // accept an actor, authority boolean or stale queue-plan grant from caller.
  const current = (p: NativeResumeInput) => {
    maintenance?.(); // Original intent transaction, not a preflight snapshot.
    if (owner.commands.sessionDeletion(p.expected.sessionKey)) return false;
    if (!p.continuation) return true; // Read-only predecessor recovery, no user continuation authority.
    const head = owner.turns.head<unknown>('codex', p.expected.sessionKey);
    return owner.sdkCommandAdmissionOpen === true && head?.state === 'queued'
      && head.id === p.continuation.headId && owner.turns.version('codex', p.expected.sessionKey, head.id) === p.continuation.headVersion
      && validCodexQueuePayload(head.payload)
      && authorize(head.payload.actorId, { runtime: 'codex', sessionKey: p.expected.sessionKey }, 'messages:send', head.payload.executionGrant);
  };
  const resumes = owner.codexExecutions.nativeResumes;
  const value = kind === 'codexResumePrepare' ? resumes.prepare(input as NativeResumeInput, current)
    : kind === 'codexResumeBegin' ? resumes.begin(input as NativeResumeReceipt, current)
      : resumes.finish((input as ConnectorCodexResumeCommands['codexResumeFinish']['input']).receipt,
        (input as ConnectorCodexResumeCommands['codexResumeFinish']['input']).outcome);
  if (!validConnectorCodexResumeOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorCodexResumeCommands[K]['output'];
}

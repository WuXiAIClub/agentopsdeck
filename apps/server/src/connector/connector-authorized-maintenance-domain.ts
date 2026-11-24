import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorCodexResume, validConnectorCodexResumeInput, validConnectorCodexResumeOutput,
  type ConnectorCodexResumeCommands } from './connector-codex-resume-domain.js';
import { createConnectorMaintenanceCommands, isConnectorMaintenanceKind, validConnectorMaintenanceInput,
  validConnectorMaintenanceOutput, type ConnectorMaintenanceCommands, type ConnectorMaintenanceKind } from './connector-maintenance-domain.js';
import { createUpdateOperatorVerifier, UpdateOperatorDenied, validConnectorUpdateInput,
  type UpdateOperatorEvidence } from './connector-update-domain.js';

type Request = { [K in ConnectorMaintenanceKind]: UpdateOperatorEvidence & {
  actorId: string; kind: K; input: ConnectorMaintenanceCommands[K]['input'];
} }[ConnectorMaintenanceKind];
type Value = { [K in ConnectorMaintenanceKind]: { kind: K; value: ConnectorMaintenanceCommands[K]['output'] } }[ConnectorMaintenanceKind];
type ResumeKind = 'codexResumePrepare' | 'codexResumeBegin';
type ResumeRequest = { [K in ResumeKind]: UpdateOperatorEvidence & { actorId: string; kind: K;
  input: ConnectorCodexResumeCommands[K]['input'] } }[ResumeKind];
type ResumeValue = { [K in ResumeKind]: { kind: K; value: ConnectorCodexResumeCommands[K]['output'] } }[ResumeKind];
export type ConnectorAuthorizedMaintenanceCommands = {
  runtimeMaintenanceAuthorized: { input: Request; output: { status: 200; value: Value } | { status: 403; error: 'authority' } };
  runtimeMaintenanceResumeAuthorized: { input: ResumeRequest; output: { status: 200; value: ResumeValue } | { status: 403; error: 'authority' } };
};
const fields = (v: unknown, names: string[]): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === names.length
  && names.every(name => Object.hasOwn(v, name));
export function validAuthorizedMaintenanceInput(v: unknown): v is Request {
  if (!fields(v, ['authorization', 'expectedNode', 'protocol', 'originPresent', 'actorId', 'kind', 'input'])
    || typeof v.kind !== 'string' || !isConnectorMaintenanceKind(v.kind)) return false;
  return validConnectorUpdateInput('updateOperatorCheck', { authorization: v.authorization,
    expectedNode: v.expectedNode, protocol: v.protocol, originPresent: v.originPresent, actorId: v.actorId, mode: 'readiness' })
    && validConnectorMaintenanceInput(v.kind, v.input);
}
export function validAuthorizedMaintenanceOutput(v: unknown): boolean {
  return fields(v, ['status', 'error']) && v.status === 403 && v.error === 'authority'
    || fields(v, ['status', 'value']) && v.status === 200 && fields(v.value, ['kind', 'value'])
      && typeof v.value.kind === 'string' && isConnectorMaintenanceKind(v.value.kind)
      && validConnectorMaintenanceOutput(v.value.kind, v.value.value);
}
export function validAuthorizedMaintenanceResumeInput(v: unknown): v is ResumeRequest {
  return fields(v, ['authorization', 'expectedNode', 'protocol', 'originPresent', 'actorId', 'kind', 'input'])
    && (v.kind === 'codexResumePrepare' || v.kind === 'codexResumeBegin')
    && validConnectorUpdateInput('updateOperatorCheck', { authorization: v.authorization,
      expectedNode: v.expectedNode, protocol: v.protocol, originPresent: v.originPresent, actorId: v.actorId, mode: 'readiness' })
    && validConnectorCodexResumeInput(v.kind, v.input);
}
export function validAuthorizedMaintenanceResumeOutput(v: unknown): boolean {
  return fields(v, ['status', 'error']) && v.status === 403 && v.error === 'authority'
    || fields(v, ['status', 'value']) && v.status === 200 && fields(v.value, ['kind', 'value'])
      && (v.value.kind === 'codexResumePrepare' || v.value.kind === 'codexResumeBegin')
      && validConnectorCodexResumeOutput(v.value.kind, v.value.value);
}
/** Only original prepare/begin. ACK settlement deliberately uses the original
 * receipt domain, independent of a subsequently revoked operator. */
export function createAuthorizedMaintenanceResume(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const operator = createUpdateOperatorVerifier(owner, tokens);
  return (input: ResumeRequest): ConnectorAuthorizedMaintenanceCommands['runtimeMaintenanceResumeAuthorized']['output'] => {
    if (!validAuthorizedMaintenanceResumeInput(input)) throw Error('Invalid maintenance resume command');
    try {
      const value = executeConnectorCodexResume(input.kind, input.input, owner, tokens, () => {
        owner.requireMaintenanceOwner();
        operator(input, 'readiness', input.actorId);
      });
      return { status: 200, value: { kind: input.kind, value } as ResumeValue };
    } catch (error) {
      if (error instanceof UpdateOperatorDenied) return { status: 403, error: 'authority' };
      throw error;
    }
  };
}
/** Fixed private root domain, not an arbitrary owner/SQL tunnel. Authentication
 * and original maintenance work share the sole worker transaction. */
export function createAuthorizedMaintenanceCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const operator = createUpdateOperatorVerifier(owner, tokens), execute = createConnectorMaintenanceCommands(owner);
  return (input: Request): ConnectorAuthorizedMaintenanceCommands['runtimeMaintenanceAuthorized']['output'] => {
    if (!validAuthorizedMaintenanceInput(input)) throw Error('Invalid maintenance command');
    try {
      const value = owner.maintenanceTransaction(input.kind === 'runtimeMaintenanceInteractions',
        () => { operator(input, 'readiness', input.actorId); }, () => execute(input.kind, input.input));
      return { status: 200, value: { kind: input.kind, value } as Value };
    } catch (error) {
      if (error instanceof UpdateOperatorDenied) return { status: 403, error: 'authority' };
      throw error;
    }
  };
}

import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validRuntimeReadInput, validRuntimeReadOutput, executeRuntimeRead,
  type RuntimeReadScope, type RuntimeReadIdentity, type RuntimeReadFailure } from './connector-runtime-read-domain.js';

export type OpenClawReadScope = RuntimeReadScope;
export type OpenClawReadIdentity = RuntimeReadIdentity;
export type OpenClawReadFailure = RuntimeReadFailure;
export type ConnectorOpenClawReadCommands = {
  openClawReadAuthorize: { input: OpenClawReadScope; output: OpenClawReadIdentity | OpenClawReadFailure };
  openClawReadDeliver: { input: OpenClawReadScope & { readerId: string }; output: OpenClawReadIdentity | OpenClawReadFailure };
};
export type ConnectorOpenClawReadKind = keyof ConnectorOpenClawReadCommands;
export const connectorOpenClawReadSteps = Object.freeze({ openClawReadAuthorize: 213, openClawReadDeliver: 214 });
export const isConnectorOpenClawReadKind = (kind: string): kind is ConnectorOpenClawReadKind => Object.hasOwn(connectorOpenClawReadSteps, kind);
export function validConnectorOpenClawReadInput(kind: ConnectorOpenClawReadKind, v: unknown): boolean {
  return validRuntimeReadInput('openclaw', kind === 'openClawReadDeliver', v);
}
export function validConnectorOpenClawReadOutput(_kind: ConnectorOpenClawReadKind, v: unknown): boolean {
  return validRuntimeReadOutput('openclaw', v);
}
/** Original public OpenClaw reads require messages:read only. Do not import
 * send/delegation policy or infer native idleness from a display projection. */
export function executeConnectorOpenClawRead<K extends ConnectorOpenClawReadKind>(kind: K,
  input: ConnectorOpenClawReadCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorOpenClawReadCommands[K]['output'] {
  return executeRuntimeRead('openclaw', kind === 'openClawReadDeliver', input, owner, tokens);
}

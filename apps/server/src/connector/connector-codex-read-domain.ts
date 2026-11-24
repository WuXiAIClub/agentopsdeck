import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validRuntimeReadInput, validRuntimeReadOutput, executeRuntimeRead,
  type RuntimeReadScope, type RuntimeReadIdentity, type RuntimeReadFailure } from './connector-runtime-read-domain.js';

export type CodexReadScope = RuntimeReadScope;
export type ConnectorCodexReadCommands = {
  codexReadAuthorize: { input: CodexReadScope; output: RuntimeReadIdentity | RuntimeReadFailure };
  codexReadDeliver: { input: CodexReadScope & { readerId: string }; output: RuntimeReadIdentity | RuntimeReadFailure };
};
export type ConnectorCodexReadKind = keyof ConnectorCodexReadCommands;
export const connectorCodexReadSteps = Object.freeze({ codexReadAuthorize: 239, codexReadDeliver: 240 });
export const isConnectorCodexReadKind = (kind: string): kind is ConnectorCodexReadKind => Object.hasOwn(connectorCodexReadSteps, kind);
export function validConnectorCodexReadInput(kind: ConnectorCodexReadKind, v: unknown): boolean {
  return validRuntimeReadInput('codex', kind === 'codexReadDeliver', v);
}
export function validConnectorCodexReadOutput(_kind: ConnectorCodexReadKind, v: unknown): boolean {
  return validRuntimeReadOutput('codex', v);
}
export function executeConnectorCodexRead<K extends ConnectorCodexReadKind>(kind: K,
  input: ConnectorCodexReadCommands[K]['input'], owner: ConnectorUserStore,
  tokens?: ConnectorTokenStore): ConnectorCodexReadCommands[K]['output'] {
  return executeRuntimeRead('codex', kind === 'codexReadDeliver', input, owner, tokens);
}

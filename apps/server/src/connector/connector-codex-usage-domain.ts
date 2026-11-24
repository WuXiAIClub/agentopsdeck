import { isDeepStrictEqual } from 'node:util';
import type { NativeTokenCounts } from '@agentopsdeck/shared';
import type { CodexExecution } from '../codex/executions.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validConnectorExecutionOutput } from './connector-execution-domain.js';
import { nativeTokenCounts } from './native-token-usage.js';

export type CodexCumulativeUsageInput = {
  sessionKey: string; connectionId: string; runId: string;
  expected: CodexExecution | null; counts: NativeTokenCounts;
};
export type ConnectorCodexUsageCommands = {
  codexCumulativeUsage: { input: CodexCumulativeUsageInput; output: boolean };
};
export type ConnectorCodexUsageKind = keyof ConnectorCodexUsageCommands;
export const connectorCodexUsageSteps = Object.freeze({ codexCumulativeUsage: 279 });
export const isConnectorCodexUsageKind = (kind: string): kind is ConnectorCodexUsageKind => Object.hasOwn(connectorCodexUsageSteps, kind);
const id = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim()
  && !/[\x00-\x1f\x7f]/.test(v) && Buffer.byteLength(JSON.stringify(v)) <= max;
export function validConnectorCodexUsageInput(_kind: ConnectorCodexUsageKind, v: unknown): v is CodexCumulativeUsageInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as CodexCumulativeUsageInput;
  return Object.keys(p).length === 5 && ['sessionKey', 'connectionId', 'runId', 'expected', 'counts'].every(k => Object.hasOwn(p, k))
    && id(p.sessionKey, 4096) && p.sessionKey.startsWith('codex:') && p.sessionKey.length > 6 && id(p.connectionId, 128) && id(p.runId, 512)
    && (p.expected === null || validConnectorExecutionOutput('codexExecutionRead', p.expected) && p.expected.sessionKey === p.sessionKey)
    && !!nativeTokenCounts(p.counts) && isDeepStrictEqual(p.counts, nativeTokenCounts(p.counts));
}
export const validConnectorCodexUsageOutput = (_kind: ConnectorCodexUsageKind, v: unknown): v is boolean => typeof v === 'boolean';
/** Observation only. No queue mutation, execution transition or dispatch authority. */
export function executeConnectorCodexUsage(kind: ConnectorCodexUsageKind, input: CodexCumulativeUsageInput, owner: ConnectorUserStore): boolean {
  if (!validConnectorCodexUsageInput(kind, input)) throw Error('connector_storage_unavailable');
  if (owner.commands.sessionDeletion(input.sessionKey) || owner.codexExecutions.isDeletedTerminal(input.sessionKey)) return false;
  const current = owner.codexExecutions.get(input.sessionKey) ?? null;
  if (!isDeepStrictEqual(current, input.expected)) return false;
  if (current && (current.preparation || current.reason || current.runId !== input.runId || current.connectionId !== input.connectionId
    || !(current.phase === 'running' || ['completed', 'failed', 'interrupted'].includes(current.phase) && current.sync === 'current'))) return false;
  owner.tokenUsage.cumulative(input.sessionKey, input.runId, input.counts);
  return true;
}

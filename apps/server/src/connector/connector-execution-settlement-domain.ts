import type { CodexExecution } from '../codex/executions.js';
import { acknowledgeCodexDispatch } from '../codex/dispatch-admission.js';
import { validConnectorExecutionOutput, type ExecutionOwner } from './connector-execution-domain.js';

type Command = { sessionKey: string; commandId: string };
export type ConnectorExecutionSettlementCommands = {
  codexExecutionAcknowledge: { input: Command & { connectionId: string; runId: string }; output: boolean };
  openClawExecutionAcknowledge: { input: Command & (
    { transport: 'gateway'; connectionId: string; runId: string | null } |
    { transport: 'cli' }); output: boolean };
  openClawExecutionFinishCli: { input: Command & { phase: 'completed' | 'failed' }; output: boolean };
  codexExecutionFinishPreparation: { input: { expected: Pick<CodexExecution, 'sessionKey' | 'commandId' | 'connectionId' | 'revision'> }; output: boolean };
};
export type ConnectorExecutionSettlementKind = keyof ConnectorExecutionSettlementCommands;
export const connectorExecutionSettlementSteps = Object.freeze({
  codexExecutionAcknowledge: 58, openClawExecutionAcknowledge: 59,
  openClawExecutionFinishCli: 60, codexExecutionFinishPreparation: 61,
});
export const isConnectorExecutionSettlementKind = (kind: string): kind is ConnectorExecutionSettlementKind => Object.hasOwn(connectorExecutionSettlementSteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && keys.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => keys.includes(key));
const codexId = (v: unknown, limit = 4096): v is string => typeof v === 'string' && !!v.trim()
  && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.byteLength(JSON.stringify(v)) <= limit;
const rawId = (v: unknown, limit = 4096): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= limit;
export function validConnectorExecutionSettlementInput(kind: ConnectorExecutionSettlementKind, value: unknown): boolean {
  const v = value as Record<string, unknown>;
  switch (kind) {
    case 'codexExecutionAcknowledge': return fields(value, ['sessionKey', 'commandId', 'connectionId', 'runId'])
      && codexId(v.sessionKey) && codexId(v.commandId, 512) && codexId(v.connectionId, 128) && codexId(v.runId, 512);
    case 'openClawExecutionAcknowledge': return (fields(value, ['sessionKey', 'commandId', 'transport']) && v.transport === 'cli'
      || fields(value, ['sessionKey', 'commandId', 'transport', 'connectionId', 'runId']) && v.transport === 'gateway'
        && rawId(v.connectionId, 512) && (v.runId === null || rawId(v.runId, 512)))
      && rawId(v.sessionKey) && rawId(v.commandId, 512);
    case 'openClawExecutionFinishCli': return fields(value, ['sessionKey', 'commandId', 'phase'])
      && rawId(v.sessionKey) && rawId(v.commandId, 512) && (v.phase === 'completed' || v.phase === 'failed');
    case 'codexExecutionFinishPreparation': return fields(value, ['expected'])
      && fields(v.expected, ['sessionKey', 'commandId', 'connectionId', 'revision'])
      && codexId(v.expected.sessionKey) && codexId(v.expected.commandId, 512) && codexId(v.expected.connectionId, 128)
      && Number.isSafeInteger(v.expected.revision) && Number(v.expected.revision) > 0;
  }
}
export const validConnectorExecutionSettlementOutput = (_kind: ConnectorExecutionSettlementKind, value: unknown): value is boolean => typeof value === 'boolean';

/** An ACK settles an already admitted command, never grants dispatch authority.
 * Original journals, evidence sinks and queue deletion share ONE original
 * transaction. Queue IDs come only from its stored command/batch, never caller
 * lists. No await or external callback occurs between lookup and settlement.
 * Revision CAS is intentionally not used for ACK: early native observations
 * may advance the revision before the original ACK arrives. */
export function executeConnectorExecutionSettlement<K extends ConnectorExecutionSettlementKind>(kind: K,
  input: ConnectorExecutionSettlementCommands[K]['input'], owner: ExecutionOwner): boolean {
  if (!validConnectorExecutionSettlementInput(kind, input)) throw Error('connector_storage_unavailable');
  switch (kind) {
    case 'codexExecutionAcknowledge': {
      const v = input as ConnectorExecutionSettlementCommands['codexExecutionAcknowledge']['input'];
      const fact = owner.codexExecutions.get(v.sessionKey);
      if (!fact) return false;
      if (!validConnectorExecutionOutput('codexExecutionRead', fact) || fact.sessionKey !== v.sessionKey) throw Error('connector_storage_unavailable');
      if (fact.commandId !== v.commandId || fact.connectionId !== v.connectionId) return false;
      if (fact.batch && (fact.batch.members[0]?.id !== fact.commandId
        || fact.batch.members.some(member => !codexId(member.id, 512))
        || Buffer.byteLength(JSON.stringify({ sessionKey: fact.sessionKey, commandId: fact.commandId, connectionId: fact.connectionId, batch: fact.batch })) > 4800))
        throw Error('connector_storage_unavailable');
      return acknowledgeCodexDispatch(owner, v.sessionKey, v.commandId, v.connectionId, v.runId);
    }
    case 'openClawExecutionAcknowledge': {
      const v = input as ConnectorExecutionSettlementCommands['openClawExecutionAcknowledge']['input'];
      const fact = owner.openClawExecutions.get(v.sessionKey);
      if (!fact) return false;
      if (!validConnectorExecutionOutput('openClawExecutionRead', fact) || fact.sessionKey !== v.sessionKey) throw Error('connector_storage_unavailable');
      if (fact.commandId !== v.commandId || fact.origin !== v.transport) return false;
      const commit = (db: Parameters<ExecutionOwner['turns']['completeInTransaction']>[0]) => owner.turns.completeInTransaction(db, 'openclaw', fact.commandId);
      if (v.transport === 'cli') return owner.openClawExecutions.acknowledgeCli(v.sessionKey, v.commandId, commit);
      // A replaced Gateway must not bind an ACK received on the old connection.
      if (fact.gatewayConnectionId !== v.connectionId) return false;
      return owner.openClawExecutions.acknowledge(v.sessionKey, v.commandId, v.runId, commit);
    }
    case 'openClawExecutionFinishCli': {
      const v = input as ConnectorExecutionSettlementCommands['openClawExecutionFinishCli']['input'];
      return owner.openClawExecutions.finishCli(v.sessionKey, v.commandId, v.phase);
    }
    case 'codexExecutionFinishPreparation': {
      const v = input as ConnectorExecutionSettlementCommands['codexExecutionFinishPreparation']['input'];
      return owner.codexExecutions.finishPreparation(v.expected);
    }
  }
  throw Error('connector_storage_unavailable');
}

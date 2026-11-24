import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ConnectorExecutionSettlementCommands } from './connector-execution-settlement-domain.js';
import { AsyncConnectorExecutionObservations } from './async-execution-observations.js';
import type { ConnectorNativeReplyCommands } from './connector-native-reply-domain.js';

/** Candidate sole-owner facade. An ACK Promise is durable settlement only,
 * not dispatch authorization; callers must fence local epochs after awaits.
 * Lost ACKs are outcome-unknown, never automatically replayed. Do not activate
 * alongside a legacy ConnectorUserStore writer. */
export class AsyncConnectorExecutionSettlements {
  readonly codex;
  readonly openclaw;
  constructor(owner: AsyncConnectorOwner) {
    const observations = new AsyncConnectorExecutionObservations(owner);
    this.codex = {
      ...observations.codex,
      acknowledge: (sessionKey: string, commandId: string, connectionId: string, runId: string) =>
        owner.command('codexExecutionAcknowledge', { sessionKey, commandId, connectionId, runId }),
      finishPreparation: (expected: ConnectorExecutionSettlementCommands['codexExecutionFinishPreparation']['input']['expected']) =>
        owner.command('codexExecutionFinishPreparation', { expected }),
    };
    this.openclaw = {
      ...observations.openclaw,
      acknowledge: (input: ConnectorExecutionSettlementCommands['openClawExecutionAcknowledge']['input']) =>
        owner.command('openClawExecutionAcknowledge', input),
      finishCli: (sessionKey: string, commandId: string, phase: 'completed' | 'failed') =>
        owner.command('openClawExecutionFinishCli', { sessionKey, commandId, phase }),
      finishCliReply: (input: ConnectorNativeReplyCommands['openClawCliFinalReply']['input']) =>
        owner.command('openClawCliFinalReply', input),
      observeFinalReply: (input: ConnectorNativeReplyCommands['openClawGatewayFinalReply']['input']) =>
        owner.command('openClawGatewayFinalReply', input),
    };
  }
}

import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { connectorHermesReplyMatches, validConnectorHermesExecutionOutput,
  type ConnectorHermesExecutionCommands, type ConnectorHermesExecutionKind, type HermesReplyExpectation } from './connector-hermes-execution-domain.js';
import type { HermesExecution, HermesToolObservation } from '../hermes/journal.js';
import type { HermesHistoryRow } from '../hermes/history.js';
import { settleHermesTerminal, type HermesTerminalNative, type HermesTerminalPhase } from '../hermes/terminal-settlement.js';
import { AsyncHermesHistory } from './async-hermes-history.js';

/** Original-owner-only native evidence facade. No prompt authority, SQL,
 * native effect or retry. Startup must not open a parallel synchronous writer. */
export class AsyncHermesExecution {
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>) {}
  private async call<K extends ConnectorHermesExecutionKind>(kind: K, input: ConnectorHermesExecutionCommands[K]['input'], expected: HermesReplyExpectation) {
    const result = await this.owner.command(kind, input);
    if (!validConnectorHermesExecutionOutput(kind, result) || !connectorHermesReplyMatches(expected, result)) throw new ConnectorOwnerUnavailable();
    return result;
  }
  read(sessionKey: string) { return this.call('hermesExecutionRead', { sessionKey }, { sessionKey }); }
  page(after = '', limit = 64) { return this.call('hermesExecutionPage', { after, limit }, { after, limit }); }
  recoverPage(after = '', limit = 64) { return this.call('hermesRecoveryPage', { after, limit }, { after, limit }); }
  async admitted(execution: HermesExecution) { return (await this.call('hermesExecutionAdmitted', { execution }, execution)).changed; }
  async unknown(execution: HermesExecution) { return (await this.call('hermesExecutionUnknown', { execution }, execution)).changed; }
  async tool(execution: HermesExecution, observation: HermesToolObservation) {
    const expected = { key: execution.key, id: execution.id, live: execution.live, epoch: execution.epoch,
      tool: { id: observation.toolId, phase: observation.phase } };
    return (await this.call('hermesExecutionTool', { execution, observation }, expected)).message;
  }
  async terminal(execution: HermesExecution, phase: 'completed' | 'failed' | 'interrupted', stored: string, rows: HermesHistoryRow[]) {
    return (await this.call('hermesExecutionTerminal', { execution, phase, stored, rows }, execution)).changed;
  }
  settle(execution: HermesExecution, phase: HermesTerminalPhase, native: HermesTerminalNative) {
    return settleHermesTerminal(execution, phase, this, new AsyncHermesHistory(this.owner), native);
  }
}

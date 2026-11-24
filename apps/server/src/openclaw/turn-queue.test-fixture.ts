import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { OpenClawTurnQueue } from './turn-queue.js';

export function createTestTurnQueue(options: Pick<ConstructorParameters<typeof OpenClawTurnQueue>[0], 'store'>
  & Partial<Omit<ConstructorParameters<typeof OpenClawTurnQueue>[0], 'store' | 'turns' | 'executions'>>) {
  const database = new ConnectorUserStore(':memory:');
  const queue = new OpenClawTurnQueue({ authorizeTurn: () => true, turns: database.turns, executions: database.openClawExecutions, mirrorOutbox: database.mirrorOutbox, refreshSessions: async () => {}, refreshMessages: async () => {},
    send: async () => { throw new Error('Unexpected test dispatch'); }, mirror: async () => {}, ...options });
  return { queue, commands: database.commands, turns: database.turns, executions: database.openClawExecutions,
    canChangeSettings: (key: string) => database.canChangeSettings(key),
    canDeleteSession: (key: string) => database.canDeleteSession(key), close: async () => { await queue.close(); database.close(); } };
}

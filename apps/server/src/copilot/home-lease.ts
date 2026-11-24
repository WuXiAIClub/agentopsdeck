import { PrivateAgentHomeLease } from '../connector/private-agent-home-lease.js';

export type CopilotHomeLease = PrivateAgentHomeLease;
export const CopilotHomeLease = {
  acquire: (home: string, storeFile: string, nodeId: string) => PrivateAgentHomeLease.acquire('ghcp', home, storeFile, nodeId),
};

import { PrivateAgentHomeLease } from '../connector/private-agent-home-lease.js';

// Preserve the existing Claude marker names and binding wire format.
export type ClaudeHomeLease = PrivateAgentHomeLease;
export const ClaudeHomeLease = {
  acquire: (home: string, storeFile: string, nodeId: string) => PrivateAgentHomeLease.acquire('claude-code', home, storeFile, nodeId),
};

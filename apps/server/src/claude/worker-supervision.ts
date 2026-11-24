// Compatibility exports preserve the Claude call sites and ownership tests.
export { linuxProcessGroup, privateWorkerGroupEmpty as claudeWorkerGroupEmpty,
  waitForPrivateWorkerGroup as waitForClaudeWorkerGroup } from '../connector/private-worker-supervision.js';

import type { CommandReceipt } from './index.js';

export type ConnectorLifecycleOperation = 'restart' | 'upgrade';
export type ConnectorLifecycleJob = {
  id: string;
  nodeId: string;
  operation: ConnectorLifecycleOperation;
  stage: 'prepare' | 'drain' | 'fence' | 'recheck' | 'unfence' | 'stop' | 'stopped' | 'backup'
    | 'activate' | 'start' | 'ready' | 'release' | 'succeeded' | 'attention' | 'cancelled';
  createdAt: number;
  deadline: number;
  revision: number;
  reason?: 'deadline' | 'interrupted' | 'invalid_evidence' | 'operation_failed' | 'authorization_changed';
};
export type ConnectorLifecycleStatus = { configured: false } | {
  configured: true;
  nodeId: string;
  operations: ConnectorLifecycleOperation[];
  blocked: boolean;
  automaticUpdates: false;
  workerState: 'running' | 'halted' | 'stopping';
  job?: ConnectorLifecycleJob;
};
/** Admission is distinct from completion. Missing observation is not failure
 * and must not offer a retry with a new command identity. */
export type ConnectorLifecycleReceipt = { command: CommandReceipt; job?: ConnectorLifecycleJob; observationUnavailable: boolean };

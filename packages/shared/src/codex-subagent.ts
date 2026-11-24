/** Display observations only; never authority for scheduling, permissions or drain. */
export type CodexSubagentStep = {
  id: string;
  kind: 'tool' | 'assistant' | 'reasoning' | 'status';
  title: string;
  detail?: string;
  status: 'running' | 'done' | 'error';
  updatedAt?: number;
};

export type CodexSubagentObservation = {
  action: 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent' | 'started' | 'interacted' | 'interrupted';
  source: 'live' | 'history';
  /** Receipt time of a native event, NOT a native execution start timestamp. */
  observedAt?: number;
  task?: string;
  agents: Array<{
    id: string;
    path?: string;
    status: 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound' | 'unknown';
    message?: string;
    currentStep?: string;
    latestText?: string;
    turnStatus?: 'running' | 'completed' | 'failed' | 'interrupted';
    steps?: CodexSubagentStep[];
  }>;
};

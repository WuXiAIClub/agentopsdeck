type SessionListStatus = 'idle' | 'running' | 'failed' | 'waiting' | 'pending_subagent' | 'unknown';

export function sessionListPrimaryStatusLabel(params: {
  status: SessionListStatus;
  runningLabel?: string | undefined;
  completionUnseen?: boolean | undefined;
  compact?: boolean | undefined;
  outcome?: 'completed' | 'failed' | 'interrupted' | undefined;
}) {
  if (params.outcome === 'failed') return 'Failed';
  if (params.outcome === 'interrupted') return 'Interrupted';
  if (params.completionUnseen) return 'Done · unread';
  if (params.outcome === 'completed') return 'Done';
  return params.runningLabel ?? sessionStatusLabel(params.status);
}

function sessionStatusLabel(status: SessionListStatus) {
  return status === 'pending_subagent' ? 'PendingSub' : status === 'running' ? 'run' : status;
}

export function copilotManualCompactId(value: unknown): string | undefined {
  const event = value as Record<string, any>;
  if (event?.type !== 'session.compaction_complete' || event.agentId !== undefined
    || event.data?.parentToolCallId !== undefined || event.data?.success !== true || event.data?.trigger !== 'manual') return;
  if (typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(event.id)) throw new Error('Invalid compact event identity');
  return event.id;
}

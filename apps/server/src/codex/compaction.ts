// Bounded evidence for one explicit compaction, not a command/native ACK binding.
// Shapes verified with Codex 0.147.0 app-server generate-ts (isolated, offline).
export type CompactionEvidence = {
  turnId?: string; itemId?: string; itemCompleted?: boolean;
  terminal?: 'completed' | 'failed' | 'interrupted'; failure?: string;
};
const identity = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(JSON.stringify(value)) <= 512;

export function observeCompaction(state: CompactionEvidence, method: string, params: any, previousRunId?: string) {
  if (state.failure) return;
  const turnId = method === 'turn/completed' ? params?.turn?.id : params?.turnId;
  if (!identity(turnId) || turnId === previousRunId) return;
  if ((method === 'item/started' || method === 'item/completed') && params?.item?.type === 'contextCompaction') {
    const itemId = params.item.id;
    if (!identity(itemId) || (!state.itemId && method !== 'item/started')) return;
    if (state.itemId && (state.itemId !== itemId || state.turnId !== turnId)) {
      state.failure = 'Codex compaction identity is ambiguous'; return;
    }
    state.turnId = turnId; state.itemId = itemId;
    if (method === 'item/completed') state.itemCompleted = true;
  }
  if (method === 'turn/completed' && state.turnId === turnId) {
    const status = params?.turn?.status;
    if (!['completed', 'failed', 'interrupted'].includes(status)) return;
    if (state.terminal && state.terminal !== status) state.failure = 'Codex compaction outcomes conflict';
    state.terminal = status;
    if (status !== 'completed') state.failure = `Codex compaction ${status}`;
  }
}

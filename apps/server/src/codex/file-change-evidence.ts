import { normalizeSourceFiles, type SourceFileChange } from '@agentopsdeck/shared';

export function completedFileChanges(item: unknown): SourceFileChange[] {
  if (!item || typeof item !== 'object') return [];
  const native = item as Record<string, unknown>;
  if (native.type !== 'fileChange' || native.status !== 'completed' || native.error || native.success === false
    || !Array.isArray(native.changes)) return [];
  return normalizeSourceFiles(native.changes.slice(0, 64).map(change => {
    const kind = typeof change?.kind === 'object' ? change?.kind?.type : change?.kind;
    return { path: change?.path, kind: kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : kind === 'update' ? 'modified' : undefined };
  }));
}

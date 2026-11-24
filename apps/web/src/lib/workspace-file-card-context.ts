import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import type { WorkspaceFileCard, WorkspaceFileCardKind } from '@agentopsdeck/shared';

export type FileCardDocument = WorkspaceFileCard & { revision: number };
export type FileCardSettings = { capture: () => WorkspaceFileCard; apply: (value: WorkspaceFileCard) => void; available: () => boolean };
export const WorkspaceFileCardContext = createContext<{
  document?: FileCardDocument; register(settings: FileCardSettings): () => void;
  registerGuard(ready: () => boolean): () => void;
} | null>(null);

export function useFileCardGuard(ready: () => boolean) {
  const register = useContext(WorkspaceFileCardContext)?.registerGuard, latest = useRef(ready);
  useLayoutEffect(() => { latest.current = ready; });
  useLayoutEffect(() => register?.(() => latest.current()), [register]);
}

/** Register live declarative fields only. An Agent update is NOT an apply event.
 * The owner must explicitly choose "Use file settings"; no effect below invokes
 * the registered apply function or starts any service. */
type CardFor<K extends WorkspaceFileCardKind, C = WorkspaceFileCard> = C extends WorkspaceFileCard
  ? K extends C['kind'] ? C & { kind: K } : never : never;
export function useFileCardSettings<K extends WorkspaceFileCardKind>(kind: K, content: CardFor<K>['content'],
  apply: (value: CardFor<K>['content']) => void, available = true) {
  const context = useContext(WorkspaceFileCardContext), latest = useRef({ content, apply, available });
  latest.current = { content, apply, available };
  useEffect(() => context?.register({ capture: () => ({ kind, content: latest.current.content }) as WorkspaceFileCard,
    apply: value => { if (value.kind === kind) (latest.current.apply as (content: WorkspaceFileCard['content']) => void)(value.content); }, available: () => latest.current.available }), [context?.register, kind]);
  return context?.document?.kind === kind ? context.document as CardFor<K> & { revision: number } : undefined;
}

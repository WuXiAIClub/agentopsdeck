import { BOARD_CONTEXT_MAX_CHARS } from './workspace-board-file-format.js';
import { LOCAL_FILE_BOARD_OWNER } from './workspace-board-file-policy.js';

type ContextSource = { contextForSession(owner: string, sessionKey: string): string };
/** Original ordinary context only. Reading bindings does not install files,
 * grant execution, enqueue hidden input or authorize a delegated principal. */
export function workspaceFileContext(boards: ContextSource | undefined, cards: ContextSource | undefined,
  allowed: (owner: string, key: string) => boolean, key: string, actorId?: string, delegated?: unknown): string {
  if (!boards || !actorId || delegated) return '';
  const owner = actorId === 'local:daily' ? LOCAL_FILE_BOARD_OWNER : actorId;
  if (!allowed(owner, key)) return '';
  const text = [boards.contextForSession(owner, key), cards?.contextForSession(owner, key)].filter(Boolean).join('\n\n');
  if (text.length > BOARD_CONTEXT_MAX_CHARS) throw new Error('Workspace file context limit exceeded');
  return text;
}

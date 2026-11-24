import type { BoardFileProblem } from './workspace-board-file-format.js';

export type WorkspaceFileValue<T> = { content: T; hash: string };
export type WorkspaceFileSnapshot<T> = { state: 'ready'; value: WorkspaceFileValue<T> }
  | { state: BoardFileProblem; value?: WorkspaceFileValue<T> };
/** Chosen by server composition, never by a browser-supplied path or table. */
export type WorkspaceFileCodec<T> = {
  name: 'tasks.json' | 'card.json';
  maxBytes: number;
  valid: (value: unknown) => value is T;
  parse: (bytes: Uint8Array) => WorkspaceFileValue<T> | undefined;
  serialize: (content: T) => string;
  context: (paths: string[]) => string;
  /** Persisted outside the Agent-editable file; prevents a bound resource changing type. */
  bindingType?: (content: T) => string;
  bound?: (type: string) => WorkspaceFileCodec<T>;
};

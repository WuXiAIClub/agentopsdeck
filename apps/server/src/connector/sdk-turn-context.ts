import { isAbsolute, resolve, basename, win32 } from 'node:path';
import { lstat } from 'node:fs/promises';
import { canonicalPrivatePath } from './windows-private-worker.js';
import { BOARD_CONTEXT_MAX_CHARS } from './workspace-board-file-format.js';

/** Internal Connector -> owned worker metadata, never parsed from chat text.
 * Explicit file grants do not authorize their parent directories or shell. */
export type SdkTurnContext = string | { text: string; files: string[] };
export function validTurnFiles(files: unknown): files is string[] {
  return Array.isArray(files) && files.length <= 64 && new Set(files).size === files.length
    && files.every(path => typeof path === 'string' && path.length <= 4096 && isAbsolute(path)
      && resolve(path) === path && ['tasks.json', 'card.json'].includes(basename(path)) && !/[\x00-\x1f\x7f]/.test(path));
}
export function workerTurnContext(value?: SdkTurnContext): { context?: string; taskFiles?: string[] } {
  if (value === undefined) return {};
  const text = typeof value === 'string' ? value : value?.text;
  if (typeof text !== 'string' || text.length > BOARD_CONTEXT_MAX_CHARS
    || typeof value !== 'string' && !validTurnFiles(value.files)) throw new Error('Invalid SDK turn context');
  return { context: text, ...(typeof value === 'string' ? {} : { taskFiles: [...value.files] }) };
}
/** Revalidated immediately before permission approval; no links, missing files,
 * directories or traversal aliases. Same-user filesystem races are not a sandbox. */
export const sameTaskFilePath = (a: string, b: string, platform: NodeJS.Platform = process.platform) =>
  platform === 'win32' ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : a === b;
export async function approvedTaskFile(files: readonly string[], path: string): Promise<boolean> {
  if (!files.some(file => sameTaskFilePath(file, path))) return false;
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && (!process.getuid || stat.uid === process.getuid()) && canonicalPrivatePath(path);
  } catch { return false; }
}

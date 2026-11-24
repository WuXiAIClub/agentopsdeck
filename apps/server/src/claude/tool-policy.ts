import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ClaudeConfig } from './config.js';
import { boardToolNames, validBoardToolInput } from '../tools/workspace-board-worker.js';
import { claudeBoardToolName } from './board-tools.js';
import { approvedTaskFile, validTurnFiles } from '../connector/sdk-turn-context.js';

const readTools = ['Read', 'Glob', 'Grep'];
const editTools = [...readTools, 'Edit', 'Write'];
const deny = () => ({ behavior: 'deny' as const, message: 'Connector workspace tool policy denied this request' });
const within = (root: string, path: string) => {
  const left = process.platform === 'win32' ? root.toLowerCase() : root;
  const right = process.platform === 'win32' ? path.toLowerCase() : path;
  const value = relative(left, right);
  return !value || !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};
const protectedSegment = (part: string) => ['.git', '.claude'].includes(part.toLowerCase())
  || process.platform === 'win32' && part.includes('~');

/** Explicit trusted-owner file-tool tier, NOT an OS filesystem sandbox.
 * Mandatory native ask rules route even ordinarily auto-allowed reads through
 * this callback. trusted-exec additionally enables foreground Bash inside an
 * owned worker cgroup; it is host execution, NOT workspace confinement.
 * No native background tasks, hooks, MCP or nested agents.
 * Concurrent filesystem changes and recursive native search are not isolated. */
export function claudeToolPolicy(config: ClaudeConfig, active: () => boolean = () => true, boardEnabled = false, taskFiles: string[] = []) {
  if (!validTurnFiles(taskFiles)) throw new Error('Invalid task file grants');
  const files = [...taskFiles];
  const mode = config.toolPolicy ?? 'none';
  if (!['none', 'workspace-read', 'workspace-edit', 'trusted-exec'].includes(mode)) throw new Error('Invalid Claude tool policy');
  const tools = mode === 'trusted-exec' ? [...editTools, 'Bash'] : mode === 'workspace-edit' ? editTools : mode === 'workspace-read' ? readTools : [];
  return {
    tools: [...tools],
    permissions: { ask: [...tools, ...(boardEnabled ? boardToolNames.map(claudeBoardToolName) : [])], allow: [], defaultMode: 'default',
      disableBypassPermissionsMode: 'disable', blockReadsOutsideWorkingDirectories: true },
    async canUseTool(name: string, input: Record<string, unknown>, invocation?: { signal?: AbortSignal }) {
      try {
        if (boardEnabled && active() && !invocation?.signal?.aborted) {
          const boardName = boardToolNames.find(tool => claudeBoardToolName(tool) === name);
          if (boardName && validBoardToolInput(boardName, input)) return { behavior: 'allow' as const, updatedInput: input };
        }
        if (!active() || invocation?.signal?.aborted || !tools.includes(name) || !input || typeof input !== 'object' || Array.isArray(input)) return deny();
        if (name === 'Bash') {
          if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 100_000 || input.command.includes('\0')
            || input.run_in_background !== undefined && input.run_in_background !== false
            || input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false
            || input.timeout !== undefined && (!Number.isSafeInteger(input.timeout) || Number(input.timeout) < 1 || Number(input.timeout) > 600_000)) return deny();
          // Do not claim shell command regexes can enforce a filesystem scope.
          // Native foreground mode + owned cgroup are required by worker startup.
          return { behavior: 'allow' as const, updatedInput: { ...input, run_in_background: false, dangerouslyDisableSandbox: false } };
        }
        const field = ['Read', 'Write', 'Edit'].includes(name) ? 'file_path' : 'path';
        const value = input[field] ?? (field === 'path' ? config.workspace : undefined);
        if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return deny();
        const root = await realpath(config.workspace), path = resolve(root, value);
        if (field === 'file_path' && await approvedTaskFile(files, path)) {
          if (!active() || invocation?.signal?.aborted) return deny();
          return { behavior: 'allow' as const, updatedInput: { ...input, [field]: path } };
        }
        if (!within(root, path)) return deny();
        // Refuse traversing repository settings/metadata via a direct file tool.
        if (relative(root, path).split(sep).some(protectedSegment)) return deny();
        let canonical: string;
        try {
          const target = await lstat(path);
          if (target.isSymbolicLink() || field === 'file_path' && !target.isFile()) return deny();
          canonical = await realpath(path);
        }
        catch (error) {
          if (name !== 'Write' || (error as NodeJS.ErrnoException).code !== 'ENOENT') return deny();
          canonical = resolve(await realpath(dirname(path)), relative(dirname(path), path));
        }
        if (!within(root, canonical)) return deny();
        if (relative(root, canonical).split(sep).some(protectedSegment)) return deny();
        // Native globs must not turn an in-scope base into an outside search.
        for (const key of name === 'Glob' ? ['pattern'] : name === 'Grep' ? ['glob'] : []) {
          const pattern = input[key];
          if (pattern !== undefined && (typeof pattern !== 'string' || isAbsolute(pattern)
            || pattern.split(/[\\/]/).includes('..') || /[\x00-\x1f\x7f]/.test(pattern))) return deny();
        }
        // Recheck after all filesystem awaits: an already requested stop or
        // disconnected owner must not approve a late permission response.
        if (!active() || invocation?.signal?.aborted) return deny();
        return { behavior: 'allow' as const, updatedInput: { ...input, [field]: canonical } };
      } catch { return deny(); }
    },
  };
}

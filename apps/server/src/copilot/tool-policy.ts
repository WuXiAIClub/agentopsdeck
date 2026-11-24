import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CopilotConfig } from './config.js';
import { boardToolNames, validBoardToolInput } from '../tools/workspace-board-worker.js';
import { approvedTaskFile, sameTaskFilePath, validTurnFiles } from '../connector/sdk-turn-context.js';
import { canonicalPrivatePath } from '../connector/windows-private-worker.js';
import { copilotPatchPaths } from './patch-paths.js';
import { copilotQuestion } from '../commands/native-questions.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const denied = { permissionDecision: 'deny' as const, permissionDecisionReason: 'Connector workspace tool policy denied this request' };
const within = (root: string, path: string) => {
  const left = process.platform === 'win32' ? root.toLowerCase() : root;
  const right = process.platform === 'win32' ? path.toLowerCase() : path;
  const value = relative(left, right);
  return value !== '' && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};
const protectedSegment = (part: string) => ['.git', '.github', '.copilot', '.claude'].includes(part.toLowerCase())
  || process.platform === 'win32' && part.includes('~');

/** Trusted-owner file policy, NOT an OS sandbox. trusted-exec also exposes
 * foreground Bash in a required owned cgroup (host execution, not path isolation).
 * No recursive
 * search, directory listing, external hooks, MCP, plugins or subagents.
 * Both the pre-tool hook and permission callback validate paths. Filesystem
 * TOCTOU remains possible: use a dedicated, trusted workspace. */
export function copilotToolPolicy(config: Pick<CopilotConfig, 'workspace' | 'toolPolicy'>, active: () => boolean = () => true, boardSessionId?: string, taskFiles: string[] = [], questionSessionId?: string) {
  if (!validTurnFiles(taskFiles)) throw new Error('Invalid task file grants');
  const files = [...taskFiles];
  const mode = config.toolPolicy ?? 'none';
  if (!['none', 'workspace-read', 'workspace-edit', 'trusted-exec'].includes(mode)) throw new Error('Invalid Copilot tool policy');
  const edits = ['view', 'edit', 'create', 'apply_patch'];
  const tools = mode === 'trusted-exec' ? [...edits, 'bash'] : mode === 'workspace-edit' ? edits : mode === 'workspace-read' ? ['view'] : [];
  const command = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 100_000 && !value.includes('\0');
  const shell = (args: Record<string, unknown>) => mode === 'trusted-exec' && command(args.command)
    && (args.mode === undefined || args.mode === 'sync') && !args.requestSandboxBypass && !args.dangerouslyDisableSandbox;
  async function file(value: unknown, create: boolean) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)
      || value.split(/[\\/]/).includes('..')) return;
    const root = await realpath(config.workspace), path = resolve(root, value);
    if (await approvedTaskFile(files, path)) return path;
    if (!within(root, path) || relative(root, path).split(sep).some(protectedSegment)) return;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || !canonicalPrivatePath(path)) return;
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT' || !canonicalPrivatePath(dirname(path))) return;
    }
    return path;
  }
  async function patch(value: unknown) {
    const targets = copilotPatchPaths(value);
    if (!targets) return false;
    for (const target of targets) {
      const path = await file(target.path, target.create);
      // A board grant allows content updates, not deletion/movement of its
      // authoritative file (including a move destination overwriting it).
      if (!path || target.destructive && files.some(item => sameTaskFilePath(item, path))) return false;
    }
    return active();
  }
  return {
    availableTools: [...tools, ...(questionSessionId ? ['ask_user'] : []), ...(boardSessionId ? boardToolNames : [])],
    excludedTools: [...(tools.length || questionSessionId ? [] : ['builtin:*']), 'mcp:*', ...(boardSessionId ? [] : ['custom:*'])],
    async onPreToolUse(input: unknown, invocation: { sessionId: string }) {
      try {
        if (questionSessionId && active() && invocation.sessionId === questionSessionId && record(input)
          && input.sessionId === questionSessionId && input.toolName === 'ask_user') {
          copilotQuestion(input.toolArgs); // only bounded native questions, no execution tools
          return { permissionDecision: 'allow' as const };
        }
        if (boardSessionId && active() && invocation.sessionId === boardSessionId && record(input) && input.sessionId === boardSessionId
          && typeof input.toolName === 'string' && validBoardToolInput(input.toolName, input.toolArgs)) return { permissionDecision: 'ask' as const };
        if (!active() || !record(input) || input.sessionId !== invocation.sessionId || typeof input.toolName !== 'string'
          || !tools.includes(input.toolName)) return denied;
        if (input.toolName === 'apply_patch') return await patch(input.toolArgs) ? { permissionDecision: 'ask' as const } : denied;
        if (!record(input.toolArgs)) return denied;
        if (input.toolName === 'bash') return shell(input.toolArgs)
          ? { permissionDecision: 'ask' as const, modifiedArgs: { ...input.toolArgs, mode: 'sync' } } : denied;
        const path = await file(input.toolArgs.path, input.toolName === 'create');
        if (!path || !active()) return denied;
        return { permissionDecision: 'ask' as const, modifiedArgs: { ...input.toolArgs, path } };
      } catch { return denied; }
    },
    async onPermissionRequest(request: unknown, invocation: { managedSettingsEnabled?: boolean; sessionId?: string } = {}) {
      try {
        if (boardSessionId && active() && invocation.sessionId === boardSessionId && !invocation.managedSettingsEnabled && record(request)
          && !request.managedApprovalRequired && !request.requestSandboxBypass && ['hook', 'custom-tool'].includes(String(request.kind))
          && typeof request.toolName === 'string' && validBoardToolInput(request.toolName, request.kind === 'hook' ? request.toolArgs : request.args)) {
          return { kind: 'approve-once' as const };
        }
        if (!active() || !tools.length || !record(request) || request.managedApprovalRequired || request.requestSandboxBypass
          || invocation.managedSettingsEnabled || !['read', 'write', 'hook', ...(mode === 'trusted-exec' ? ['shell'] : [])].includes(String(request.kind))
          || request.kind === 'write' && !['workspace-edit', 'trusted-exec'].includes(mode)) return { kind: 'reject' as const };
        if (request.kind === 'shell') return command(request.fullCommandText) && active()
          ? { kind: 'approve-once' as const } : { kind: 'reject' as const };
        // CLI 1.0.85 routes pre-tool "ask" through a hook confirmation, not a
        // read/write request. Only our advertised file tools may pass; external
        // file hooks and discovered plugins remain disabled in worker options.
        if (request.kind === 'hook') {
          if (request.toolName === 'apply_patch') return tools.includes('apply_patch') && await patch(request.toolArgs)
            ? { kind: 'approve-once' as const } : { kind: 'reject' as const };
          if (request.toolName === 'bash') return record(request.toolArgs) && shell(request.toolArgs) && active()
            ? { kind: 'approve-once' as const } : { kind: 'reject' as const };
          if (typeof request.toolName !== 'string' || !tools.includes(request.toolName) || !record(request.toolArgs)
            || !await file(request.toolArgs.path, request.toolName === 'create') || !active()) return { kind: 'reject' as const };
          return { kind: 'approve-once' as const };
        }
        const path = await file(request.kind === 'read' ? request.path : request.fileName, request.kind === 'write');
        if (!path || !active() || request.resolvedPath !== undefined && (typeof request.resolvedPath !== 'string' || !sameTaskFilePath(request.resolvedPath, path))) return { kind: 'reject' as const };
        return { kind: 'approve-once' as const };
      } catch { return { kind: 'reject' as const }; }
    },
  };
}

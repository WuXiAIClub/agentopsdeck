import { normalizeWorkspaceFileRoot } from './workspace-file-platform.js';
import { homedir } from 'node:os';

export const FILE_BOARD_RUNTIMES = ['codex', 'claude-code', 'ghcp'] as const;
export type FileBoardRuntime = typeof FILE_BOARD_RUNTIMES[number];
export type FileBoardPolicy = { root: string; policies: { owner: string; runtime: FileBoardRuntime }[] };
export const LOCAL_FILE_BOARD_OWNER = 'local:file-boards';
type FileBoardConfig = {
  boardFiles?: FileBoardPolicy;
  claude?: { toolPolicy?: string }; copilot?: { toolPolicy?: string };
};
/** Discovery is scoped to the requesting owner and edit policy, not proof of
 * session readiness, execution authority, or permission to escape a sandbox. */
export function fileBoardRuntimes(owner: string, config: FileBoardConfig): FileBoardRuntime[] {
  return FILE_BOARD_RUNTIMES.filter(runtime => fileBoardWritable(runtime, config)
    && config.boardFiles?.policies.some(policy => policy.owner === owner && policy.runtime === runtime));
}
/** Binding must not silently elevate a read-only SDK runtime. Codex retains
 * its own native sandbox; SDK file writes require an explicit edit tier. */
export function fileBoardWritable(runtime: FileBoardRuntime, config: {
  claude?: { toolPolicy?: string }; copilot?: { toolPolicy?: string };
}): boolean {
  if (runtime === 'codex') return true;
  const policy = (runtime === 'claude-code' ? config.claude : config.copilot)?.toolPolicy;
  return policy === 'workspace-edit' || policy === 'trusted-exec';
}
export function fileBoardRuntime(key: string): FileBoardRuntime | undefined {
  const runtime = key.split(':', 1)[0];
  return runtime === 'codex' || runtime === 'claude-code' || runtime === 'ghcp' ? runtime : undefined;
}
/** Operator configuration only. No inferred owners, wildcard grants or HOME roots. */
export function parseFileBoardPolicy(text: string | undefined, platform: NodeJS.Platform = process.platform, home = homedir()): FileBoardPolicy | undefined {
  if (text === undefined) return;
  try {
    const value = JSON.parse(text);
    if (!value || Object.keys(value).sort().join(',') !== 'policies,root' || typeof value.root !== 'string'
      || !Array.isArray(value.policies) || !value.policies.length || value.policies.length > 64) throw new Error();
    const root = normalizeWorkspaceFileRoot(value.root, platform), homeRoot = normalizeWorkspaceFileRoot(home, platform);
    if (!root || (platform === 'win32' ? root.toLowerCase() === homeRoot?.toLowerCase() : root === homeRoot)) throw new Error();
    const seen = new Set<string>();
    for (const row of value.policies) {
      if (!row || Object.keys(row).sort().join(',') !== 'owner,runtime' || typeof row.owner !== 'string'
        || !/^[A-Za-z0-9:_-]{1,160}$/.test(row.owner) || row.owner.startsWith('actor_')
        || !['codex', 'claude-code', 'ghcp'].includes(row.runtime)
        || row.owner.startsWith('local:') && row.owner !== LOCAL_FILE_BOARD_OWNER) throw new Error();
      const key = JSON.stringify([row.owner, row.runtime]); if (seen.has(key)) throw new Error(); seen.add(key);
    }
    return { ...value, root };
  } catch { throw new Error('Invalid AOD_BOARD_FILES_JSON: expected dedicated root and explicit owner/runtime policies'); }
}

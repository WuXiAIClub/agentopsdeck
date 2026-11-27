import path from 'node:path';
import { normalizeSourceFiles, type SourceFileChange } from '@agentopsdeck/shared';
import type { AntigravityProjectedToolDiff, AntigravityProjectedUpdate } from './message-projection.js';

export type AntigravityToolUpdate = Extract<AntigravityProjectedUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;

export type AntigravityToolMeta = {
  /** Stored on ChatMessage.toolName (must match /^[A-Za-z0-9_.:/-]{1,512}$/). */
  toolName: string;
  /** Canonical Codex-aligned tool name without target suffix (e.g. read_file, edit_file). */
  canonicalName: string;
  /** File operation kind if this tool modifies files. */
  fileOperation?: 'read' | 'edit' | 'write' | 'delete' | 'move';
  /** Human-readable short target hint (basename, command snippet, or query). */
  targetHint?: string;
};

const SAFE_HINT_RE = /^[A-Za-z0-9_.-]+$/;
const SAFE_TOOL_NAME_RE = /[^A-Za-z0-9_.:/-]/g;

function sanitizeToolNameSegment(value: string, maxLen = 48): string {
  return value.replace(SAFE_TOOL_NAME_RE, '_').replace(/^_+|_+$/g, '').slice(0, maxLen);
}

function extractBasename(pathValue: string): string {
  const cleaned = pathValue.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = cleaned.lastIndexOf('/');
  return lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
}

function firstPathFromUpdate(update: AntigravityToolUpdate, title?: string): string | undefined {
  const fromLoc = update.locations?.[0]?.path;
  if (fromLoc) return fromLoc;
  const fromDiff = update.diffs?.[0]?.path;
  if (fromDiff) return fromDiff;
  const params = update.inputParams;
  if (params) {
    for (const key of ['path', 'Path', 'filePath', 'file_path', 'targetPath', 'file', 'target']) {
      const candidate = params[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  if (title) {
    const match = title.match(/(?:^|\s)((?:\/|\.\.?\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+\.[A-Za-z0-9]+|(?:[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|py|go|rs|java|kt|swift|yml|yaml|toml|sh|html|sql|txt)))(?::\d+)?(?:\s|$)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function firstCommandFromUpdate(update: AntigravityToolUpdate, title?: string): string | undefined {
  const params = update.inputParams;
  if (params) {
    for (const key of ['command', 'CommandLine', 'cmd']) {
      const candidate = params[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  if (title && /^(?:run|exec|bash|shell)\s+/i.test(title)) {
    const rest = title.replace(/^(?:run|exec|bash|shell)\s+/i, '').trim();
    if (rest && !/^(?:command|read_file|edit_file|write_file|invoke_subagent|define_subagent|send_message|manage_subagents)$/i.test(rest)) {
      return rest;
    }
  }
  return undefined;
}

export function classifyAntigravityTool(
  update: AntigravityToolUpdate,
  rememberedTitle?: string,
): AntigravityToolMeta {
  const title = (update.title ?? rememberedTitle ?? '').trim();
  const lowerTitle = title.toLowerCase();
  const kind = update.kind;
  const path = firstPathFromUpdate(update, title);
  const command = firstCommandFromUpdate(update, title);

  let canonicalName = 'antigravity_tool';
  let fileOperation: AntigravityToolMeta['fileOperation'];

  // 1. Subagent & multi-agent orchestration tools
  if (/\b(?:invoke_subagent|define_subagent|spawn_agent)\b/.test(lowerTitle)) {
    canonicalName = 'spawn_agent';
  } else if (/\bsend_message\b/.test(lowerTitle)) {
    canonicalName = 'send_message';
  } else if (/\bmanage_subagents\b/.test(lowerTitle)) {
    canonicalName = 'manage_subagents';
  } else if (/\bsearch_web\b|\bweb_search\b/.test(lowerTitle)) {
    canonicalName = 'web_search';
  } else if (kind === 'fetch' || /\b(?:web_fetch|fetch_url|read_url|http)\b/.test(lowerTitle)) {
    canonicalName = 'web_fetch';
  } else if (kind === 'delete' || /\b(?:delete_file|remove_file|rm_file)\b/.test(lowerTitle)) {
    canonicalName = 'delete_file';
    fileOperation = 'delete';
  } else if (kind === 'move' || /\b(?:move_file|rename_file)\b/.test(lowerTitle)) {
    canonicalName = 'move_file';
    fileOperation = 'move';
  } else if (
    kind === 'edit'
    || Boolean(update.diffs?.length)
    || /\b(?:edit_file|write_file|replace_file|multi_replace|apply_patch|patch_file)\b/.test(lowerTitle)
    || /^(?:edit|write|create|update|modify|patch)\b/.test(lowerTitle)
  ) {
    const isCreate = /\b(?:write_file|create_file|create\s+)\b/.test(lowerTitle)
      || Boolean(update.diffs?.length && update.diffs.every(d => !d.oldText));
    canonicalName = isCreate ? 'write_file' : 'edit_file';
    fileOperation = isCreate ? 'write' : 'edit';
  } else if (
    kind === 'read'
    || /\b(?:read_file|view_file|view_file_outline|view_code_item|cat_file|list_dir|list_files)\b/.test(lowerTitle)
    || /^(?:read|view|inspect|open|list)\b/.test(lowerTitle)
  ) {
    canonicalName = 'read_file';
    fileOperation = 'read';
  } else if (
    kind === 'search'
    || /\b(?:grep|grep_search|find_by_name|glob|ripgrep|search_files|find_files)\b/.test(lowerTitle)
    || /^(?:search|find|grep)\b/.test(lowerTitle)
  ) {
    canonicalName = 'search_files';
  } else if (kind === 'execute' || /\b(?:run_command|exec_command|command|terminal|shell|bash)\b/.test(lowerTitle)) {
    if ((command && /^\s*git\b/i.test(command)) || /^git\b/i.test(lowerTitle)) {
      canonicalName = 'git';
    } else {
      canonicalName = 'commandExecution';
    }
  } else if (kind === 'think') {
    canonicalName = 'think';
  } else if (kind === 'switch_mode') {
    canonicalName = 'switch_mode';
  } else if (kind && kind !== 'other') {
    canonicalName = sanitizeToolNameSegment(kind) || 'antigravity_tool';
  } else if (title) {
    const cleaned = title.replace(/^Run\s+/i, '').trim().split(/\s+/)[0] ?? '';
    canonicalName = sanitizeToolNameSegment(cleaned) || 'antigravity_tool';
  }

  let targetHint: string | undefined;
  if (path) {
    targetHint = extractBasename(path);
  } else if (command) {
    const firstToken = command.split(/\s+/).slice(0, 2).join('_');
    targetHint = firstToken;
  } else if (update.inputParams?.query || update.inputParams?.Query || update.inputParams?.pattern) {
    targetHint = String(update.inputParams.query ?? update.inputParams.Query ?? update.inputParams.pattern);
  }

  let toolName = canonicalName;
  if (targetHint && ['read_file', 'edit_file', 'write_file', 'delete_file', 'move_file'].includes(canonicalName)) {
    const safeBasename = sanitizeToolNameSegment(targetHint, 42);
    if (safeBasename && SAFE_HINT_RE.test(safeBasename)) {
      toolName = `${canonicalName}:${safeBasename}`;
    }
  }

  return {
    toolName: toolName.slice(0, 512),
    canonicalName,
    ...(fileOperation ? { fileOperation } : {}),
    ...(targetHint ? { targetHint } : {}),
  };
}

function buildCompactDiffText(diffs: readonly AntigravityProjectedToolDiff[]): string {
  const blocks: string[] = [];
  for (const diff of diffs) {
    const lines: string[] = [`--- ${diff.path}`, `+++ ${diff.path}`];
    if (diff.oldText) {
      for (const line of diff.oldText.split('\n').slice(0, 40)) {
        lines.push(`- ${line}`);
      }
    }
    if (diff.newText) {
      for (const line of diff.newText.split('\n').slice(0, 40)) {
        lines.push(`+ ${line}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

export function formatAntigravityToolCallDetail(
  meta: AntigravityToolMeta,
  update: AntigravityToolUpdate,
  rememberedTitle?: string,
): { text: string; truncated: boolean } | undefined {
  const title = (update.title ?? rememberedTitle ?? '').trim();
  const payload: Record<string, unknown> = {};

  if (update.inputParams) {
    for (const [key, val] of Object.entries(update.inputParams)) {
      if (val !== undefined && val !== '') payload[key] = val;
    }
  }

  if (update.locations?.length) {
    const primary = update.locations[0]!;
    if (!payload.path && !payload.Path && !payload.filePath && !payload.file_path) {
      payload.path = primary.path;
    }
    if (primary.line !== undefined && payload.line === undefined && payload.StartLine === undefined) {
      payload.line = primary.line;
    }
    if (update.locations.length > 1) {
      payload.files = update.locations.map(loc => loc.line !== undefined ? `${loc.path}:${loc.line}` : loc.path);
    }
  }

  if (meta.canonicalName === 'commandExecution' || meta.canonicalName === 'git') {
    const cmd = firstCommandFromUpdate(update, title);
    if (cmd && !payload.command && !payload.cmd) {
      payload.command = cmd;
    }
  }

  if (title && !Object.keys(payload).length) {
    payload.summary = title;
  } else if (title && title.toLowerCase() !== meta.canonicalName.toLowerCase() && !payload.summary) {
    payload.action = title;
  }

  if (!Object.keys(payload).length) return undefined;

  const json = JSON.stringify(payload, null, 2);
  const text = `[tool ${meta.canonicalName}]\nTool input:\n\`\`\`json\n${json}\n\`\`\``;
  return { text: text.slice(0, 32_000), truncated: text.length > 32_000 };
}

export function formatAntigravityToolResultDetail(
  meta: AntigravityToolMeta,
  update: AntigravityToolUpdate,
): { text: string; truncated: boolean } | undefined {
  const status = update.status === 'failed' ? 'failed' : 'completed';

  if (meta.fileOperation && meta.fileOperation !== 'read') {
    const changedPaths = new Set<string>();
    for (const diff of update.diffs ?? []) changedPaths.add(diff.path);
    for (const loc of update.locations ?? []) changedPaths.add(loc.path);
    const paramPath = firstPathFromUpdate(update);
    if (paramPath) changedPaths.add(paramPath);

    if (changedPaths.size > 0 && !update.outputText && !update.diffs?.length) {
      const changeKind = meta.fileOperation === 'write' ? 'add'
        : meta.fileOperation === 'delete' ? 'delete'
          : 'update';
      const envelope = {
        status,
        changes: [...changedPaths].map(path => ({ path, kind: changeKind })),
      };
      return {
        text: `[tool ${meta.canonicalName}]\nstatus: ${status}\noutput:\n${JSON.stringify(envelope, null, 2)}`,
        truncated: false,
      };
    }

    if (update.diffs?.length) {
      const diffText = buildCompactDiffText(update.diffs);
      const combined = update.outputText ? `${diffText}\n\n${update.outputText}` : diffText;
      const body = `[tool ${meta.canonicalName}]\nstatus: ${status}\noutput:\n${combined}`;
      return { text: body.slice(0, 64_000), truncated: Boolean(update.outputTruncated) || body.length > 64_000 };
    }
  }

  if (meta.canonicalName === 'commandExecution' || meta.canonicalName === 'git') {
    const output = update.outputText ?? '';
    if (update.exitCode !== undefined || output) {
      const envelope = {
        status,
        ...(update.exitCode !== undefined ? { exitCode: update.exitCode } : {}),
        output,
      };
      const body = `[tool ${meta.canonicalName}]\nstatus: ${status}\noutput:\n${JSON.stringify(envelope, null, 2)}`;
      return { text: body.slice(0, 64_000), truncated: Boolean(update.outputTruncated) || body.length > 64_000 };
    }
  }

  if (update.outputText !== undefined) {
    const body = `[tool ${meta.canonicalName}]\nstatus: ${status}\noutput:\n${update.outputText}`;
    return { text: body.slice(0, 64_000), truncated: Boolean(update.outputTruncated) || body.length > 64_000 };
  }

  if (update.status === 'failed') {
    return { text: `[tool ${meta.canonicalName}]\nstatus: failed`, truncated: false };
  }

  return undefined;
}

function resolveCandidatePath(candidate: string, cwd?: string): string {
  const trimmed = candidate.trim();
  if (/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(trimmed)) return trimmed;
  if (cwd && /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(cwd)) {
    return path.resolve(cwd, trimmed);
  }
  return trimmed;
}

export function extractAntigravitySourceFiles(
  meta: AntigravityToolMeta,
  update: AntigravityToolUpdate,
  cwd?: string,
): SourceFileChange[] {
  if (!meta.fileOperation || meta.fileOperation === 'read' || update.status === 'failed') return [];
  const kind: SourceFileChange['kind'] = meta.fileOperation === 'write' ? 'added'
    : meta.fileOperation === 'delete' ? 'deleted'
      : 'modified';
  const raw: Array<{ path: string; kind: SourceFileChange['kind'] }> = [];
  for (const diff of update.diffs ?? []) {
    raw.push({ path: resolveCandidatePath(diff.path, cwd), kind: !diff.oldText && diff.newText ? 'added' : kind });
  }
  if (raw.length === 0) {
    for (const loc of update.locations ?? []) {
      raw.push({ path: resolveCandidatePath(loc.path, cwd), kind });
    }
  }
  if (raw.length === 0) {
    const filePath = firstPathFromUpdate(update);
    if (filePath) raw.push({ path: resolveCandidatePath(filePath, cwd), kind });
  }
  return normalizeSourceFiles(raw);
}

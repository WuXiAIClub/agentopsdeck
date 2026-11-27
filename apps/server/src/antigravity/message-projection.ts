export const ANTIGRAVITY_TOOL_OUTPUT_LIMIT = 64_000;
const ANTIGRAVITY_DIFF_FIELD_LIMIT = 8_000;

export type AntigravityProjectedToolLocation = {
  path: string;
  line?: number;
};

export type AntigravityProjectedToolDiff = {
  path: string;
  oldText?: string;
  newText?: string;
};

export type AntigravityProjectedUpdate = {
  sessionUpdate: 'agent_message_chunk';
  content: { type: 'text'; text: string };
} | {
  sessionUpdate: 'usage_update';
  used: number;
  size: number;
} | {
  sessionUpdate: 'tool_call' | 'tool_call_update';
  toolCallId: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  locations?: AntigravityProjectedToolLocation[];
  inputParams?: Record<string, string | number | boolean>;
  diffs?: AntigravityProjectedToolDiff[];
  exitCode?: number;
  outputText?: string;
  outputTruncated?: boolean;
};

const SAFE_INPUT_KEYS = new Set([
  'path', 'Path', 'filePath', 'file_path', 'targetPath', 'file', 'target',
  'command', 'CommandLine', 'cmd', 'cwd', 'workingDirectory',
  'query', 'Query', 'pattern', 'regex', 'glob',
  'StartLine', 'EndLine', 'start_line', 'end_line', 'line', 'offset', 'limit',
  'url', 'Url', 'domain', 'Role', 'TypeName', 'description',
]);

const failure = () => Error('Antigravity message update could not be verified');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const metadataText = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && Buffer.byteLength(value) <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const normalizeToolTitle = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!collapsed) return undefined;
  if (Buffer.byteLength(collapsed) <= 512) return collapsed;
  let out = '';
  for (const ch of collapsed) {
    if (Buffer.byteLength(out + ch) > 512) break;
    out += ch;
  }
  return out || undefined;
};
const statuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
const kinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const nonNegativeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function extractLocations(value: Record<string, unknown>): AntigravityProjectedToolLocation[] | undefined {
  if (!Array.isArray(value.locations)) return undefined;
  const out: AntigravityProjectedToolLocation[] = [];
  for (const item of value.locations.slice(0, 16)) {
    if (!record(item)) continue;
    const path = normalizeToolTitle(item.path);
    if (!path) continue;
    const line = typeof item.line === 'number' && Number.isSafeInteger(item.line) && item.line >= 0
      ? item.line
      : undefined;
    out.push(line !== undefined ? { path, line } : { path });
  }
  return out.length ? out : undefined;
}

function extractSafeInputParams(value: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  if (!record(value.rawInput)) return undefined;
  const params: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value.rawInput)) {
    if (!SAFE_INPUT_KEYS.has(key)) continue;
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
      if (cleaned) params[key] = cleaned.slice(0, 1024);
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      params[key] = raw;
    } else if (typeof raw === 'boolean') {
      params[key] = raw;
    }
  }
  return Object.keys(params).length ? params : undefined;
}

function extractDiffs(value: Record<string, unknown>): AntigravityProjectedToolDiff[] | undefined {
  if (!Array.isArray(value.content)) return undefined;
  const diffs: AntigravityProjectedToolDiff[] = [];
  for (const item of value.content.slice(0, 12)) {
    if (!record(item) || item.type !== 'diff') continue;
    const path = normalizeToolTitle(item.path);
    if (!path) continue;
    const oldText = typeof item.oldText === 'string' && item.oldText.length > 0
      ? item.oldText.slice(0, ANTIGRAVITY_DIFF_FIELD_LIMIT)
      : undefined;
    const newText = typeof item.newText === 'string' && item.newText.length > 0
      ? item.newText.slice(0, ANTIGRAVITY_DIFF_FIELD_LIMIT)
      : undefined;
    diffs.push({
      path,
      ...(oldText !== undefined ? { oldText } : {}),
      ...(newText !== undefined ? { newText } : {}),
    });
  }
  return diffs.length ? diffs : undefined;
}

function extractExitCode(value: Record<string, unknown>): number | undefined {
  if (!record(value.rawOutput)) return undefined;
  const candidate = value.rawOutput.exitCode ?? value.rawOutput.exit_code;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : undefined;
}

function extractToolOutput(value: Record<string, unknown>): { text: string; truncated: boolean } | undefined {
  const parts: string[] = [];
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!record(item)) continue;
      if (item.type === 'content' && record(item.content) && item.content.type === 'text' && typeof item.content.text === 'string') {
        parts.push(item.content.text);
      } else if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      }
    }
  }
  if (parts.length === 0 && record(value.rawOutput)) {
    if (typeof value.rawOutput.output === 'string' && value.rawOutput.output) {
      parts.push(value.rawOutput.output);
    } else {
      if (typeof value.rawOutput.stdout === 'string' && value.rawOutput.stdout) parts.push(value.rawOutput.stdout);
      if (typeof value.rawOutput.stderr === 'string' && value.rawOutput.stderr) parts.push(value.rawOutput.stderr);
    }
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join('\n');
  if (!joined) return undefined;
  const truncated = joined.length > ANTIGRAVITY_TOOL_OUTPUT_LIMIT;
  return { text: truncated ? joined.slice(0, ANTIGRAVITY_TOOL_OUTPUT_LIMIT) : joined, truncated };
}

export function projectAntigravityUpdate(value: unknown): AntigravityProjectedUpdate | undefined {
  if (!record(value) || typeof value.sessionUpdate !== 'string') throw failure();
  if (value.sessionUpdate === 'agent_message_chunk') {
    if (!record(value.content) || typeof value.content.type !== 'string') throw failure();
    if (value.content.type !== 'text') return;
    if (typeof value.content.text !== 'string' || Buffer.byteLength(value.content.text) > 524_288) throw failure();
    return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.content.text } };
  }
  if (value.sessionUpdate === 'usage_update') {
    if (!nonNegativeInt(value.used) || !nonNegativeInt(value.size) || value.size <= 0) return;
    return { sessionUpdate: 'usage_update', used: value.used, size: value.size };
  }
  if (value.sessionUpdate !== 'tool_call' && value.sessionUpdate !== 'tool_call_update') return;
  const rawTitle = value.title === null ? undefined : value.title;
  const rawStatus = value.status === null ? undefined : value.status;
  const rawKind = value.kind === null ? undefined : value.kind;
  if (!metadataText(value.toolCallId)
    || rawTitle !== undefined && typeof rawTitle !== 'string'
    || rawStatus !== undefined && (typeof rawStatus !== 'string' || !statuses.has(rawStatus))
    || rawKind !== undefined && (typeof rawKind !== 'string' || !kinds.has(rawKind))) throw failure();
  const title = rawTitle !== undefined ? normalizeToolTitle(rawTitle) : undefined;
  const locations = extractLocations(value);
  const inputParams = extractSafeInputParams(value);
  const isTerminal = rawStatus === 'completed' || rawStatus === 'failed';
  const diffs = isTerminal ? extractDiffs(value) : undefined;
  const exitCode = isTerminal ? extractExitCode(value) : undefined;
  const output = isTerminal ? extractToolOutput(value) : undefined;
  return {
    sessionUpdate: value.sessionUpdate, toolCallId: value.toolCallId,
    ...(title !== undefined ? { title } : {}),
    ...(rawStatus !== undefined ? { status: rawStatus as 'pending' | 'in_progress' | 'completed' | 'failed' } : {}),
    ...(rawKind !== undefined ? { kind: rawKind as 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other' } : {}),
    ...(locations ? { locations } : {}),
    ...(inputParams ? { inputParams } : {}),
    ...(diffs ? { diffs } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(output ? { outputText: output.text, outputTruncated: output.truncated } : {}),
  };
}

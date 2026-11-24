export type ToolStatusTone = 'success' | 'running' | 'error' | 'warning' | 'neutral';

export type ToolParamItem = {
  key: string;
  value: string;
  mono?: boolean | undefined;
};

export type ToolInputBlock =
  | {
      kind: 'command';
      command: string;
      meta: ToolParamItem[];
    }
  | {
      kind: 'params';
      items: ToolParamItem[];
    }
  | {
      kind: 'json';
      code: string;
    }
  | {
      kind: 'text';
      text: string;
    };

export type ToolAgentStatusEntry = {
  agentId: string;
  state: string;
  tone: ToolStatusTone;
  summary?: string | undefined;
};

export type ToolFileChangeItem = {
  path: string;
  kind: 'add' | 'update' | 'delete' | 'other';
  rawKind?: string | undefined;
};

export type ToolOutputBlock =
  | {
      kind: 'terminal';
      output: string;
      chunkId?: string | undefined;
    }
  | {
      kind: 'agentStatus';
      agents: ToolAgentStatusEntry[];
      timedOut?: boolean | undefined;
      extra?: ToolParamItem[] | undefined;
    }
  | {
      kind: 'fileChanges';
      changes: ToolFileChangeItem[];
    }
  | {
      kind: 'params';
      items: ToolParamItem[];
    }
  | {
      kind: 'json';
      code: string;
    }
  | {
      kind: 'text';
      text: string;
    };

export type StructuredToolDetail = {
  kind: 'structured';
  rawText: string;
  toolName?: string | undefined;
  status?: undefined | {
    raw: string;
    label: string;
    tone: ToolStatusTone;
  };
  exitCode?: number | undefined;
  durationLabel?: string | undefined;
  input?: ToolInputBlock | undefined;
  output?: ToolOutputBlock | undefined;
  error?: string | undefined;
};

export type ParsedToolDetail =
  | {
      kind: 'plain';
      text: string;
    }
  | StructuredToolDetail;

const STRUCTURED_TOOL_RE = /(?:^|\n)\s*\[tool\s+[^\]\n]+\]|(?:^|\n)\s*tool input:\s*(?:\n|$)|(?:^|\n)\s*status:\s*\S+(?:\n|$)|(?:^|\n)\s*output:\s*(?:\n|$)/i;

export function parseToolDetail(rawText: string): ParsedToolDetail {
  if (!rawText || !STRUCTURED_TOOL_RE.test(rawText)) {
    return { kind: 'plain', text: rawText };
  }

  let toolName: string | undefined;
  let statusRaw: string | undefined;
  const inputChunks: string[] = [];
  const outputChunks: string[] = [];
  const errorChunks: string[] = [];

  const sections = splitToolSections(rawText);
  for (const section of sections) {
    let body = section.trim();
    const headerMatch = body.match(/^\[tool\s+([^\]\n]+)\]\s*(?:\n|$)/i);
    if (headerMatch) {
      if (!toolName && headerMatch[1]) toolName = headerMatch[1].trim();
      body = body.slice(headerMatch[0].length).trim();
    }
    if (!body) continue;
    parseSectionBody(body, inputChunks, outputChunks, errorChunks, (foundStatus) => {
      statusRaw = foundStatus;
    });
  }

  let exitCode: number | undefined;
  let durationLabel: string | undefined;

  const mergedInputRaw = inputChunks.join('\n\n').trim();
  const input = mergedInputRaw ? parseInputBlock(mergedInputRaw) : undefined;

  let mergedError = errorChunks.join('\n\n').trim() || undefined;
  const mergedOutputRaw = outputChunks.join('\n\n').trim();
  let output: ToolOutputBlock | undefined;

  if (mergedOutputRaw && !isPlaceholderToken(mergedOutputRaw)) {
    const parsedOutput = parseOutputBlock(mergedOutputRaw);
    output = parsedOutput.block;
    if (parsedOutput.exitCode !== undefined) exitCode = parsedOutput.exitCode;
    if (parsedOutput.durationLabel) durationLabel = parsedOutput.durationLabel;
    if (parsedOutput.statusOverride && !statusRaw) statusRaw = parsedOutput.statusOverride;
    if (parsedOutput.errorOverride && !mergedError) mergedError = parsedOutput.errorOverride;
  }

  if (!toolName && !statusRaw && !input && !output && !mergedError) {
    return { kind: 'plain', text: rawText };
  }

  const status = normalizeStatus(statusRaw, exitCode, mergedError);

  return {
    kind: 'structured',
    rawText,
    toolName,
    status,
    exitCode,
    durationLabel,
    input,
    output,
    error: mergedError,
  };
}

function splitToolSections(text: string): string[] {
  const indices: number[] = [];
  const regex = /(?:^|\n)(?=\[tool\s+[^\]\n]+\])/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const start = match[0].startsWith('\n') ? match.index + 1 : match.index;
    indices.push(start);
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }
  if (indices.length === 0) return [text];
  const parts: string[] = [];
  if (indices[0]! > 0) {
    const leading = text.slice(0, indices[0]).trim();
    if (leading) parts.push(leading);
  }
  for (let idx = 0; idx < indices.length; idx += 1) {
    const start = indices[idx]!;
    const end = idx + 1 < indices.length ? indices[idx + 1]! : text.length;
    const slice = text.slice(start, end).trim();
    if (slice) parts.push(slice);
  }
  return parts;
}

function parseSectionBody(
  body: string,
  inputChunks: string[],
  outputChunks: string[],
  errorChunks: string[],
  onStatus: (status: string) => void,
) {
  let rest = body;

  const fencedInputRe = /(?:^|\n)tool input:\s*\n```(?:json|[a-z0-9_-]+)?\s*\n([\s\S]*?)\n```(?:\s*(?:\n|$))?/i;
  const fencedMatch = rest.match(fencedInputRe);
  if (fencedMatch) {
    if (fencedMatch[1]?.trim()) inputChunks.push(fencedMatch[1].trim());
    rest = (rest.slice(0, fencedMatch.index) + '\n' + rest.slice((fencedMatch.index ?? 0) + fencedMatch[0].length)).trim();
  } else {
    const plainInputRe = /(?:^|\n)tool input:\s*\n([\s\S]*?)(?=\n(?:status:|error:|output:|\[\s*tool[_\s-]*output\s*\])|$)/i;
    const plainMatch = rest.match(plainInputRe);
    if (plainMatch) {
      if (plainMatch[1]?.trim()) inputChunks.push(stripOuterCodeFence(plainMatch[1].trim()));
      rest = (rest.slice(0, plainMatch.index) + '\n' + rest.slice((plainMatch.index ?? 0) + plainMatch[0].length)).trim();
    }
  }

  rest = rest.replace(/^\s*\[\s*tool[_\s-]*output\s*\]\s*$/gim, '').trim();
  if (!rest) return;

  const statusRe = /(?:^|\n)status:\s*([^\n]+)/i;
  const statusMatch = rest.match(statusRe);
  if (statusMatch?.[1]) {
    onStatus(statusMatch[1].trim());
    rest = (rest.slice(0, statusMatch.index) + '\n' + rest.slice((statusMatch.index ?? 0) + statusMatch[0].length)).trim();
  }

  const outputMarkerRe = /(?:^|\n)output:\s*(?:\n|$)/i;
  const outputMatch = rest.match(outputMarkerRe);
  let beforeOutput = rest;
  if (outputMatch && outputMatch.index !== undefined) {
    beforeOutput = rest.slice(0, outputMatch.index).trim();
    const outContent = rest.slice(outputMatch.index + outputMatch[0].length).trim();
    if (outContent && !isPlaceholderToken(outContent)) {
      outputChunks.push(stripOuterCodeFence(outContent));
    }
  }

  const errorMarkerRe = /(?:^|\n)error:\s*([\s\S]*)$/i;
  const errorMatch = beforeOutput.match(errorMarkerRe);
  if (errorMatch && errorMatch.index !== undefined) {
    const leading = beforeOutput.slice(0, errorMatch.index).trim();
    const errText = errorMatch[1]?.trim();
    if (errText) errorChunks.push(errText);
    if (leading && !isPlaceholderToken(leading)) outputChunks.push(leading);
  } else if (beforeOutput && !isPlaceholderToken(beforeOutput)) {
    outputChunks.push(beforeOutput);
  }
}

function isPlaceholderToken(value: string) {
  return /^\[\s*tool[_\s-]*output\s*\]$/i.test(value.trim());
}

function stripOuterCodeFence(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:[a-z0-9_-]+)?\s*\n([\s\S]*?)\n```$/i);
  return match ? (match[1] ?? '').trim() : trimmed;
}

export function unwrapJsonPayload(raw: string): { parsed: boolean; value: unknown } {
  const cleaned = stripOuterCodeFence(raw);
  if (!cleaned) return { parsed: false, value: raw };
  try {
    const first = JSON.parse(cleaned);
    return { parsed: true, value: deepUnwrapJsonStrings(first, 0) };
  } catch {
    return { parsed: false, value: cleaned };
  }
}

function deepUnwrapJsonStrings(value: unknown, depth: number): unknown {
  if (depth > 4) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
      || (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    ) {
      try {
        const inner = JSON.parse(trimmed);
        if (inner !== value) return deepUnwrapJsonStrings(inner, depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepUnwrapJsonStrings(item, depth + 1));
  }
  if (isPlainRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = deepUnwrapJsonStrings(v, depth + 1);
    }
    return next;
  }
  return value;
}

function parseInputBlock(raw: string): ToolInputBlock {
  const { parsed, value } = unwrapJsonPayload(raw);
  if (!parsed) {
    return { kind: 'text', text: stripOuterCodeFence(raw) };
  }

  if (typeof value === 'string') {
    return { kind: 'text', text: value };
  }

  if (isPlainRecord(value)) {
    const unwrappedRecord = unwrapSingleArgumentsEnvelope(value);
    const entries = Object.entries(unwrappedRecord).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return { kind: 'params', items: [] };
    }

    const cmdKey = ['cmd', 'command'].find((key) => typeof unwrappedRecord[key] === 'string' && String(unwrappedRecord[key]).trim().length > 0);
    if (cmdKey) {
      const command = String(unwrappedRecord[cmdKey]);
      const meta: ToolParamItem[] = [];
      for (const [key, itemVal] of entries) {
        if (key === cmdKey || itemVal === undefined || itemVal === null || itemVal === '') continue;
        meta.push({ key, value: formatParamValue(key, itemVal), mono: isMonoParam(key, itemVal) });
      }
      return { kind: 'command', command, meta };
    }

    if (canRenderAsParamTable(unwrappedRecord)) {
      const items = entries.map(([key, itemVal]) => ({
        key,
        value: formatParamValue(key, itemVal),
        mono: isMonoParam(key, itemVal),
      }));
      return { kind: 'params', items };
    }

    return { kind: 'json', code: JSON.stringify(unwrappedRecord, null, 2) };
  }

  return { kind: 'json', code: JSON.stringify(value, null, 2) };
}

function unwrapSingleArgumentsEnvelope(record: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(record);
  if (keys.length === 1 && (keys[0] === 'arguments' || keys[0] === 'args' || keys[0] === 'input') && isPlainRecord(record[keys[0]!])) {
    return record[keys[0]!] as Record<string, unknown>;
  }
  return record;
}

function canRenderAsParamTable(record: Record<string, unknown>): boolean {
  const entries = Object.entries(record).filter(([, v]) => v !== undefined);
  if (entries.length === 0 || entries.length > 8) return false;
  return entries.every(([, val]) => {
    if (val === null || typeof val === 'boolean' || typeof val === 'number') return true;
    if (typeof val === 'string') return val.length <= 280 && !val.includes('\n\n');
    if (Array.isArray(val)) {
      return val.length <= 6 && val.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
    }
    return false;
  });
}

function formatParamValue(key: string, value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if ((key === 'timeout_ms' || key === 'yield_time_ms' || key === 'durationMs') && value >= 1_000) {
      return `${formatDurationMs(value)} (${value} ms)`;
    }
    return String(value);
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((item) => String(item)).join(', ');
  }
  return JSON.stringify(value);
}

function isMonoParam(key: string, value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'boolean' || Array.isArray(value)) return true;
  if (typeof value === 'string') {
    return /(?:id|path|dir|cwd|url|file|target|model|cmd|command|key|token|branch|ref|sha)/i.test(key)
      || value.startsWith('/')
      || /^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(value);
  }
  return false;
}

function parseOutputBlock(raw: string): {
  block?: ToolOutputBlock | undefined;
  exitCode?: number | undefined;
  durationLabel?: string | undefined;
  statusOverride?: string | undefined;
  errorOverride?: string | undefined;
} {
  const shellParsed = tryParseCodexShellTranscript(raw);
  if (shellParsed) {
    return {
      block: {
        kind: 'terminal',
        output: shellParsed.output,
        chunkId: shellParsed.chunkId,
      },
      exitCode: shellParsed.exitCode,
      durationLabel: shellParsed.wallTime,
    };
  }

  const { parsed, value } = unwrapJsonPayload(raw);
  if (!parsed) {
    return { block: { kind: 'text', text: raw } };
  }

  if (typeof value === 'string') {
    const innerShell = tryParseCodexShellTranscript(value);
    if (innerShell) {
      return {
        block: {
          kind: 'terminal',
          output: innerShell.output,
          chunkId: innerShell.chunkId,
        },
        exitCode: innerShell.exitCode,
        durationLabel: innerShell.wallTime,
      };
    }
    return { block: { kind: 'text', text: value } };
  }

  if (isPlainRecord(value)) {
    // 1. Subagent wait_agent / status map: { status: { "<agentId>": { completed: "..." } | "running" }, timed_out?: boolean }
    if (isPlainRecord(value.status) && Object.keys(value.status).length > 0 && isSubagentStatusMap(value.status)) {
      const agents: ToolAgentStatusEntry[] = [];
      for (const [agentId, stateVal] of Object.entries(value.status)) {
        agents.push(parseAgentStatusEntry(agentId, stateVal));
      }
      const timedOut = typeof value.timed_out === 'boolean' ? value.timed_out : undefined;
      return {
        block: {
          kind: 'agentStatus',
          agents,
          timedOut,
        },
        statusOverride: timedOut ? 'timed_out' : undefined,
      };
    }

    // 2. spawn_agent / close_agent / resume_agent response
    if (typeof value.agent_id === 'string' && Object.keys(value).length <= 4) {
      const items: ToolParamItem[] = Object.entries(value)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => ({
          key: k,
          value: typeof v === 'object' ? JSON.stringify(v) : String(v),
          mono: k === 'agent_id' || typeof v !== 'string',
        }));
      return { block: { kind: 'params', items } };
    }

    // 3. commandExecution envelope: { status, exitCode, durationMs, output }
    if ('exitCode' in value || ('output' in value && typeof value.output === 'string' && Object.keys(value).every((k) => ['status', 'exitCode', 'durationMs', 'output', 'error'].includes(k)))) {
      const exitCode = typeof value.exitCode === 'number' ? value.exitCode : undefined;
      const durationLabel = typeof value.durationMs === 'number' ? formatDurationMs(value.durationMs) : undefined;
      const statusOverride = typeof value.status === 'string' ? value.status : undefined;
      const errorOverride = typeof value.error === 'string' && value.error.trim() ? value.error.trim() : undefined;
      const outStr = typeof value.output === 'string' ? value.output : '';
      return {
        block: outStr || exitCode !== undefined ? { kind: 'terminal', output: outStr } : undefined,
        exitCode,
        durationLabel,
        statusOverride,
        errorOverride,
      };
    }

    // 4. fileChange envelope: { status?, changes: [{ path, kind }] }
    if (Array.isArray(value.changes) && value.changes.every((item) => isPlainRecord(item) && typeof item.path === 'string')) {
      const changes: ToolFileChangeItem[] = value.changes.map((item) => {
        const rec = item as Record<string, unknown>;
        const rawKind = typeof rec.kind === 'string'
          ? rec.kind
          : isPlainRecord(rec.kind) && typeof rec.kind.type === 'string'
            ? rec.kind.type
            : undefined;
        return {
          path: String(rec.path),
          kind: normalizeFileChangeKind(rawKind),
          rawKind,
        };
      });
      return {
        block: { kind: 'fileChanges', changes },
        statusOverride: typeof value.status === 'string' ? value.status : undefined,
      };
    }

    // 5. mcpToolCall / dynamicToolCall envelope: { status, durationMs, result, error, contentItems }
    if ('result' in value || 'contentItems' in value) {
      const durationLabel = typeof value.durationMs === 'number' ? formatDurationMs(value.durationMs) : undefined;
      const statusOverride = typeof value.status === 'string' ? value.status : undefined;
      const errorOverride = typeof value.error === 'string' ? value.error : isPlainRecord(value.error) && typeof value.error.message === 'string' ? value.error.message : undefined;
      const extractedText = extractContentItemsText(value.contentItems) ?? extractContentItemsText((value.result as Record<string, unknown> | undefined)?.content);
      if (extractedText !== undefined) {
        return {
          block: extractedText ? { kind: 'text', text: extractedText } : undefined,
          durationLabel,
          statusOverride,
          errorOverride,
        };
      }
      if (value.result !== undefined) {
        const resultBlock: ToolOutputBlock = typeof value.result === 'string'
          ? { kind: 'text', text: value.result }
          : isPlainRecord(value.result) && canRenderAsParamTable(value.result)
            ? {
                kind: 'params',
                items: Object.entries(value.result).filter(([, v]) => v !== undefined).map(([k, v]) => ({
                  key: k,
                  value: formatParamValue(k, v),
                  mono: isMonoParam(k, v),
                })),
              }
            : { kind: 'json', code: JSON.stringify(value.result, null, 2) };
        return {
          block: resultBlock,
          durationLabel,
          statusOverride,
          errorOverride,
        };
      }
    }

    if (canRenderAsParamTable(value)) {
      return {
        block: {
          kind: 'params',
          items: Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => ({ key: k, value: formatParamValue(k, v), mono: isMonoParam(k, v) })),
        },
      };
    }

    return { block: { kind: 'json', code: JSON.stringify(value, null, 2) } };
  }

  return { block: { kind: 'json', code: JSON.stringify(value, null, 2) } };
}

function tryParseCodexShellTranscript(text: string): {
  chunkId?: string | undefined;
  wallTime?: string | undefined;
  exitCode?: number | undefined;
  output: string;
} | null {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = normalized.match(
    /^(?:Chunk ID:\s*([^\n]+)\n)?Wall time:\s*([0-9.]+)\s*seconds?\nProcess exited with code\s*(-?\d+)\n(?:Original token count:\s*\d+\n)?Output:\n?([\s\S]*)$/i,
  );
  if (!match) return null;
  const wallSecs = Number(match[2]);
  const wallTime = Number.isFinite(wallSecs) ? formatDurationMs(Math.round(wallSecs * 1_000)) : `${match[2]}s`;
  return {
    chunkId: match[1]?.trim(),
    wallTime,
    exitCode: Number(match[3]),
    output: match[4] ?? '',
  };
}

function isSubagentStatusMap(record: Record<string, unknown>): boolean {
  const entries = Object.entries(record);
  if (entries.length === 0) return false;
  return entries.every(([, val]) => {
    if (typeof val === 'string') return true;
    if (isPlainRecord(val)) {
      const keys = Object.keys(val);
      return keys.length >= 1 && keys.length <= 3 && keys.some((k) => ['completed', 'running', 'failed', 'errored', 'shutdown', 'pending_init', 'not_found'].includes(k));
    }
    return false;
  });
}

function parseAgentStatusEntry(agentId: string, stateVal: unknown): ToolAgentStatusEntry {
  if (typeof stateVal === 'string') {
    return {
      agentId,
      state: humanizeStatusWord(stateVal),
      tone: statusToneFromRaw(stateVal),
    };
  }
  if (isPlainRecord(stateVal)) {
    const [stateKey, detailVal] = Object.entries(stateVal)[0] ?? ['completed', undefined];
    const summary = typeof detailVal === 'string'
      ? detailVal
      : detailVal !== undefined && detailVal !== null
        ? JSON.stringify(detailVal, null, 2)
        : undefined;
    return {
      agentId,
      state: humanizeStatusWord(stateKey),
      tone: statusToneFromRaw(stateKey),
      summary,
    };
  }
  return {
    agentId,
    state: 'Completed',
    tone: 'success',
    summary: String(stateVal),
  };
}

function normalizeFileChangeKind(rawKind?: string): 'add' | 'update' | 'delete' | 'other' {
  const lower = (rawKind ?? '').toLowerCase();
  if (lower.includes('add') || lower.includes('create')) return 'add';
  if (lower.includes('del') || lower.includes('remove')) return 'delete';
  if (lower.includes('update') || lower.includes('modif') || lower.includes('edit') || lower.includes('move')) return 'update';
  return 'other';
}

function extractContentItemsText(items: unknown): string | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of items) {
    if (!isPlainRecord(item)) return undefined;
    if (typeof item.text === 'string') {
      parts.push(item.text);
    } else {
      return undefined;
    }
  }
  return parts.join('\n\n');
}

function normalizeStatus(
  statusRaw: string | undefined,
  exitCode: number | undefined,
  error: string | undefined,
): StructuredToolDetail['status'] {
  if (error && !statusRaw) {
    return { raw: 'failed', label: 'Failed', tone: 'error' };
  }
  if (exitCode !== undefined && exitCode !== 0 && (!statusRaw || statusRaw.toLowerCase() === 'completed' || statusRaw.toLowerCase() === 'success')) {
    return { raw: `exit_${exitCode}`, label: 'Failed', tone: 'error' };
  }
  if (!statusRaw) return undefined;
  return {
    raw: statusRaw,
    label: humanizeStatusWord(statusRaw),
    tone: statusToneFromRaw(statusRaw),
  };
}

function humanizeStatusWord(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === 'completed' || lower === 'success' || lower === 'succeeded' || lower === 'ok' || lower === 'done') return 'Completed';
  if (lower === 'inprogress' || lower === 'in_progress' || lower === 'running' || lower === 'executing' || lower === 'sending' || lower === 'pending_init') return 'Running';
  if (lower === 'failed' || lower === 'error' || lower === 'errored') return 'Failed';
  if (lower === 'timed_out' || lower === 'timeout') return 'Timed out';
  if (lower === 'aborted' || lower === 'cancelled' || lower === 'canceled' || lower === 'declined' || lower === 'interrupted') return 'Cancelled';
  if (lower === 'shutdown') return 'Closed';
  return raw.trim();
}

function statusToneFromRaw(raw: string): ToolStatusTone {
  const lower = raw.trim().toLowerCase();
  if (['completed', 'success', 'succeeded', 'ok', 'done'].includes(lower)) return 'success';
  if (['inprogress', 'in_progress', 'running', 'executing', 'sending', 'pending_init'].includes(lower)) return 'running';
  if (['failed', 'error', 'errored', 'not_found'].includes(lower)) return 'error';
  if (['timed_out', 'timeout', 'aborted', 'cancelled', 'canceled', 'declined', 'interrupted'].includes(lower)) return 'warning';
  return 'neutral';
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms === 0) return '0ms';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds >= 10 ? seconds.toFixed(1).replace(/\.0$/, '') : seconds.toFixed(2).replace(/\.?0+$/, '')}s`;
  }
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

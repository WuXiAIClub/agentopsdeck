const GENERIC_ASSISTANT_FAILURE_RE = /^\[?assistant turn (?:failed|was stopped) before producing content\.?\]?$/i;
const MAX_FAILURE_REASON_CHARS = 500;

export function enrichGatewayHistoryFailuresFromRawTranscript(gatewayRows: any[], rawRows: any[]): any[] {
  if (!Array.isArray(gatewayRows) || gatewayRows.length === 0 || !Array.isArray(rawRows) || rawRows.length === 0) return gatewayRows;
  const rawFailures = rawRows.map((row, index) => ({ row, index, reason: sanitizedRowFailureReason(row) })).filter((candidate) => candidate.reason && isAssistantFailureRow(candidate.row));
  if (rawFailures.length === 0) return gatewayRows;

  const byKey = new Map<string, typeof rawFailures[number]>();
  for (const candidate of rawFailures) {
    for (const key of rowMatchKeys(candidate.row)) {
      if (!byKey.has(key)) byKey.set(key, candidate);
    }
  }

  let failureOrdinal = 0;
  let changed = false;
  const enriched = gatewayRows.map((row) => {
    if (!isEnrichableGatewayFailureRow(row)) return row;
    const exact = rowMatchKeys(row).map((key) => byKey.get(key)).find(Boolean);
    const candidate = exact ?? rawFailures[failureOrdinal];
    failureOrdinal += 1;
    if (!candidate?.reason) return row;
    changed = true;
    return { ...row, errorMessage: candidate.reason, failureReason: candidate.reason };
  });
  return changed ? enriched : gatewayRows;
}

export function sanitizeFailureReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;

  text = text
    .replace(/(authorization|cookie|set-cookie)\s*[:=]\s*(bearer\s+)?[^\s,;)}\]]+/gi, '$1: [redacted]')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)\s*[:=]\s*(["'])?[^\s,"';)}\]]+\2?/gi, '$1: [redacted]')
    .replace(/(["'])(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|encrypted[_-]?content|request|headers|body)\1\s*:\s*(["']).*?\3/gi, '$1$2$1: "[redacted]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,})\b/g, '[redacted-token]')
    .replace(/(encrypted content)\s+(["'`])?[A-Za-z0-9+/_=-]{16,}\2?/gi, '$1 [redacted]')
    .replace(/\b[A-Za-z0-9+/_=-]{96,}\b/g, '[redacted-blob]')
    .replace(/\b[0-9a-f]{64,}\b/gi, '[redacted-blob]')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > MAX_FAILURE_REASON_CHARS) text = `${text.slice(0, MAX_FAILURE_REASON_CHARS - 1).trimEnd()}…`;
  return text || undefined;
}

function sanitizedRowFailureReason(row: any): string | undefined {
  return sanitizeFailureReason(row?.failureReason ?? row?.errorMessage ?? row?.error ?? row?.message?.errorMessage ?? row?.message?.error);
}

function isEnrichableGatewayFailureRow(row: any): boolean {
  if (!isAssistantFailureRow(row)) return false;
  if (sanitizedRowFailureReason(row)) return false;
  const text = rowText(row);
  return !text || GENERIC_ASSISTANT_FAILURE_RE.test(text);
}

function isAssistantFailureRow(row: any): boolean {
  if (rowRole(row) !== 'assistant') return false;
  const statusText = String(row?.status ?? row?.state ?? row?.stopReason ?? row?.message?.status ?? row?.message?.state ?? row?.message?.stopReason ?? '').toLowerCase();
  const text = rowText(row).toLowerCase();
  return Boolean(row?.failed ?? row?.isError ?? row?.error ?? row?.errorMessage ?? row?.failureReason ?? row?.message?.error ?? row?.message?.errorMessage ?? row?.message?.isError)
    || /fail|error|crash/.test(statusText)
    || text.includes('assistant turn failed before producing content')
    || text.includes('assistant turn was stopped before producing content');
}

function rowRole(row: any): string {
  return String(row?.role ?? row?.authorRole ?? row?.message?.role ?? '').toLowerCase();
}

function rowText(row: any): string {
  const text = firstString(row?.text, row?.content, row?.message?.text, row?.message?.content);
  return text.trim();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const joined = value.map((item) => typeof item === 'string' ? item : (typeof (item as any)?.text === 'string' ? (item as any).text : '')).filter(Boolean).join('\n');
      if (joined) return joined;
    }
  }
  return '';
}

function rowMatchKeys(row: any): string[] {
  const values = [
    row?.id,
    row?.messageId,
    row?.message?.id,
    row?.ts,
    row?.timestamp,
    row?.createdAt,
    row?.message?.timestamp,
  ];
  const keys = new Set<string>();
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    keys.add(String(value));
  }
  return [...keys];
}

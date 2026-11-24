export function stableGatewayRowsRevision(rows: unknown[]): string {
  return `r:${fnv1a64(JSON.stringify(rows.map(rowFingerprint)))}`;
}

function rowFingerprint(row: unknown): Record<string, unknown> {
  const record = isRecord(row) ? row : {};
  const content = Array.isArray(record.content) ? record.content : [];
  return {
    id: stringValue(record.id ?? record.messageId ?? record.sessionKey ?? record.key ?? record.sessionId ?? record.ts ?? record.timestamp),
    agentId: stringValue(record.agentId),
    role: stringValue(record.role ?? record.authorRole ?? (isRecord(record.message) ? record.message.role : undefined)),
    type: stringValue(record.type),
    status: stringValue(record.status),
    ...(record.runtime === undefined ? {} : { runtimeHash: valueDigest(record.runtime) }),
    queueVersion: stringValue(record.queueVersion),
    source: stringValue(record.source),
    createdAt: stringValue(record.createdAt ?? record.ts ?? record.timestamp),
    updatedAt: stringValue(record.updatedAt),
    lastActiveAt: stringValue(record.lastActiveAt),
    hasActiveRun: Boolean(record.hasActiveRun),
    pendingSubagentCount: Number(record.pendingSubagentCount ?? 0) || 0,
    messageCount: Number(record.messageCount ?? 0) || 0,
    tokenCount: Number(record.totalTokens ?? record.estimatedTokens ?? record.contextTokens ?? 0) || 0,
    toolCallId: stringValue(record.toolCallId ?? record.tool_call_id),
    toolName: stringValue(record.toolName ?? record.name),
    toolDetailAvailable: Boolean(record.toolDetailAvailable),
    toolLineCount: Number(record.toolLineCount ?? 0) || 0,
    ...(record.codexSubagent === undefined ? {} : { codexSubagentHash: valueDigest(record.codexSubagent) }),
    isError: Boolean(record.isError),
    errorHash: valueDigest(record.failureReason ?? record.errorMessage ?? record.error),
    titleHash: valueDigest(record.title ?? record.label ?? record.name),
    recentHash: valueDigest(record.recent),
    textHash: textDigest(record),
    media: mediaFingerprint(record),
    sessions: Array.isArray(record.sessions) ? record.sessions.map(rowFingerprint) : [],
    content: content.map((item) => contentFingerprint(item)),
  };
}

function contentFingerprint(item: unknown) {
  const record = isRecord(item) ? item : {};
  return {
    id: stringValue(record.id),
    type: stringValue(record.type),
    name: stringValue(record.name),
    status: stringValue(record.status),
    toolCallId: stringValue(record.toolCallId ?? record.tool_call_id),
    textHash: textDigest(record),
    argumentHash: valueDigest(record.arguments),
    outputHash: valueDigest(record.output ?? record.result),
  };
}

function mediaFingerprint(record: Record<string, unknown>) {
  const raw = [record.media, record.attachments, record.files].find(Array.isArray) as unknown[] | undefined;
  return (raw ?? []).map((item) => {
    const media = isRecord(item) ? item : {};
    return {
      id: stringValue(media.id ?? media.url ?? media.path),
      name: stringValue(media.name ?? media.filename),
      mimeType: stringValue(media.mimeType ?? media.type),
      size: Number(media.size ?? media.bytes ?? 0) || 0,
    };
  });
}

function textDigest(record: Record<string, unknown>) {
  return valueDigest([record.text, record.content, record.message, record.output, record.result, record.payload]);
}

function valueDigest(value: unknown): string {
  return `${sizeOf(value)}:${fnv1a64(stableSerialize(value))}`;
}

function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + sizeOf(item), 0);
  if (isRecord(value)) return Object.values(value).reduce<number>((sum, item) => sum + sizeOf(item), 0);
  return String(value).length;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function stringValue(value: unknown) {
  return value === undefined || value === null ? '' : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fnv1a64(input: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(36);
}

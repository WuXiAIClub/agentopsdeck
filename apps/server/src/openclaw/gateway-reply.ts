export type GatewayReply = { text: string; sequence: number };

export function parseGatewayReply(raw: unknown): GatewayReply | undefined {
  if (!record(raw) || raw.event !== 'chat' || !record(raw.payload)) return;
  const payload = raw.payload;
  if (payload.state !== 'final' || !identity(payload.sessionKey, 4096) || !identity(payload.runId, 512)
    || !Number.isSafeInteger(payload.seq) || Number(payload.seq) < 0
    || (payload.stopReason !== undefined && !['stop', 'end_turn'].includes(String(payload.stopReason)))
    || payload.error !== undefined || payload.errorMessage !== undefined) return;
  if (payload.message === undefined) return { text: '', sequence: Number(payload.seq) };
  if (!record(payload.message) || payload.message.role !== 'assistant') return;
  const content = payload.message.content;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content.length <= 1024
    && content.every(part => record(part) && part.type === 'text' && typeof part.text === 'string')) {
    if (content.reduce((bytes, part) => bytes + Buffer.byteLength(part.text), 0) > 1024 * 1024) return;
    text = content.map(part => part.text).join('\n');
  } else return;
  if (Buffer.byteLength(text) > 1024 * 1024) return;
  return { text, sequence: Number(payload.seq) };
}

function identity(value: unknown, bytes: number) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= bytes;
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

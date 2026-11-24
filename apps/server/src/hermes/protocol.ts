// Compatibility baseline: Hermes b873a3a1d946ccd0b86fcf10ddfb43f72f42542b.
// Internal only: importing this module never launches or registers a runtime.
export const HERMES_PROTOCOL_BASELINE = 'b873a3a1d946ccd0b86fcf10ddfb43f72f42542b';
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class HermesProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'HermesProtocolError'; }
}

export type RpcId = string | number;
export type RpcFrame =
  | { kind: 'response'; id: RpcId; result: unknown }
  | { kind: 'error'; id: RpcId | null; code: number }
  | { kind: 'request'; id: RpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown): value is RpcId {
  return (typeof value === 'string' && value.length > 0 && value.length <= 256)
    || (typeof value === 'number' && Number.isSafeInteger(value));
}

export function sequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseRpcFrame(value: unknown): RpcFrame {
  const bad = () => new HermesProtocolError('Invalid Hermes RPC frame');
  if (!record(value) || value.jsonrpc !== '2.0') throw bad();
  if ('method' in value) {
    if (typeof value.method !== 'string' || !value.method || value.method.length > 256
      || 'result' in value || 'error' in value) throw bad();
    if ('id' in value) {
      if (!validId(value.id)) throw bad();
      return { kind: 'request', id: value.id, method: value.method, params: value.params };
    }
    return { kind: 'notification', method: value.method, params: value.params };
  }
  if ('result' in value && !('error' in value) && validId(value.id)) {
    return { kind: 'response', id: value.id, result: value.result };
  }
  if ('error' in value && !('result' in value) && (value.id === null || validId(value.id))
    && record(value.error) && Number.isSafeInteger(value.error.code) && typeof value.error.message === 'string') {
    // Do not retain native messages/data: errors may contain prompts or secrets.
    return { kind: 'error', id: value.id, code: value.error.code as number };
  }
  throw bad();
}

/** Bounded NDJSON, byte-based limits, fatal UTF-8, no incomplete EOF frames. */
export class HermesFrameDecoder {
  private buffer: Buffer;
  private bytes = 0;
  private ended = false;

  constructor(readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new RangeError('Invalid frame byte limit');
    this.buffer = Buffer.allocUnsafe(Math.min(4096, maxFrameBytes));
  }

  push(chunk: Uint8Array): RpcFrame[] {
    if (this.ended) throw new HermesProtocolError('Hermes decoder is closed');
    const frames: RpcFrame[] = [];
    try {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        this.append(chunk.subarray(start, i));
        const line = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.bytes)).trim();
        this.bytes = 0;
        if (line) frames.push(parseRpcFrame(JSON.parse(line)));
        start = i + 1;
      }
      this.append(chunk.subarray(start));
      return frames;
    } catch (error) {
      this.close();
      if (error instanceof HermesProtocolError) throw error;
      // Never include the offending wire body or JSON.parse's source excerpt.
      throw new HermesProtocolError('Invalid Hermes JSON or UTF-8');
    }
  }

  finish(): void {
    const partial = this.bytes > 0;
    this.close();
    if (partial) throw new HermesProtocolError('Incomplete Hermes frame at EOF');
  }

  close(): void { this.ended = true; this.buffer = Buffer.alloc(0); this.bytes = 0; }

  private append(part: Uint8Array): void {
    if (this.bytes + part.byteLength > this.maxFrameBytes) throw new HermesProtocolError('Hermes frame exceeds byte limit');
    if (this.bytes + part.byteLength > this.buffer.length) {
      const next = Buffer.allocUnsafe(Math.min(this.maxFrameBytes, Math.max(this.buffer.length * 2, this.bytes + part.byteLength)));
      this.buffer.copy(next, 0, 0, this.bytes); this.buffer = next;
    }
    this.buffer.set(part, this.bytes); this.bytes += part.byteLength;
  }
}

export interface HermesEvent {
  type: string;
  sessionId: string | undefined;
  seq: number | undefined;
  payload: Record<string, unknown> | undefined;
}

/** Input is params, both for live notifications and session.events.since. */
export function parseHermesEvent(params: unknown): HermesEvent {
  if (!record(params) || typeof params.type !== 'string' || !params.type
    || params.type.length > 256 || 'data' in params
    || (params.session_id !== undefined && typeof params.session_id !== 'string')
    || (params.seq !== undefined && (!sequence(params.seq) || params.seq === 0))
    || (params.payload !== undefined && !record(params.payload))) {
    throw new HermesProtocolError('Invalid Hermes event envelope');
  }
  const sessionId = params.session_id as string | undefined;
  if (sessionId && (sessionId.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionId))) {
    throw new HermesProtocolError('Invalid Hermes event session identity');
  }
  if (params.seq !== undefined && !sessionId) throw new HermesProtocolError('Sequenced Hermes event has no session');
  return { type: params.type, sessionId: sessionId || undefined, seq: params.seq as number | undefined,
    payload: params.payload as Record<string, unknown> | undefined };
}

export function readyEpoch(event: HermesEvent): string | undefined {
  if (event.type !== 'gateway.ready') return undefined;
  const epoch = event.payload?.replay_epoch;
  if (event.sessionId || event.seq !== undefined || typeof epoch !== 'string' || !epoch || epoch.length > 256
    || typeof event.payload?.change_events !== 'boolean') throw new HermesProtocolError('Invalid Hermes readiness event');
  // This is transport readiness only, NOT runtime execution readiness.
  return epoch;
}

/** Only a terminal observation; caller still checks session/execution and history. */
export function terminalStatus(event: HermesEvent): 'completed' | 'failed' | 'interrupted' | undefined {
  if (event.type !== 'message.complete' || !event.sessionId) return undefined;
  switch (event.payload?.status) {
    case 'complete': return 'completed';
    case 'error': return 'failed';
    case 'interrupted': return 'interrupted';
    default: return undefined; // Includes status-less child mirrors.
  }
}

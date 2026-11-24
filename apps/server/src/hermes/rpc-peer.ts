import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { DEFAULT_MAX_FRAME_BYTES, HermesFrameDecoder, record, type RpcFrame, type RpcId } from './protocol.js';

/** A transport failure is NOT a native rejection or proof of no side effects. */
export class HermesTransportError extends Error {
  constructor(readonly delivery: 'not_sent' | 'unknown', readonly reason: string) {
    super(`Hermes transport: ${reason}`); this.name = 'HermesTransportError';
  }
}

export class HermesRemoteError extends Error {
  constructor(readonly code: number) {
    super(`Hermes RPC error (${code})`); this.name = 'HermesRemoteError';
  }
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HermesRpcOptions {
  maxFrameBytes?: number;
  maxInFlight?: number;
  timeoutMs?: number;
  /** Synchronous, nonblocking projection handoff; never log arbitrary params. */
  onNotification: (method: string, params: unknown) => void;
  onClose?: (reason: string) => void;
}

/**
 * Owned stdio pipe transport, with no process spawn, credentials, retries, runtime
 * registration or queue semantics. The future process supervisor owns the child.
 * Server requests fail closed until a separately authorized interaction bridge
 * exists. Do not advertise client.capabilities.server_requests=true yet.
 */
export class HermesRpcPeer {
  private readonly decoder: HermesFrameDecoder;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly prefix = randomUUID();
  private nextId = 0;
  private closed = false;
  private readonly maxInFlight: number;
  private readonly timeoutMs: number;

  constructor(private readonly output: Readable, private readonly input: Writable, private readonly options: HermesRpcOptions) {
    this.decoder = new HermesFrameDecoder(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    this.maxInFlight = options.maxInFlight ?? 64;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.maxInFlight) || this.maxInFlight < 1
      || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new RangeError('Invalid Hermes RPC limits');
    }
    // Raw buffers are required for byte limits and split UTF-8 validation.
    if (output.readableEncoding) throw new TypeError('Hermes stdout must be a byte stream');
    input.on('error', this.inputError);
    input.once('close', this.inputClose);
    void this.read();
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed) throw new HermesTransportError('not_sent', 'closed');
    if (!method || method.length > 256) throw new HermesTransportError('not_sent', 'invalid_method');
    if (this.pending.size >= this.maxInFlight) throw new HermesTransportError('not_sent', 'inflight_limit');
    const id = `${this.prefix}:${++this.nextId}`;
    let wire: string;
    try { wire = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'; }
    catch { throw new HermesTransportError('not_sent', 'invalid_params'); }
    if (Buffer.byteLength(wire) - 1 > this.decoder.maxFrameBytes) throw new HermesTransportError('not_sent', 'frame_limit');
    // Bound bytes queued behind a stalled child. A false write() alone is NOT
    // rejection: bytes have already been accepted by the stream at that point.
    if (this.input.writableLength + Buffer.byteLength(wire) > this.decoder.maxFrameBytes + 1) {
      throw new HermesTransportError('not_sent', 'backpressure');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesTransportError('unknown', 'timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); // Native events can precede ACK.
      this.write(wire);
    });
  }

  close(): void { this.fail('closed'); }

  private readonly inputError = (): void => { this.fail('stdin_error'); };
  private readonly inputClose = (): void => {
    this.fail('stdin_closed');
    this.input.off('error', this.inputError);
  };

  private async read(): Promise<void> {
    try {
      for await (const chunk of this.output) {
        if (this.closed) break;
        if (!(chunk instanceof Uint8Array)) { this.fail('non_byte_stdout'); break; }
        for (const frame of this.decoder.push(chunk)) {
          if (this.closed) break;
          this.receive(frame);
        }
      }
      if (!this.closed) { this.decoder.finish(); this.fail('stdout_eof'); }
    } catch { this.fail('protocol_or_stdout_error'); }
  }

  private receive(frame: RpcFrame): void {
    if (frame.kind === 'notification') {
      try {
        const result: unknown = this.options.onNotification(frame.method, frame.params);
        if (record(result) && typeof result.then === 'function') {
          // TypeScript allows an async function in a void callback. Do not silently
          // drop its rejection, or await it and deadlock callbacks that request RPC.
          void Promise.resolve(result).catch(() => {});
          this.fail('async_notification_handler');
        }
      }
      catch { this.fail('notification_handler_error'); }
    } else if (frame.kind === 'request') {
      // Never echo the request method, params, secret or command into error text.
      this.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
        error: { code: -32601, message: 'Server requests are not supported by this client' } }) + '\n');
    } else {
      if (frame.kind === 'error' && frame.id === null) {
        this.fail('uncorrelated_native_error'); return;
      }
      const pending = frame.id === null ? undefined : this.pending.get(frame.id);
      if (!pending) return; // Late/duplicate ACK; never re-execute or re-settle.
      this.pending.delete(frame.id!); clearTimeout(pending.timer);
      if (frame.kind === 'error') pending.reject(new HermesRemoteError(frame.code));
      else pending.resolve(frame.result);
    }
  }

  private write(wire: string): void {
    if (this.closed) return;
    if (this.input.writableLength + Buffer.byteLength(wire) > this.decoder.maxFrameBytes + 1) {
      this.fail('backpressure'); return;
    }
    try { this.input.write(wire, error => { if (error) this.fail('stdin_error'); }); }
    catch { this.fail('stdin_error'); }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true; this.decoder.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new HermesTransportError('unknown', reason));
    }
    this.pending.clear(); this.input.destroy(); this.output.destroy();
    try { this.options.onClose?.(reason); } catch { /* A consumer cannot keep broken pipes live. */ }
  }
}

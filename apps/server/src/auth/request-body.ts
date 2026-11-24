import { HTTPException } from 'hono/http-exception';
import { readJsonBody } from '../utils/http-body.js';

export const AUTH_KEY_BODY_BYTES = 8 * 1024;
export const AUTH_PASSKEY_BODY_BYTES = 128 * 1024;

export class AuthBodyError extends Error {
  constructor(readonly status: 400 | 408 | 413 | 429, message: string) { super(message); }
}

/** Shared per route registry, before crypto admission. No waiting queue. */
export class AuthBodyReader {
  private active = 0;
  constructor(private readonly maxReaders = 8, private readonly timeoutMs = 10_000) {
    if (!Number.isInteger(maxReaders) || maxReaders < 1 || maxReaders > 32
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid auth body budget');
  }

  async read(request: Request, maxBytes: number): Promise<unknown> {
    if (this.active >= this.maxReaders) {
      // Do not retain a rejected stream or wait for its producer to acknowledge cancellation.
      if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
      throw new AuthBodyError(429, 'auth_body_capacity');
    }
    this.active++;
    try { return await readJsonBody(request, maxBytes, this.timeoutMs); }
    catch (error) {
      if (error instanceof HTTPException) {
        if (error.status === 413) throw new AuthBodyError(413, 'auth_body_too_large');
        if (error.status === 408) throw new AuthBodyError(408, 'auth_body_timeout');
      }
      // Never return parser fragments, producer errors, or credential material.
      throw new AuthBodyError(400, 'auth_body_invalid');
    } finally { this.active--; }
  }
}

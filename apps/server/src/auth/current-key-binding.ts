import { AuthPersistenceError } from './private-store.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Private server configuration, not a browser grant or a replacement for the
 * constructor-bound administrator guard. Only the original session-current
 * callback changes. No token, raw key or callable crosses this command. */
export type CurrentKeyBinding = { epoch: number; keyIdentityHash?: string };
export type CurrentKeyBindingCommand = { kind: 'currentKeyBinding'; input: CurrentKeyBinding };
export type CurrentKeyBindingResult = { kind: 'currentKeyBinding'; value: CurrentKeyBinding };
export type AuthKeyDeliveryFence = { capture(): number; assertCurrent(epoch: number): void };
export function validCurrentKeyBinding(value: unknown): value is CurrentKeyBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.hasOwn(v, 'epoch') && Number.isSafeInteger(v.epoch) && Number(v.epoch) >= 1
    && Object.keys(v).every(key => key === 'epoch' || key === 'keyIdentityHash')
    && (!Object.hasOwn(v, 'keyIdentityHash') || typeof v.keyIdentityHash === 'string' && /^[a-f0-9]{24}$/.test(v.keyIdentityHash));
}

/** Worker-local currentKey callback; constructor guard evidence stays fixed.
 * The supervisor drains all original accepted work before this update. */
export class OriginalAuthCurrentKey {
  private epoch = 0;
  constructor(public keyIdentityHash?: string) {}
  update(value: CurrentKeyBinding): CurrentKeyBinding {
    if (!validCurrentKeyBinding(value) || value.epoch !== this.epoch + 1) throw new AuthPersistenceError();
    this.keyIdentityHash = value.keyIdentityHash; this.epoch = value.epoch;
    return { ...value };
  }
}

/** Parent delivery/admission barrier. Unknown update ACK is terminal for this
 * binding; it never reopens admission, retries or replaces the original owner.
 * Existing commands drain their ORIGINAL promises, not an HTTP timeout. */
export class AuthCurrentKeyBinding implements AuthKeyDeliveryFence {
  private epoch = 0;
  private updating = false;
  private unavailable = false;
  private work?: Promise<void>;
  constructor(private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics, private readonly warningMs = 30_000) {}
  capture() {
    if (this.updating || this.unavailable) throw new AuthPersistenceError();
    return this.epoch;
  }
  assertCurrent(epoch: number) { if (this.capture() !== epoch) throw new AuthPersistenceError(); }
  get pending() { return this.work; }
  update(keyIdentityHash: string | undefined, originals: readonly Promise<unknown>[],
    send: (input: CurrentKeyBinding) => Promise<CurrentKeyBinding>): Promise<void> {
    const input = { epoch: this.epoch + 1, ...(keyIdentityHash === undefined ? {} : { keyIdentityHash }) };
    if (this.updating || this.unavailable || !validCurrentKeyBinding(input)) return Promise.reject(new AuthPersistenceError());
    this.epoch = input.epoch; this.updating = true; // Fence before the first await.
    const observe = (action: () => void) => { try { action(); } catch { /* No recovery authority in diagnostics. */ } };
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    this.work = Promise.resolve().then(async () => {
      observe(() => { trace = this.diagnostics.start('auth-current-key-binding'); trace.add('generation', input.epoch); });
      const warning = setTimeout(() => observe(() => trace?.reportPending({ pending: 1 })), this.warningMs); warning.unref();
      let failed = true;
      try {
        await Promise.allSettled(originals);
        const ack = await send(input);
        if (!validCurrentKeyBinding(ack) || ack.epoch !== input.epoch || ack.keyIdentityHash !== input.keyIdentityHash) {
          throw new AuthPersistenceError();
        }
        this.updating = false; failed = false;
        observe(() => trace?.add('settled', 1));
      } catch {
        this.unavailable = true; observe(() => trace?.add('unknown', 1)); throw new AuthPersistenceError();
      } finally { clearTimeout(warning); observe(() => trace?.finish(failed)); }
    });
    return this.work;
  }
}

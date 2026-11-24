import type { NativeInteractionRuntime, WorkerInteractionContext } from '../commands/interaction-port.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { SdkInteractionBinding } from './connector-sdk-dispatch-domain.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import { interactionCapabilitiesFor } from './sdk-interaction.js';

type Slot = { preparing: Promise<SdkInteractionBinding | null>; releasing?: Promise<void> };
export type SdkInteractionRuntime = NativeInteractionRuntime | {
  forSdkBinding(runtime: SdkAgentId, binding: SdkInteractionBinding): NativeInteractionRuntime;
  releaseSdkBinding(bindingId: string): Promise<void>;
};
const identity = (r: SdkCompactRef) => JSON.stringify([r.key, r.id, r.epoch, r.nativeSessionId]);

/** Local native handles never cross IPC. Bindings retain original authority,
 * not a cached permission decision. The owner outlives all original releases. */
export class AsyncSdkInteractions {
  private readonly slots = new Map<string, Slot>();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: SdkAgentId; interactions: SdkInteractionRuntime }) {}

  async prepare(ref: SdkCompactRef): Promise<WorkerInteractionContext | undefined> {
    if (this.closed) throw Error('Original native execution is unavailable');
    const fixed = { key: ref.key, id: ref.id, epoch: ref.epoch, nativeSessionId: ref.nativeSessionId }, key = identity(fixed);
    let slot = this.slots.get(key);
    if (!slot) {
      if (this.slots.size >= 128) throw Error('Original native execution is unavailable');
      slot = { preparing: Promise.resolve().then(() => this.options.owner.command('sdkInteractionPrepare', {
        runtime: this.options.runtime, ref: fixed,
      })).then(binding => {
        if (binding && identity(binding.ref) !== key) throw Error('Original native execution is unavailable');
        return binding;
      }) };
      this.slots.set(key, slot);
    }
    const binding = await slot.preparing;
    if (!binding) { if (this.slots.get(key) === slot) this.slots.delete(key); return; }
    if (this.closed || slot.releasing) throw Error('Original native execution is unavailable');
    const local = () => !this.closed && this.slots.get(key) === slot && !slot.releasing;
    const check = async () => local() && await this.options.owner.command('sdkInteractionCheck', {
      runtime: this.options.runtime, ref: fixed, bindingId: binding.bindingId,
    }) === true && local();
    return { runtime: 'forSdkBinding' in this.options.interactions
      ? this.options.interactions.forSdkBinding(this.options.runtime, binding) : this.options.interactions, scope: { ...binding.scope },
      capabilities: interactionCapabilitiesFor(this.options.runtime),
      permitted: async () => await check() === true,
      continuation: async () => {
        if (await check() !== true) throw Error('Original native execution is unavailable');
        return { connectionId: fixed.epoch, goal: { status: 'absent', version: `${this.options.runtime}:no-native-goal:v1` } };
      } };
  }

  release(ref: SdkCompactRef): Promise<void> { return this.releaseKey(identity(ref)); }
  freeze() { this.closed = true; }
  private releaseKey(key: string): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return Promise.resolve();
    if (!slot.releasing) slot.releasing = slot.preparing.then(async binding => {
      if (binding && 'releaseSdkBinding' in this.options.interactions) await this.options.interactions.releaseSdkBinding(binding.bindingId);
      if (binding && await this.options.owner.command('sdkInteractionRelease', {
        runtime: this.options.runtime, ref: binding.ref, bindingId: binding.bindingId,
      }) !== true) throw Error('Original native execution is unavailable');
      if (this.slots.get(key) === slot) this.slots.delete(key);
    });
    return slot.releasing;
  }
  close(): Promise<void> {
    this.freeze();
    if (!this.closing) this.closing = Promise.allSettled([...this.slots.keys()].map(key => this.releaseKey(key))).then(results => {
      if (results.some(result => result.status === 'rejected')) throw Error('SDK interaction cleanup could not be confirmed');
    });
    return this.closing;
  }
}

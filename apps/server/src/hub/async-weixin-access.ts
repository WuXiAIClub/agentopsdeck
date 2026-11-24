import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence, HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { validHubWeixinResult, validWeixinBindingEffectResult, matchesWeixinBindingEffectReply,
  type HubWeixinCommand, type WeixinBindingEffectCommand, type WeixinBindingEffectOwner } from './member-weixin-domain.js';
import { weixinOriginalEffect } from './weixin-original-effect.js';
import { WeixinError, type WeixinTransport } from './weixin-transport.js';

/** Route-owned lifetime: freeze only AFTER original provider work and its SQL
 * observations drain. Private credentials never enter public member results. */
export class AsyncHubWeixinAccess {
  private readonly persistence: AuthRoutePersistence;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly effects: WeixinBindingEffectOwner,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.persistence = new AuthRoutePersistence(diagnostics);
  }
  private async effectCommand(command: WeixinBindingEffectCommand) {
    const value = (await this.persistence.run(105, () => this.effects.command(command))).value;
    if (!validWeixinBindingEffectResult(value) || !matchesWeixinBindingEffectReply(command, value)) throw new HubMemberOwnerUnavailable();
    if ('error' in value) throw new WeixinError(value.error);
    return value;
  }
  release(reference: string) { return this.effectCommand({action: 'release', reference}); }
  async effect(reference: string, signal: AbortSignal, transport: WeixinTransport) {
    const access = await this.effectCommand({action: 'access', reference});
    if (access.action !== 'access') throw new HubMemberOwnerUnavailable();
    // A caller transport may ignore abort. Retain its ORIGINAL completion;
    // neither a request deadline nor close releases the shared effect slot.
    const observation = await weixinOriginalEffect(signal, 40_000, 'unavailable', async originalSignal => {
      const effect = access.effect;
      if (effect.kind === 'qr') return {kind: 'qr' as const, ...await transport.qr(originalSignal)};
      return {kind: 'poll' as const, result: await transport.pollQr(effect.code, effect.baseUrl, effect.verify, originalSignal)};
    }, this.diagnostics);
    signal.throwIfAborted();
    const result = await this.effectCommand({action: 'observe', reference, observation});
    if (result.action !== 'observe') throw new HubMemberOwnerUnavailable();
    return result.state;
  }
  async begin(request: Request) {
    const evidence = Object.freeze(hubMemberEvidence(request)), expected = request.headers.get('x-agentopsdeck-recovery-scope');
    let denied: HubMemberRequestError | undefined;
    const refuse = (status: ConstructorParameters<typeof HubMemberRequestError>[0]): never => {
      denied ??= new HubMemberRequestError(status); throw denied;
    };
    const current = () => { if (denied) throw denied; if (request.signal.aborted) refuse(499); };
    current();
    const snapshot = (await this.persistence.run(6, () => this.owner.command('memberSnapshot', evidence))).value;
    current(); if (!snapshot) return refuse(401);
    if (expected !== null && expected !== snapshot.recoveryScope) return refuse(409);
    const proof = {evidence, expectedScope: snapshot.recoveryScope};
    const check = async () => {
      current();
      const now = (await this.persistence.run(6, () => this.owner.command('memberSnapshot', evidence))).value;
      current();
      if (!now || now.recoveryScope !== proof.expectedScope || now.principal.userId !== snapshot.principal.userId) refuse(403);
    };
    const command = async (command: HubWeixinCommand) => {
      current();
      const value = (await this.persistence.run(105, () => this.owner.command('weixin', {...proof, command}))).value;
      if (!validHubWeixinResult(value)) throw new HubMemberOwnerUnavailable();
      // Admission ACK owns a private reference even if the browser aborted
      // while SQL was pending. Retire that original reference before refusal.
      if (request.signal.aborted && value && 'work' in value && value.work) await this.release(value.work);
      current();
      if (!value) return refuse(403);
      if ('error' in value) throw new WeixinError(value.error);
      if (value.action !== command.action) throw new HubMemberOwnerUnavailable();
      return value;
    };
    return {command, check};
  }
  close() { return this.persistence.close(); }
}

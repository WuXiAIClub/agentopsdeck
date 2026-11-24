import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubConnectorAccessReply } from './member-connector-access-domain.js';
import { copyOriginalRequest } from './original-request-scope.js';
import type { HubConnectionControlCommand } from './member-connection-control-domain.js';
import { weixinRequestBinding } from './weixin-bridge.js';

/** Owner-only HTTP proxy authority. Does not execute/retry external effects or
 * open a database. Each retained proof pins original evidence and one target;
 * delivery checks identity + directory + target epoch in one owner savepoint. */
export class AsyncHubConnectionProxyAccess {
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly requests: AsyncHubMemberRequests;
  private closed = false;
  readonly close: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.persistence = new AuthRoutePersistence(diagnostics);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics);
    this.requests = new AsyncHubMemberRequests(owner, diagnostics);
    const drain = createIndependentDrain([() => this.requests.close(), () => this.persistence.close()], 'hub-route-drain', diagnostics);
    this.close = () => { this.closed = true; return drain(); };
  }
  async begin(request: Request, id: string) {
    const evidence = Object.freeze(hubMemberEvidence(request));
    const weixin = weixinRequestBinding(request);
    const original = weixin ? request : copyOriginalRequest(request);
    const scope = original.headers.get('x-agentopsdeck-recovery-scope');
    let rejected: HubMemberRequestError | undefined;
    const deny = (status: ConstructorParameters<typeof HubMemberRequestError>[0]): never => {
      rejected ??= new HubMemberRequestError(status); throw rejected;
    };
    const current = () => { if (this.closed) deny(503); if (rejected) throw rejected; };
    try {
      current();
      const authority = await this.requests.begin(original);
      current();
      if (scope !== null && scope !== authority.recoveryScope) deny(409);
      const proof = { evidence, expectedScope: authority.recoveryScope };
      // A private Weixin read is not a directory/control capability. Preserve
      // exact Request evidence and pin only its target using the fixed access
      // command; the worker revalidates the live binding on every delivery.
      const pin = weixin ? undefined : (await this.reads.run(original, 82, () => this.owner.command('connectionDirectoryVersion', {
        ...proof, command: { action: 'version' },
      }))).value;
      current();
      if (!weixin && !pin) return deny(401);
      if (pin && pin.action !== 'version') return deny(503);
      const open = { action: 'open' as const, id, maintenance: false };
      const target = weixin
        ? (await this.reads.run(original, 33, () => this.owner.command('connectorAccess', { ...proof, command: open }))).value
        : (await this.reads.run(original, 33, () => this.owner.command('connectionTarget', { ...proof, id }))).value;
      current();
      if (weixin && !validHubConnectorAccessReply(open, target)) return deny(503);
      if (!target) return deny(401);
      if ('error' in target) return deny(404);
      if (!('connection' in target)) return deny(503);
      if (target.connection.status === 'disabled') return deny(404);
      if (target.connection.id !== id || target.connection.ownerUserId !== authority.principal.userId) return deny(503);
      const check = async () => {
        if (weixin) return checkTarget();
        try {
          for (let delivery = 0; delivery < 2; delivery++) {
            current();
            const value = (await this.reads.run(original, 83, () => this.owner.command('connectionDirectoryCheck', {
              ...proof, command: { action: 'check', version: pin!.version, target: { id, epoch: target.epoch } },
            }))).value;
            current();
            if (!value) return deny(401);
            if (value.action !== 'check' || !value.ok || value.version !== pin!.version
              || value.target?.id !== id || value.target.epoch !== target.epoch) return deny(403);
          }
        } catch (error) { return failed(error); }
      };
      const failed = (error: unknown): never => {
        const trace = guardedTrace(this.diagnostics, 'hub-request-authority');
        trace.add('step', 83); trace.add('deferred', 1); trace.finish(true);
        if (error instanceof HubMemberRequestError) throw error;
        return deny(error instanceof AuthReadCancelledError ? 499 : 503);
      };
      // Long-lived handles pin authority, not a directory presentation version.
      // The caller supplies detached evidence for leases, never an ended HTTP
      // request's cancellation signal. No fresh principal is accepted here.
      const checkTarget = async () => {
        try {
          const command = { action: 'check' as const, id, maintenance: false, expectedEpoch: target.epoch };
          for (let delivery = 0; delivery < 2; delivery++) {
            current();
            const value = (await this.reads.run(original, 83, () => this.owner.command('connectorAccess', { ...proof, command }))).value;
            current();
            if (!validHubConnectorAccessReply(command, value)) return deny(503);
            if (!value) return deny(401);
            if (!('ok' in value)) return deny(403);
          }
        } catch (error) { return failed(error); }
      };
      await check();
      const claimControl = async (command: Extract<HubConnectionControlCommand, {action: 'claim'}>) => {
        if (weixin) return deny(403);
        await check();
        if (command.id !== id || command.expectedEpoch !== target.epoch) return deny(403);
        // Claim is a write, not a cancellable read. Retain its original ACK
        // through HTTP cancellation/close; an ended wait cannot release intent.
        const result = (await this.persistence.run(104, () => this.owner.command('connectionControl', {...proof, command}))).value;
        await check();
        if (!result) return deny(401);
        if ('error' in result) return deny(result.error);
        if (result.action !== 'claim') return deny(503);
        if (result.reference.ownerUserId !== authority.principal.userId || result.reference.connectionId !== id || result.reference.key !== command.key) return deny(503);
        return result;
      };
      const controlReceipt = async (key: string, operation: 'reconcile' | 'updateCheck') => {
        if (weixin) return deny(403);
        await check();
        const result = (await this.reads.run(original, 33, () => this.owner.command('connectionControl', {...proof,
          command: {action: 'receipt', id, expectedEpoch: target.epoch, key, operation}}))).value;
        await check();
        if (!result) return deny(401);
        if ('error' in result) return deny(result.error);
        if (result.action !== 'receipt' || result.receipt.key !== key || result.receipt.operation !== operation) return deny(503);
        return result.receipt;
      };
      return Object.freeze({ principal: authority.principal, connection: Object.freeze({ ...target.connection }), epoch: target.epoch, check, checkTarget, claimControl, controlReceipt });
    } catch (error) {
      if (error instanceof HubMemberRequestError) throw error;
      return deny(error instanceof AuthReadCancelledError ? 499 : 503);
    }
  }
}

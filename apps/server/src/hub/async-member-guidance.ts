import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { decodeHubSessionId } from './session-id.js';
import { HUB_GUIDANCE_COMMAND_BYTES, hubGuidanceReplyExpectation, validHubGuidanceCommand,
  validHubGuidanceReply, type HubGuidanceCommand, type HubGuidanceResult } from './member-guidance-domain.js';
import type { HubSessionGuidancePort } from '../routes/hub-session-guidance-port.js';

/** Awaited request adapter, not application activation. Root transactions stay
 * in the original complete Hub owner. HTTP timeout/abort cannot settle an
 * accepted mutation, replace the writer or create another sending permit. */
export class AsyncHubMemberGuidance {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  close(): Promise<void> {
    const authority = this.requests.close(), commands = this.persistence.close();
    return Promise.all([authority, commands]).then(() => {});
  }
  /** Same legacy HTTP wire contract, backed by this original complete owner.
   * No second connection, browser-supplied ACK, callback RPC or retry worker. */
  readonly http: HubSessionGuidancePort = {
    begin: async (request, sessionId) => {
      const original = await this.begin(request, sessionId);
      const receipt = (value: Exclude<HubGuidanceResult, null>) => {
        if (!value.receipt) throw new HubMemberRequestError(503);
        return value.receipt;
      };
      return Object.freeze({
        request: original.request, nodeId: original.nodeId,
        ownerUserId: original.ownerUserId, connectionId: original.connectionId,
        remoteSessionKey: original.remoteSessionKey, check: original.check,
        async inspect() {
          const value = await original.inspect();
          return value.config && value.state ? { config: value.config, state: value.state } : undefined;
        },
        async save(revision: number, text: string, enabled: boolean) { await original.save(revision, text, enabled); },
        async prepare(requestId: string, revision: number, input: string) { return receipt(await original.prepare(requestId, revision, input)); },
        async lookup(requestId: string) {
          const value = await original.receipt(requestId);
          return { receipt: value.receipt, cancelled: value.cancelled === true };
        },
        async cancel(requestId: string) { await original.cancel(requestId); },
        async claim(requestId: string) {
          const value = await original.claim(requestId);
          if (typeof value.claimed !== 'boolean') throw new HubMemberRequestError(503);
          return { receipt: receipt(value), claimed: value.claimed };
        },
        async reconcile(requestId: string, ack: Extract<HubGuidanceCommand, { action: 'reconcile' }>['ack']) {
          await original.reconcile(requestId, ack);
        },
      });
    },
  };
  async begin(request: Request, sessionId: string) {
    if (!validHubGuidanceCommand({ action: 'authorize', sessionId })) throw new HubMemberRequestError(400);
    const decoded = decodeHubSessionId(sessionId);
    if (!decoded || !['codex:', 'claude-code:', 'ghcp:'].some(prefix => decoded.remoteSessionKey.startsWith(prefix))) throw new HubMemberRequestError(404);
    const original = new Request(request.url, { headers: new Headers(request.headers), signal: request.signal });
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    const target = await authority.connection(decoded.connectionId);
    if (!target.connection.nodeId || target.connection.status === 'disabled') throw new HubMemberRequestError(404);
    const proof = { evidence, expectedScope: authority.recoveryScope };
    type Value = Exclude<HubGuidanceResult, null>;
    const run = async (input: HubGuidanceCommand): Promise<Value> => {
      // Copy before the first await: no mutable ACK/body may retarget a write.
      let command: HubGuidanceCommand;
      try {
        command = JSON.parse(encodeHubMemberJson(input, HUB_GUIDANCE_COMMAND_BYTES));
        if (!validHubGuidanceCommand(command)) throw new Error('invalid_guidance_command');
      } catch { throw new HubMemberRequestError(400); }
      const expectation = hubGuidanceReplyExpectation(command);
      await authority.check();
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      const read = ['authorize', 'inspect', 'receipt'].includes(command.action);
      let value: HubGuidanceResult;
      try {
        const work = () => this.owner.command('sessionGuidance', { ...proof, command });
        value = (await (read ? this.reads.run(original, 48, work) : this.persistence.run(47, work))).value;
      } catch (error) {
        await authority.check();
        throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
      }
      if (value === null) throw new HubMemberRequestError(401);
      await authority.check(); // Delivery denial cannot undo a committed effect.
      if (!validHubGuidanceReply(expectation, value)) throw new HubMemberRequestError(503);
      if (value.status === 404 || value.status === 409) throw new HubMemberRequestError(value.status);
      if (value.nodeVersion !== target.epoch) throw new HubMemberRequestError(409);
      return value;
    };
    const check = async () => { await run({ action: 'authorize', sessionId }); };
    await check();
    const write = { sessionId, nodeVersion: target.epoch };
    return Object.freeze({
      request: original, ownerUserId: authority.principal.userId, nodeId: target.connection.nodeId,
      connectionId: decoded.connectionId, remoteSessionKey: decoded.remoteSessionKey,
      check,
      inspect: () => run({ action: 'inspect', sessionId }),
      save: (revision: number, text: string, enabled: boolean) => run({ ...write, action: 'save', revision, text, enabled }),
      prepare: (requestId: string, revision: number, input: string) => run({ ...write, action: 'prepare', requestId, revision, input }),
      receipt: (requestId: string) => run({ action: 'receipt', sessionId, requestId }),
      cancel: (requestId: string) => run({ ...write, action: 'cancel', requestId }),
      claim: (requestId: string) => run({ ...write, action: 'claim', requestId }),
      // Internal Connector response only. The HTTP adapter must not accept
      // this object from a browser or infer rejection from an I/O exception.
      reconcile: (requestId: string, ack: Extract<HubGuidanceCommand, { action: 'reconcile' }>['ack']) =>
        run({ ...write, action: 'reconcile', requestId, ack }),
    });
  }
}

import { HubRequestWork } from './async-request-work.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import type { CommandReceipt } from '../commands/receipts.js';
import { commandPayloadFingerprint, MAX_COMMAND_RESULT_BYTES } from '../commands/receipts.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { encodeHubMemberJson } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { hubMemberEvidence, HUB_MEMBER_COMMAND_BYTES } from './member-owner-domain.js';
import { validHubConnectionTarget } from './member-connection-change-domain.js';
import { validHubOwnerControlCommand, validHubOwnerControlReply, validOwnerControlTarget,
  ownerControlScope, HUB_OWNER_CONTROL_COMMAND_BYTES, type HubOwnerControlCommand, type OwnerControlTarget } from './member-owner-control-domain.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { OwnerControlPort, OwnerControlClient } from './owner-control.js';
import { decodeHubSessionId } from './session-id.js';
import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import { weixinRequestBinding } from './weixin-bridge.js';
import { copyOriginalRequest, pinOriginalRequestScope } from './original-request-scope.js';

/** One original Hub owner, no second file connection and no sync fallback.
 * Persisted unknown receipts survive cancelled delivery and owner restart.
 * Mutation ACKs are never timed out/replayed. Read deadlines only stop HTTP. */
export class AsyncHubOwnerControls {
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly work = new HubRequestWork();
  private readonly drain: () => Promise<void>;
  constructor(private readonly database: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly connector: AsyncConnectorClientResolver,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.requests = new AsyncHubMemberRequests(database, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(),
      () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  get pending() { return this.requests.pendingReads + this.persistence.pending; }
  get pendingRequests() { return this.work.pending; }
  close(): Promise<void> { void this.work.close(); return this.drain(); }
  open(request: Request, expectedOwner: string, input: OwnerControlTarget): Promise<OwnerControlPort> {
    return this.work.run(() => this.openOriginal(request, expectedOwner, input));
  }
  openCurrent(request: Request, input: OwnerControlTarget): Promise<OwnerControlPort> {
    return this.work.run(() => this.openOriginal(request, undefined, input));
  }
  private async openOriginal(request: Request, expectedOwner: string | undefined, input: OwnerControlTarget): Promise<OwnerControlPort> {
    const target = JSON.parse(encodeHubMemberJson(input, HUB_MEMBER_COMMAND_BYTES)) as OwnerControlTarget;
    if (!validOwnerControlTarget(target)) throw new HubMemberRequestError(404);
    // Exact private Request membership cannot survive cloning. Never recreate
    // its identity from headers or a serialized user/admin projection.
    const original = weixinRequestBinding(request) ? request
      : copyOriginalRequest(request);
    const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
    this.work.check();
    const owner = authority.principal.userId;
    if (expectedOwner !== undefined && owner !== expectedOwner) throw new HubMemberRequestError(403);
    const expectedScope = original.headers.get('x-agentopsdeck-recovery-scope');
    if (expectedScope !== null && expectedScope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    pinOriginalRequestScope(original, authority.recoveryScope);
    const read = async <T>(work: () => Promise<T>) => {
      try {
        this.work.check();
        const result = await this.reads.run(original, 64, () => { this.work.check(); return work(); });
        this.work.check(); return result.value;
      }
      catch (error) { throw new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503); }
    };
    const found = await read(() => this.database.command('connectionTarget', { evidence,
      expectedScope: authority.recoveryScope, id: target.connectionId }));
    await authority.check();
    this.work.check();
    if (!validHubConnectionTarget(found)) throw new HubMemberRequestError(503);
    if (!found) throw new HubMemberRequestError(401);
    if ('error' in found || found.connection.status === 'disabled') throw new HubMemberRequestError(404);
    if (found.connection.ownerUserId !== owner || found.connection.id !== target.connectionId) throw new HubMemberRequestError(503);
    const epoch = found.epoch, scope = ownerControlScope(owner, target);
    // A failure/unknown acknowledgment fences this request; it must not
    // dispatch using a fresh authority or silently try the sync backend.
    let failed = false;
    type Action<C = HubOwnerControlCommand> = C extends HubOwnerControlCommand ? Omit<C, 'target' | 'epoch'> : never;
    const run = async (action: Action) => {
      this.work.check();
      if (failed) throw new HubMemberRequestError(503);
      await authority.check();
      this.work.check();
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      let command: HubOwnerControlCommand;
      try { command = JSON.parse(encodeHubMemberJson({ ...action, target, epoch }, HUB_OWNER_CONTROL_COMMAND_BYTES)); }
      catch { failed = true; throw new HubMemberRequestError(503); }
      if (!validHubOwnerControlCommand(command)) throw new HubMemberRequestError(400);
      let result;
      const mutation = command.action === 'claim' || command.action === 'claimDigest' || command.action === 'settle' || command.action === 'cleanup';
      try {
        const work = () => {
          this.work.check();
          return this.database.command('ownerControl', { evidence, expectedScope: authority.recoveryScope, command });
        };
        result = mutation
          ? (await this.persistence.run(64, work)).value : await read(work);
      } catch {
        // Cancellation cannot establish whether an admitted mutation committed.
        // A missing original ACK is unknown, even if the browser also left.
        failed = true; throw new HubMemberRequestError(!mutation && original.signal.aborted ? 499 : 503);
      }
      this.work.check();
      await authority.check();
      this.work.check();
      if (!validHubOwnerControlReply(command, result)) { failed = true; throw new HubMemberRequestError(503); }
      if (!result) throw new HubMemberRequestError(401);
      if ('error' in result) throw new HubMemberRequestError(result.error);
      if (original.signal.aborted) throw new HubMemberRequestError(499);
      return result;
    };
    const check = async () => { await run({ action: 'check' }); };
    const get = async (key: string) => {
      const value = await run({ action: 'get', key });
      if (!('receipt' in value)) throw new HubMemberRequestError(503);
      return value.receipt ?? undefined;
    };
    const bound = async (key: string) => { if (!await get(key)) throw new HubMemberRequestError(404); };
    const deliveryKey = async (key: string) => {
      const value = await run({ action: 'delivery', key });
      if (!('delivery' in value)) throw new HubMemberRequestError(503); return value.delivery;
    };
    const client = async (): Promise<OwnerControlClient> => {
      await check();
      const value = (await this.connector(original, target.connectionId, { expectedUserId: owner }))
        .withLocalFence(() => this.work.check());
      await check();
      // Retain the real transport/cancellation ACK, not its HTTP deadline race.
      // The lifecycle fence still refuses any dispatch after close.
      return {
        json: (path, init) => this.work.run(() => value.jsonOriginal(path, init)),
        jsonResponse: (path, init) => this.work.run(() => value.jsonResponseOriginal(path, init)),
        weixinActionOriginal: (...args) => this.work.run(() => value.weixinActionOriginal(...args)),
      };
    };
    const settle = async (key: string, receipt: CommandReceipt | undefined) => {
      if (!receipt) return (await get(key))!;
      // Match original receipt settlement: unsupported large success metadata
      // remains unknown. Do not send it into RPC, trip the owner fence, or
      // interpret a locally oversized envelope as a lost mutation ACK.
      if (target.operation === 'message' && receipt.state === 'accepted' && receipt.result
        && Buffer.byteLength(JSON.stringify(receipt.result)) > MAX_COMMAND_RESULT_BYTES) return (await get(key))!;
      const value = await run({ action: 'settle', key, receipt });
      if (!('receipt' in value) || !value.receipt) throw new HubMemberRequestError(503); return value.receipt;
    };
    const session = target.sessionId ? decodeHubSessionId(target.sessionId)! : undefined;
    const upstream = target.operation === 'create' ? `/agents/${encodeURIComponent(target.agentId!)}/sessions`
      : `/sessions/${encodeURIComponent(session!.remoteSessionKey)}${target.operation === 'queue'
        ? `/queue${target.messageId ? `/${encodeURIComponent(target.messageId)}` : ''}` : ''}`;
    const recover = async (key: string) => {
      const receipt = await get(key);
      if (!receipt) throw new HubMemberRequestError(404);
      if (receipt.state !== 'outcome_unknown') return receipt;
      const commandPath = { message: 'commands', compact: 'compact-commands', queue: 'commands', create: 'creation-commands', settings: 'settings-commands', delete: 'deletion-commands' }[target.operation];
      try {
        const delivered = await deliveryKey(key);
        const body = await (await client()).json<{ command?: CommandReceipt }>(`${upstream}/${commandPath}/${encodeURIComponent(delivered)}`, { signal: original.signal });
        await bound(key);
        if (target.operation === 'settings' && body.command?.state === 'outcome_unknown' && body.command.settingsStartReleased === true
          && body.command.key === delivered && typeof body.command.id === 'string' && body.command.id.length > 0 && body.command.id.length <= 200) {
          const local = await run({ action: 'released', key });
          if ('released' in local && local.released) return { ...receipt, settingsStartReleased: true as const };
        }
        return await settle(key, body.command);
      } catch { await bound(key); return (await get(key))!; }
    };
    const claim = async (key: string, payload: unknown) => {
      const value = await run(target.operation === 'message' && !evidence.weixinBinding
        ? { action: 'claimDigest', key, digest: commandPayloadFingerprint(payload) } : { action: 'claim', key, payload });
      if (!('fresh' in value)) throw new HubMemberRequestError(503); return value;
    };
    const owned = <A extends unknown[], T>(action: (...args: A) => T | PromiseLike<T>) =>
      (...args: A) => this.work.run(() => action(...args));
    return { owner, session, authority: epoch, scope, nodeId: found.connection.nodeId,
      upstream, check: owned(check), get: owned(get), deliveryKey: owned(deliveryKey), bound: owned(bound),
      client: owned(client), claim: owned(claim), settle: owned(settle), recover: owned(recover),
      cleanup: owned(async (key: string) => { await run({ action: 'cleanup', key }); }) };
  }
}

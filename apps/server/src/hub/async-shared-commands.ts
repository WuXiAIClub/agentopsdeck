import { MAX_MESSAGE_CHARS, SHARED_MESSAGE_BODY_BYTES, SHARED_MESSAGE_FLIGHT_BYTES, copySharedMessageInput } from '@agentopsdeck/shared';
import { commandPayloadFingerprint, MAX_COMMAND_RESULT_BYTES, type CommandReceipt } from '../commands/receipts.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { HubRequestWork } from './async-request-work.js';
import { copyOriginalRequest, pinOriginalRequestScope } from './original-request-scope.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_EXECUTION_COMMAND_BYTES, validHubExecutionCommand, validHubExecutionCommandReply,
  type HubExecutionCommand, type HubExecutionCommandResult } from './member-execution-command-domain.js';
import type { HubExecutionEffect } from './member-execution-effect-domain.js';
import type { ExecutionEffectLocal } from './execution-effects.js';
import type { HubExecutionSync } from './execution-sync.js';
import type { NodeGrantProof } from './node-grants.js';
import type { AsyncSharedCommandPort, SharedCommandPort } from './shared-command-port.js';
import { AsyncHubSharedExecutionEffects } from './async-shared-execution-effects.js';
import { ConnectorNotDispatchedError } from './connector-connect.js';
import { decodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import { validOwnerControlReceipt } from './member-owner-control-domain.js';

type Action<C = Exclude<HubExecutionCommand, { action: 'open' }>> = C extends HubExecutionCommand ? Omit<C, 'target' | 'read'> : never;
/** Transport data is untrusted. An invalid ACK must not become an invalid
 * owner RPC and fence otherwise healthy storage. Keep the original unknown. */
function settlementReceipt(receipt: unknown): CommandReceipt | undefined {
  if (!validOwnerControlReceipt(receipt)) return undefined;
  if (receipt.result && Buffer.byteLength(JSON.stringify(receipt.result)) > MAX_COMMAND_RESULT_BYTES) return undefined;
  return receipt;
}
/** Owns full shared request chains and original mutation ACKs. SQL only in the
 * original worker. Cancelled/unknown writes fence this request, never replay. */
export class AsyncHubSharedCommands implements AsyncSharedCommandPort {
  private readonly work = new HubRequestWork(256, SHARED_MESSAGE_FLIGHT_BYTES);
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly drain: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly sync: Pick<HubExecutionSync, 'acquire'> | undefined, private readonly local?: ExecutionEffectLocal,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, timeoutMs = 30000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, 30000, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(), () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  get pendingRequests() { return this.work.pending; }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  close(): Promise<void> { void this.work.close(); return this.drain(); }
  open(request: Request, input: { ownerUserId: string; sessionId: string }): Promise<SharedCommandPort> {
    // Snapshot before the first scheduling/authority await.
    const target = Object.freeze(JSON.parse(encodeHubMemberJson(input, HUB_EXECUTION_COMMAND_BYTES)));
    const original = copyOriginalRequest(request);
    return this.work.run(async () => {
      const evidence = Object.freeze(hubMemberEvidence(original)), authority = await this.requests.begin(original);
      const scope = original.headers.get('x-agentopsdeck-recovery-scope') ?? new URL(original.url).searchParams.get('recoveryScope');
      if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
      pinOriginalRequestScope(original, authority.recoveryScope);
      pinOriginalRequestScope(request, authority.recoveryScope);
      let fenced = false;
      const execute = async (command: HubExecutionCommand): Promise<Exclude<HubExecutionCommandResult, null | { error: number }>> => {
        this.work.check();
        if (fenced) throw new HubMemberRequestError(503);
        // Capture caller-owned values before any authority/scheduling await.
        command = JSON.parse(encodeHubMemberJson(command, HUB_EXECUTION_COMMAND_BYTES));
        if (!validHubExecutionCommand(command)) throw new HubMemberRequestError(400);
        await authority.check(); this.work.check();
        if (original.signal.aborted) throw new HubMemberRequestError(499);
        const mutation = ['claim','queueClaim','settle','queueSettle'].includes(command.action);
        let result: HubExecutionCommandResult;
        try {
          const submit = () => { this.work.check(); return this.owner.command('executionCommand', { evidence, expectedScope: authority.recoveryScope, command }); };
          result = mutation ? (await this.persistence.run(89, submit)).value : (await this.reads.run(original, 89, submit)).value;
        } catch (error) {
          fenced = true;
          throw new HubMemberRequestError(!mutation && error instanceof AuthReadCancelledError ? 499 : 503);
        }
        this.work.check();
        if (!validHubExecutionCommandReply(command, result)) { fenced = true; throw new HubMemberRequestError(503); }
        if (!result) throw new HubMemberRequestError(401);
        if ('error' in result) throw new HubMemberRequestError(result.error);
        await authority.check(); this.work.check();
        if (original.signal.aborted) throw new HubMemberRequestError(499);
        return result;
      };
      const opened = await execute({ action: 'open', target });
      if (opened.action !== 'open' || opened.target.userId !== authority.principal.userId) throw new HubMemberRequestError(503);
      const readProof = Object.freeze(structuredClone(opened.read)), ref = Object.freeze(sessionRef(opened.nodeId, decodeHubSessionId(target.sessionId)!.remoteSessionKey)!);
      const run = (action: Action) => execute({ ...action, target, read: readProof } as HubExecutionCommand);
      const read = async () => { await run({ action: 'check' }); };
      const proofs = new Map<string, NodeGrantProof>();
      const permission = async (action: 'messages:send' | 'messages:mirror' | 'queue:manage') => {
        const previous = proofs.get(action), result = await run({ action: 'permission', permission: action, ...(previous ? { proof: previous } : {}) });
        if (result.action !== 'permission') throw new HubMemberRequestError(503);
        const proof = structuredClone(result.proof); proofs.set(action, proof); return proof;
      };
      const write = async (mirror: boolean) => ({ send: await permission('messages:send'), ...(mirror ? { mirror: await permission('messages:mirror') } : {}) });
      const effect = (e: HubExecutionEffect) => new AsyncHubSharedExecutionEffects(run, e);
      const lookup = async (key: string, digest?: string) => {
        const r = await run({ action: 'lookup', key, ...(digest ? { digest } : {}) });
        if (r.action !== 'lookup') throw new HubMemberRequestError(503); return r;
      };
      const historical = async (key: string) => {
        const r = await run({ action: 'historical', key });
        if (r.action !== 'historical') throw new HubMemberRequestError(503); return r.binding;
      };
      const settle = async (key: string, upstream?: CommandReceipt, notDispatched = false) => {
        // Original receipts leave unsupported/oversized upstream success unknown.
        upstream = settlementReceipt(upstream);
        const r = await run({ action: 'settle', key, receipt: upstream ?? null, notDispatched });
        if (r.action !== 'settle') throw new HubMemberRequestError(503); return r.receipt;
      };
      const recover = async (key: string) => {
        const existing = await lookup(key);
        if (!existing.receipt || existing.receipt.state !== 'outcome_unknown' || existing.authorityId === null) return existing.receipt ?? undefined;
        try {
          const b = await historical(key), upstream = await effect({ kind: 'receipt', key }).receiptFor(b.lease, b.deliveryKey, read, this.local, original.signal);
          return await settle(key, upstream);
        } catch { await read(); return existing.receipt; }
      };
      const observation = async (commandKey: string, key: string) => {
        const r = await run({ action: 'queueObserve', commandKey, key, nodeId: ref.nodeId });
        if (r.action !== 'queueObserve') throw new HubMemberRequestError(503); return r.observation;
      };
      const settleQueue = async (commandKey: string, key: string, receipt?: CommandReceipt) => {
        receipt = settlementReceipt(receipt);
        const r = await run({ action: 'queueSettle', commandKey, key, nodeId: ref.nodeId, receipt: receipt ?? null });
        if (r.action !== 'queueSettle') throw new HubMemberRequestError(503); return r.receipt;
      };
      const recoverQueue = async (commandKey: string, key: string) => {
        const o = await observation(commandKey, key);
        if (!o || o.receipt.state !== 'outcome_unknown') return o?.receipt;
        try {
          const receipt = await effect({ kind: 'queueMutation', commandKey, key, nodeId: ref.nodeId })
            .queueMutationFor(o.lease, o.deliveryKey, o.mutationDeliveryKey, undefined, read, this.local, original.signal);
          return await settleQueue(commandKey, key, receipt);
        } catch { await read(); return o.receipt; }
      };
      const port: SharedCommandPort = {
        authorizeSend: mirror => this.work.run(async () => { await read(); await write(mirror); }),
        ref, read: () => this.work.run(read), recover: key => this.work.run(() => recover(key)),
        recoverQueueMutation: (commandKey, key) => this.work.run(() => recoverQueue(commandKey, key)),
        send: (key, input, mirror) => {
          const payload = copySharedMessageInput(input, ref.runtimeId);
          const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
          if (payloadBytes > SHARED_MESSAGE_BODY_BYTES) throw new HubMemberRequestError(400);
          return this.work.run(async () => {
            if (mirror !== (payload.deliveryMode === 'mirror') || mirror && ref.runtimeId !== 'openclaw') throw new HubMemberRequestError(409);
            const digest = commandPayloadFingerprint(payload), existing = await lookup(key, digest);
            if (existing.receipt) return (await recover(key))!;
            const w = await write(mirror), issuer = await run({ action: 'issuer', write: w });
            if (issuer.action !== 'issuer' || !this.sync) throw new HubMemberRequestError(409);
            const lease = await this.sync.acquire(w.send, issuer.nodeId, issuer.issuerId, mirror ? ['messages:send','messages:mirror'] : ['messages:send']);
            const claimed = await run({ action: 'claim', key, digest, leaseId: lease.id, write: w });
            if (claimed.action !== 'claim') throw new HubMemberRequestError(503);
            if (!claimed.fresh) return (await recover(key))!;
            const b = await historical(key);
            try {
              const receipt = await effect({ kind: 'message', key, digest, write: w }).messageFor(b.lease, b.deliveryKey, payload,
                async () => { await read(); await write(mirror); }, this.local, original.signal);
              await settle(key, receipt);
            } catch (error) { if (error instanceof ConnectorNotDispatchedError) await settle(key, undefined, true); }
            return (await recover(key))!;
          }, payloadBytes);
        },
        queue: key => this.work.run(async () => {
          if (!(await lookup(key)).receipt) return undefined;
          const b = await historical(key);
          return effect({ kind: 'queue', key, nodeId: ref.nodeId }).queueFor(b.lease, b.deliveryKey, read, this.local, original.signal);
        }),
        queuePage: cursor => this.work.run(async () => {
          const s = await run({ action: 'pageSelect', nodeId: ref.nodeId, ...(cursor === undefined ? {} : { cursor }) });
          if (s.action !== 'pageSelect') throw new HubMemberRequestError(503);
          if (!s.lease) return { availability: 'available', items: [], nextCursor: null };
          try {
            const page = await effect({ kind: 'page', nodeId: ref.nodeId, ...(cursor === undefined ? {} : { cursor }) }).queuePageFor(s.lease, s.after, read, this.local, original.signal);
            const p = await run({ action: 'pageProject', nodeId: ref.nodeId, leaseId: s.lease.id, page });
            if (p.action !== 'pageProject') throw new HubMemberRequestError(503);
            return { availability: 'available', items: p.items, nextCursor: page.nextCursor === null ? s.nextActorCursor : `${s.lease.id}:${page.nextCursor}` };
          } catch { await read(); return { availability: 'unavailable', items: [], nextCursor: s.nextActorCursor }; }
        }),
        mutateQueue: (commandKey, key, input) => {
          const change = structuredClone(input);
          return this.work.run(async () => {
            if (!['PATCH','DELETE'].includes(change.method) || !/^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(change.version)
              || typeof change.text !== 'string' || change.text.length > MAX_MESSAGE_CHARS
              || (change.method === 'PATCH' ? !change.text.trim() : change.text !== '')) throw new HubMemberRequestError(409);
            // Duplicate claims compare original content, but do not reacquire send/write authority.
            const existing = await observation(commandKey, key), patch = change.method === 'PATCH';
            const w = existing ? undefined : await permission('queue:manage'), send = !existing && patch ? await permission('messages:send') : undefined;
            const c = await run({ action: 'queueClaim', commandKey, key, nodeId: ref.nodeId, digest: commandPayloadFingerprint(change), patch,
              ...(w ? { write: w } : {}), ...(send ? { send } : {}) });
            if (c.action !== 'queueClaim') throw new HubMemberRequestError(503);
            if (c.fresh) {
              const o = (await observation(commandKey, key))!;
              try {
                const receipt = await effect({ kind: 'queueMutation', commandKey, key, nodeId: ref.nodeId, change, write: w!, ...(send ? { send } : {}) })
                  .queueMutationFor(o.lease, o.deliveryKey, o.mutationDeliveryKey, change, async () => {
                    await read(); await permission('queue:manage'); if (patch) await permission('messages:send');
                  }, this.local, original.signal);
                await settleQueue(commandKey, key, receipt);
              } catch { /* Unknown network/ACK cannot justify another mutation. */ }
            }
            return (await recoverQueue(commandKey, key))!;
          });
        },
      };
      return port;
    });
  }
}

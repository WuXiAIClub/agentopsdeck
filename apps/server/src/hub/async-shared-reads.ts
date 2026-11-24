import type { SharedSessionAccessHints } from '@agentopsdeck/shared';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { HubRequestWork } from './async-request-work.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { HUB_SHARED_READ_BYTES, validHubSharedReadCommand, validHubSharedReadReply,
  type HubSharedReadCommand } from './member-shared-read-domain.js';
import type { NodeGrantProof } from './node-grants.js';
import { decodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import type { HubEventReplayPort } from './async-event-replay.js';
import { copyOriginalRequest, pinOriginalRequestScope } from './original-request-scope.js';

type Target = { ownerUserId: string; sessionId: string };
type Permission = 'media:read' | 'events:read';
export type HubSharedReadPort = {
  readonly target: Readonly<Target & { userId: string }>;
  readonly connection: Readonly<{ id: string; capabilities: readonly string[] }>;
  readonly ref: NonNullable<ReturnType<typeof sessionRef>>;
  readonly resource: NodeGrantProof['resource'] & { sessionKey: string };
  readonly readProof: NodeGrantProof;
  read(): Promise<void>;
  require(permission: Permission): Promise<NodeGrantProof>;
  hints(): Promise<SharedSessionAccessHints>;
  replay(): Promise<HubEventReplayPort>;
};
export type AsyncHubSharedReadsPort = {
  open(request: Request, target: Target): Promise<HubSharedReadPort>;
  close(): Promise<void>;
};

/** One pinned request, original identity savepoints and versioned grants. No
 * new SQL owner, network execution, credential snapshot cache or retry. */
export class AsyncHubSharedReads implements AsyncHubSharedReadsPort {
  private readonly work = new HubRequestWork();
  private readonly requests: AsyncHubMemberRequests;
  private readonly persistence: AuthRoutePersistence;
  private readonly reads: AuthRouteReadWait;
  private readonly drain: () => Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30000, timeoutMs = 30000) {
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
    this.drain = createIndependentDrain([() => this.work.close(), () => this.requests.close(), () => this.persistence.close()], 'hub-route-drain', diagnostics);
  }
  close() { void this.work.close(); return this.drain(); }
  open(request: Request, input: Target): Promise<HubSharedReadPort> {
    // Capture input before the first asynchronous boundary; reject accessors,
    // oversized values and malformed session targets before any SQL admission.
    let command: Extract<HubSharedReadCommand, { action: 'open' }>;
    try {
      command = JSON.parse(encodeHubMemberJson({ action: 'open', target: input }, HUB_SHARED_READ_BYTES));
      if (!validHubSharedReadCommand(command)) throw Error('invalid_target');
    } catch { return Promise.reject(new HubMemberRequestError(404)); }
    const original = copyOriginalRequest(request);
    return this.work.run(() => this.openOriginal(original, command, request));
  }
  private async openOriginal(original: Request, open: Extract<HubSharedReadCommand, { action: 'open' }>, source: Request): Promise<HubSharedReadPort> {
    const evidence = Object.freeze(hubMemberEvidence(original));
    const authority = await this.requests.begin(original);
    this.work.check();
    const scope = original.headers.get('x-agentopsdeck-recovery-scope') ?? new URL(original.url).searchParams.get('recoveryScope');
    if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
    pinOriginalRequestScope(original, authority.recoveryScope);
    pinOriginalRequestScope(source, authority.recoveryScope);
    const target = Object.freeze({ ...open.target });
    let failed = false;
    let rejection: HubMemberRequestError | undefined;
    const check = async () => {
      this.work.check();
      if (failed) throw rejection ?? new HubMemberRequestError(503);
      await authority.check(); this.work.check();
    };
    const read = async (input: HubSharedReadCommand) => {
      await check();
      let command: HubSharedReadCommand;
      try {
        command = JSON.parse(encodeHubMemberJson(input, HUB_SHARED_READ_BYTES));
        if (!validHubSharedReadCommand(command)) throw Error('invalid');
      } catch { throw new HubMemberRequestError(400); }
      try {
        const result = await this.reads.run(original, 94, () => {
          this.work.check();
          return this.owner.command('sharedRead', { evidence, expectedScope: authority.recoveryScope, command });
        });
        this.work.check();
        if (!validHubSharedReadReply(command, result.value)) throw Error('invalid_ack');
        if (result.value === null) throw new HubMemberRequestError(401);
        const data = result.value.data;
        if ('error' in data) throw new HubMemberRequestError(data.error);
        await check();
        return data;
      } catch (error) {
        failed = true;
        // Keep the first bounded refusal for later delivery fences. A known
        // revocation must not become a retryable availability error, and an
        // unknown ACK must remain unavailable without another owner command.
        rejection ??= error instanceof HubMemberRequestError ? error
          : new HubMemberRequestError(error instanceof AuthReadCancelledError ? 499 : 503);
        throw rejection;
      }
    };
    const first = await read(open);
    if (first.action !== 'open' || first.userId !== authority.principal.userId) throw new HubMemberRequestError(503);
    const decoded = decodeHubSessionId(target.sessionId)!;
    const ref = Object.freeze(sessionRef(first.nodeId, decoded.remoteSessionKey)!);
    const readProof = Object.freeze({ ...first.read, resource: Object.freeze({ ...first.read.resource }) });
    const proofs = new Map<Permission, NodeGrantProof>();
    const requirePermission = async (permission: Permission) => {
      // Publish the first permission proof once, even if two consumers open
      // concurrently. A replacement grant cannot overwrite the pinned proof.
      const prior = proofs.get(permission);
      const data = await read({ action: 'permission', target, read: readProof, permission, ...(prior ? { proof: prior } : {}) });
      if (data.action !== 'permission') throw new HubMemberRequestError(503);
      const pinned = proofs.get(permission);
      if (pinned && JSON.stringify(pinned) !== JSON.stringify(data.proof)) {
        failed = true; throw new HubMemberRequestError(403);
      }
      const proof = Object.freeze({ ...data.proof, resource: Object.freeze({ ...data.proof.resource }) });
      proofs.set(permission, proof);
      return proof;
    };
    return Object.freeze({ target: Object.freeze({ ...target, userId: first.userId }),
      connection: Object.freeze({ id: decoded.connectionId, capabilities: Object.freeze(first.events ? ['events'] : []) }),
      ref, resource: Object.freeze({ ...readProof.resource, sessionKey: decoded.remoteSessionKey }), readProof,
      read: () => this.work.run(async () => { await read({ action: 'check', target, read: readProof }); }),
      require: (permission: Permission) => this.work.run(() => requirePermission(permission)),
      hints: () => this.work.run(async () => {
        const data = await read({ action: 'hints', target, read: readProof });
        if (data.action !== 'hints') throw new HubMemberRequestError(503);
        return data.hints;
      }),
      replay: () => this.work.run(async (): Promise<HubEventReplayPort> => {
        const events = await requirePermission('events:read');
        if (!first.events) throw new HubMemberRequestError(503);
        const initial = await read({ action: 'cursor', target, read: readProof, events });
        if (initial.action !== 'cursor') throw new HubMemberRequestError(503);
        return Object.freeze({ ownerUserId: target.ownerUserId, initialCursor: initial.cursor ?? undefined,
          check: () => this.work.run(async () => { await requirePermission('events:read'); }),
          page: (cursor: string | undefined, domains: Map<string, string>) => this.work.run(async () => {
            if (domains.size > 1 || [...domains.keys()].some(id => id !== decoded.connectionId)) throw new HubMemberRequestError(400);
            const data = await read({ action: 'page', target, read: readProof, events,
              cursor: cursor ?? null, domain: domains.get(decoded.connectionId) ?? null });
            if (data.action !== 'page' || data.page.events.some(e => e.sessionRef && (e.sessionRef.nodeId !== ref.nodeId
              || e.sessionRef.runtimeId !== ref.runtimeId || e.sessionRef.nativeSessionKey !== ref.nativeSessionKey))) {
              failed = true; throw new HubMemberRequestError(503);
            }
            return { ...data.page, cursor: data.page.cursor ?? undefined };
          }),
          // Shared streams never expose owner workspace metadata. The shared
          // route always supplies connectionId + project, so this is unused.
          revisions: async () => { throw new HubMemberRequestError(403); },
        });
      }),
    });
  }
}

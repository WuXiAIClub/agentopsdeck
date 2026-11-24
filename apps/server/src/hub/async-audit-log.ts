import { types } from 'node:util';
import { AuthRoutePersistence, type AuthRouteAuditStore } from '../auth/route-persistence.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests } from './async-member-request.js';
import { validHubAuditRecord, copyHubAuditOptions, type HubAuditAppend, type HubAuditOptions } from './member-audit-domain.js';

/** Drop optional undefined fields just as the original JSON audit storage
 * does, without invoking caller getters, toJSON, proxies or functions. */
function auditSnapshot(record: HubAuditAppend): HubAuditAppend {
  if (!record || typeof record !== 'object' || types.isProxy(record)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) throw new AuthPersistenceError();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') throw new AuthPersistenceError();
    const field = Object.getOwnPropertyDescriptor(record, key)!;
    if (!field.enumerable || !Object.hasOwn(field, 'value')) throw new AuthPersistenceError();
    if (field.value !== undefined) copy[key] = field.value;
  }
  if (!validHubAuditRecord(copy)) throw new AuthPersistenceError();
  return copy as HubAuditAppend;
}
/** Awaited audit port on the original Hub owner, never the independent
 * passkey/auth writer. Trusted route-generated
 * unauthenticated login failures may append, but query requests must provide
 * original credentials; permission is rechecked inside the pruning savepoint.
 * No callback, authorized boolean, cancellation, automatic retry or replay. */
export class AsyncHubAuditLog implements AuthRouteAuditStore {
  private readonly persistence: AuthRoutePersistence;
  private readonly requests: AsyncHubMemberRequests;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.requests = new AsyncHubMemberRequests(owner, diagnostics, warningMs, timeoutMs);
  }
  private closed = false;
  private closing?: Promise<void>;
  /** Fence the entire facade before either child emits diagnostics. Never
   * close the shared owner here: other facades may still be draining it. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    let complete!: () => void;
    this.closing = new Promise<void>(resolve => { complete = resolve; });
    void Promise.all([this.persistence.close(), this.requests.close()]).then(() => complete());
    return this.closing;
  }
  get pending() { return this.persistence.pending + this.requests.pendingReads; }
  readonly append = async (record: HubAuditAppend) => {
    if (this.closed) return this.persistence.refuse(14);
    return (await this.persistence.run(14, () => this.owner.command('auditAppend', { record: auditSnapshot(record) }))).value;
  };
  readonly page = async (options: HubAuditOptions = {}, request?: Request) => {
    if (this.closed || !request) return this.persistence.refuse(15);
    const copied = copyHubAuditOptions(options);
    return (await this.requests.begin(request)).auditPage(copied);
  };
  readonly list = async (limit = 100, request?: Request) => {
    if (this.closed || !request) return this.persistence.refuse(16);
    return (await this.requests.begin(request)).auditList(limit);
  };
}

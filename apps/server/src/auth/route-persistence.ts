import type { PasskeyManager, PasskeySessionBinding } from './passkeys.js';
import type { SqlitePasskeys } from './sqlite-passkeys.js';
import { AuthPersistenceError } from './private-store.js';
import type { AuthAuditLog, LoginAttemptLimiter } from './security.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export type Awaitable<T> = T | PromiseLike<T>;
type PasskeyBackend = PasskeyManager | SqlitePasskeys;
type AwaitedCurrent<T> = T extends { isCurrent(): boolean }
  ? Omit<T, 'isCurrent' | 'deliveryExpiresAt'> & { isCurrent(): Awaitable<boolean> } : T;
/** Trusted domain-native authority, not a browser evidence DTO or cached
 * boolean. Async owners must implement the final mutation checks themselves;
 * an awaited permission result cannot replace an original SQL transaction. */
export type AuthRouteAuthority = {
  readonly keyIdentityHash: string | undefined;
  authorize(request: Request): Awaitable<boolean>;
  revoke(request: Request, key: string | undefined, credentialHash: string): Awaitable<boolean>;
  verifyRegistration(request: Request, response: Parameters<PasskeyBackend['verifyRegistration']>[1],
    metadata: { keyIdentityHash?: string; label?: string }): ReturnType<PasskeyBackend['verifyRegistration']>;
  sessionCurrent(token: string): Awaitable<boolean>;
};
/** Awaitable persistence port, not an asynchronous authorization port. The
 * verification implementation still owns its original atomic permission and
 * challenge/counter/session checks. Never replace them with a cached grant. */
export type AuthPasskeyStore = Pick<PasskeyBackend, 'registrationOptions' | 'verifyRegistration'
  | 'authenticationOptions'> & {
  verifyAuthentication(request: Request, response: Parameters<PasskeyBackend['verifyAuthentication']>[1], key?: string):
    Promise<AwaitedCurrent<Awaited<ReturnType<PasskeyBackend['verifyAuthentication']>>>>;
  status(key?: string): Awaitable<ReturnType<PasskeyBackend['status']>>;
  list(key?: string): Awaitable<ReturnType<PasskeyBackend['list']>>;
  // The original owner must check this read-only guard immediately before
  // mutation, without an intervening await. A worker needs a domain-native
  // authorization command; it cannot serialize this callback.
  revoke(key: string | undefined, id: string, at: number | undefined, isAuthorized: () => boolean): Awaitable<boolean>;
};
export type AuthRouteSessionStore = {
  add(token: string, binding?: PasskeySessionBinding): unknown;
  delete(token: string): Awaitable<boolean>;
  // Preserve the original Set/SQLite membership lookup, not a copied token
  // cache. Request-aware worker authority remains authoritative when present.
  has?(token: string): Awaitable<boolean>;
};
/** Original Hub-owned audit domain. The HTTP port may await it, but must not
 * open another connection or move it into the independent auth writer.
 * page/list also prune persistent rows: they are not cancellable pure reads. */
export type AuthRouteAuditStore = {
  append: (...args: Parameters<AuthAuditLog['append']>) => Awaitable<ReturnType<AuthAuditLog['append']>>;
  // Additive second argument. Existing synchronous audit implementations and
  // 2.3.7 HTTP shapes remain unchanged; a worker cannot serialize a callback.
  page(options?: Parameters<AuthAuditLog['page']>[0], request?: Request): Awaitable<ReturnType<AuthAuditLog['page']>>;
  list(limit?: number, request?: Request): Awaitable<ReturnType<AuthAuditLog['list']>>;
};
/** The limiter belongs to its ORIGINAL policy/storage owner. Awaiting this
 * port cannot replace persistent failure buckets with process-local ones or
 * move the Hub's shared limiter into a second database connection. */
export type AuthRouteLoginLimiter = {
  [K in 'check' | 'recordFailure' | 'recordSuccess']: (...args: Parameters<LoginAttemptLimiter[K]>) => Awaitable<ReturnType<LoginAttemptLimiter[K]>>;
};
/** Fixed observation phases: status/list/revoke/session-add/session-delete/
 * authorization/final-session-check/member-login/member-identity/audit-identity/
 * member-revoke/recovery-scope/final-member-session-check/audit-append/
 * audit-page/audit-list/limiter-check/limiter-failure/limiter-success/
 * workspace-read/workspace-save/layout-read/layout-save (20–23),
 * member-key-issue/member-key-revoke (24–25), completion-summary/observe/read (26–28),
 * session-preference-set (29), member-activity (30), connection-snapshot (31), user-change (32),
 * connection-target (33), connection-change (34), hub-role-read (35), hub-role-set (36), access-directory (37),
 * membership-read/authorize (38), membership-set (39), grant-read (40), grant-change (41),
 * recipient-grants with administrator-maintenance writes (42, never read-timeout eligible),
 * creation-environment discovery (43, read-only, not execution admission),
 * session-collaborator list/authorize/check (44, original administrator maintenance; never read-timeout eligible),
 * session-sharing create/update/delete (45, original mutation settlement, never timeout/replay eligible),
 * owned-session sharing (46, original identity/node/role/CAS boundary, never timeout/replay eligible).
 * guidance-mutation (47, never timeout/replay eligible), guidance-read (48).
 * connector-access (63, request-bound identity/grant/epoch read, never token logged;
 * owner observation 52–62 is reserved for execution-lease actions).
 * owner-controls (64, original receipt read/claim/settle and deletion projection;
 * only reads have an HTTP deadline; mutation acknowledgments never timeout/replay).
 * private-board read (65) and CAS/receipt save (66, never timeout/replay eligible),
 * board-capability read (67) and issue/revoke (68, never timeout/replay eligible).
 * board-machine proof/read (69) and update (70, never timeout/replay eligible),
 * personal-notebook read (71) and save/move (72, never timeout/replay eligible),
 * shared-directory grant maintenance/projection (74, original ACK only;
 * 73 remains reserved for lifecycle drain), visual reads (75) and visual
 * CAS/receipt saves (76, original ACK only, never timeout/replay eligible),
 * declarative configuration read/save (77/78, original write ACK only),
 * native file-card projection read (79), local report save (80, original
 * write ACK only; no cancellation, deadline or automatic replay).
 * Binding metadata read (81) never admits reconciliation, write or resend.
 * Execution lease actions (52–62) and issuer open/check (87/88) also use the
 * original owner port; none are HTTP-deadline or automatic-replay eligible.
 * Background event-feed commands (93) retain original SQL through drain;
 * they are not HTTP read-deadline or automatic-replay eligible.
 * Content document commands (102) retain original migration/write/recovery ACKs.
 * Native file commands (103) retain original admission/settlement ACKs; a
 * browser abort never grants permission to replay the associated file effect.
 * Batch delegation commands (101) retain original root commit/ACK ownership;
 * no HTTP timeout or automatic replay may release their SQL ownership.
 * These are attempts, not proof that SQL ran or committed. */
// Weixin management (105), background (106), and storage maintenance (107)
// retain original SQL ACKs.
type StorageMaintenanceStep = 107 | 108 | 109; // Notebook machine and task-session original SQL ACKs.
// Account lifecycle reads (110) have bounded HTTP waits; writes remain at 32.
export type AuthPersistenceStep = 110 | 106 | 105 | 104 | 103 | 102 | 101 | 100 | 99 | 97 | 98 | 96 | 95 | 94 | 93 | 92 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53 | 54 | 55 | 56 | 57 | 58 | 59 | 60 | 61 | 62 | 63 | 64 | 65 | 66 | 67 | 68 | 69 | 70 | 71 | 72 | 74 | 75 | 76 | 77 | 78 | 79 | 80 | 81 | 82 | 83 | 84 | 85 | 86 | 87 | 88 | 89 | 90 | 91;

/** Bound outstanding route persistence before invoking its original owner.
 * Pending warnings are observation only. No deadline can cancel the owner,
 * release its slot, reconnect, resend, or publish a session cookie. This port
 * does not itself move the current synchronous SQL implementation off-thread. */
export class AuthRoutePersistence {
  private accepted = 0;
  private closed = false;
  private readonly originals = new Set<Promise<void>>();
  private closing?: Promise<void>;
  constructor(private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly warningMs = 30_000) {
    if (!Number.isSafeInteger(warningMs) || warningMs < 1 || warningMs > 2_147_483_647) throw new AuthPersistenceError();
  }
  get pending() { return this.accepted; }
  private observe(action: () => void) {
    try { action(); } catch { /* Logs cannot dispatch, settle, replay or deny original work. */ }
  }
  /** Freeze before observation and await ORIGINAL settlement, not HTTP read
   * deadlines. Step 73 is lifecycle drain, never a persistence command/ACK. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    let complete!: () => void;
    this.closing = new Promise<void>(resolve => { complete = resolve; });
    const originals = [...this.originals];
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    this.observe(() => { trace = this.diagnostics.start('auth-route-persistence'); });
    this.observe(() => { trace?.add('step', 73); trace?.add('pending', originals.length); });
    const warning = setTimeout(() => this.observe(() => {
      trace?.reportPending({ pending: this.pending, step: 73 });
    }), this.warningMs);
    warning.unref();
    void Promise.all(originals).then(() => {
      clearTimeout(warning);
      this.observe(() => { trace?.add('settled', 1); trace?.finish(false); });
      complete();
    });
    return this.closing;
  }
  /** Missing domain proof is a PRE-DISPATCH refusal, not an unknown mutation. */
  refuse(step: AuthPersistenceStep | StorageMaintenanceStep): never {
    this.observe(() => {
      const trace = this.diagnostics.start('auth-route-persistence');
      trace.add('step', step); trace.add('deferred', 1); trace.finish(true);
    });
    throw new AuthPersistenceError();
  }
  async run<T>(step: AuthPersistenceStep | StorageMaintenanceStep, work: () => Awaitable<T>): Promise<{ value: T }> {
    // Reserve before observation: its clock may synchronously reenter this owner.
    const pending = this.accepted, admitted = !this.closed && pending < 256;
    let complete: (() => void) | undefined, original: Promise<void> | undefined;
    if (admitted) {
      this.accepted++;
      original = new Promise<void>(resolve => { complete = resolve; });
      this.originals.add(original);
    }
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    this.observe(() => { trace = this.diagnostics.start('auth-route-persistence'); });
    this.observe(() => { trace?.add('step', step); trace?.add('pending', pending); });
    if (!admitted) {
      this.observe(() => { trace?.add('deferred', 1); trace?.finish(true); });
      throw new AuthPersistenceError();
    }
    this.observe(() => { trace?.add('admitted', 1); });
    const warning = setTimeout(() => this.observe(() => { trace?.reportPending({ pending: 1, step }); }), this.warningMs);
    warning.unref();
    let failed = true, dispatched = false;
    try {
      // A diagnostic callback may synchronously initiate shutdown after the
      // reservation. That reservation must drain, but must not dispatch work.
      if (this.closed) {
        this.observe(() => { trace?.add('deferred', 1); });
        throw new AuthPersistenceError();
      }
      dispatched = true;
      const value = await work();
      failed = false;
      this.observe(() => { trace?.add('settled', 1); });
      // Box results: returning an arbitrary object directly from an async
      // function would inspect its `then` a second time, outside this catch.
      return { value };
    } catch {
      // An owner's rejection can follow a commit or a lost ACK. Preserve the
      // unknown outcome without inspecting/coercing arbitrary error objects.
      if (dispatched) this.observe(() => { trace?.add('unknown', 1); });
      throw new AuthPersistenceError();
    } finally {
      clearTimeout(warning); this.accepted--;
      this.observe(() => { trace?.finish(failed); });
      this.originals.delete(original!); complete!();
    }
  }
}

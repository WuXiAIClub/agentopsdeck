import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { originalRequestScope } from './original-request-scope.js';
import { copyHubMemberFingerprint, hubMemberEvidence, type HubMemberSnapshot, type HubMemberCommands } from './member-owner-domain.js';
import { copyHubAuditOptions, type HubAuditOptions } from './member-audit-domain.js';
import { prepareHubUserLabel, validHubUserChange, type HubUserChange } from './member-user-domain.js';
import { validHubUserAccess, validHubUserAccessCommand, type HubUserAccessCommand, type HubUserAccess } from './user-access.js';
import { encodeHubMemberJson } from './async-member-owner.js';
import { validStorageMaintenanceResult, type StorageMaintenanceAction } from './member-storage-maintenance-domain.js';
import { HUB_CONNECTION_CHANGE_BYTES, validHubConnectionChange, copyHubConnectionConfiguration,
  validHubConnectionReply, hubConnectionReplyExpectation, type HubConnectionChange,
  type HubConnectionCreate, type HubConnectionPatch } from './member-connection-change-domain.js';

export class HubMemberRequestError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 499 | 503) { super('hub_member_request_unavailable'); }
}
type Snapshot = NonNullable<HubMemberSnapshot>;
type KeyInput = HubMemberCommands['memberKeyIssue']['input'];

/** Candidate caller boundary, not runtime activation. All requests share one
 * read-wait admission budget. Wait deadlines do not settle the original owner.
 * Mutation ACKs have no artificial deadline and are never retried. The worker
 * rechecks original credentials and scope in the same savepoint as the effect;
 * fresh response proof cannot undo a completed self-revocation. */
export class AsyncHubMemberRequests {
  private readonly persistence: AuthRoutePersistence;
  private closed = false;
  private readonly reads: AuthRouteReadWait;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000, timeoutMs = 30_000) {
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
    this.reads = new AuthRouteReadWait(this.persistence, diagnostics, timeoutMs);
  }
  get pendingReads() { return this.persistence.pending; }
  /** Freeze new and retained request closures; drain original SQL, not HTTP waits. */
  close(): Promise<void> { this.closed = true; return this.persistence.close(); }

  async begin(request: Request) {
    // Capture original request credentials once. Later header changes cannot
    // change the pinned account, nor can a caller provide an authority boolean.
    const evidence = Object.freeze(hubMemberEvidence(request));
    let rejected: HubMemberRequestError | undefined;
    const deny = (status: 400 | 401 | 403 | 404 | 409 | 499 | 503): never => {
      rejected ??= new HubMemberRequestError(status);
      throw rejected;
    };
    const snapshot = async (): Promise<Snapshot> => {
      if (this.closed) return deny(503);
      if (rejected) throw rejected;
      try {
        const result = await this.reads.run(request, 6, () => this.owner.command('memberSnapshot', evidence));
        if (this.closed) return deny(503);
        if (!result.value) return deny(401);
        return result.value;
      } catch (error) {
        if (error === rejected) throw error;
        return deny(error instanceof AuthReadCancelledError ? 499 : 503);
      }
    };
    const originalScope = originalRequestScope(request);
    const initial = await snapshot();
    if (originalScope !== undefined && initial.recoveryScope !== originalScope) return deny(401);
    // Defensive copying prevents response consumers changing our internal pin.
    const principal = Object.freeze({ ...initial.principal });
    const expectedScope = initial.recoveryScope;
    const check = async () => {
      const current = await snapshot();
      if (current.recoveryScope !== expectedScope || current.principal.userId !== principal.userId
        || current.principal.admin !== principal.admin) return deny(401);
    };
    const administrator = async () => {
      await check();
      if (!principal.admin) return deny(403);
    };
    const proof = (userId: string) => ({ evidence, expectedScope, userId });
    const mutation = async <T>(work: () => Promise<T | null>): Promise<T> => {
      await administrator();
      let value: T | null;
      try { value = await work(); }
      catch { return deny(503); } // Unknown effect: no replay, no owner replacement.
      if (value === null) return deny(401);
      await check(); // A committed effect is never rolled back on final denial.
      return value;
    };
    const changeUser = (label: string, userId?: string) => {
      let change: HubUserChange;
      try {
        // Primitive strings only; original normalization occurs before IO.
        // One lookahead preserves the store's exact legacy 120-char slicing.
        change = userId === undefined ? { action: 'create', label: prepareHubUserLabel(label) }
          : { action: 'update', userId, label: prepareHubUserLabel(label) };
        if (!validHubUserChange(change)) throw new Error('invalid_user_change');
      } catch { return Promise.reject(new HubMemberRequestError(400)); }
      return mutation(async () => (await this.persistence.run(32,
        () => this.owner.command('userChange', { evidence, expectedScope, change }))).value)
        .then(value => { if ('error' in value) throw new HubMemberRequestError(404);
          if (!('user' in value)) return deny(503); return value.user; });
    };
    const userAccess = async (command: HubUserAccessCommand): Promise<HubUserAccess> => {
      // Snapshot primitive fields before authority or IO. This is a target/CAS,
      // never an administrator flag transported from the client.
      const change: HubUserAccessCommand = command.action === 'accessRead'
        ? { action: 'accessRead', userId: command.userId }
        : { action: 'accessChange', userId: command.userId, status: command.status, expectedVersion: command.expectedVersion };
      if (!validHubUserAccessCommand(change)) throw new HubMemberRequestError(400);
      const input = { evidence, expectedScope, change };
      let value: HubMemberCommands['userChange']['output'];
      if (change.action === 'accessChange') value = await mutation(async () =>
        (await this.persistence.run(32, () => this.owner.command('userChange', input))).value);
      else {
        await administrator();
        try { value = (await this.reads.run(request, 110, () => this.owner.command('userChange', input))).value; }
        catch (error) { return deny(error instanceof AuthReadCancelledError ? 499 : 503); }
        if (value === null) return deny(401);
        await check();
      }
      if ('error' in value) throw new HubMemberRequestError(value.error === 'missing' ? 404 : value.error === 'conflict' ? 409 : 403);
      if (!('access' in value) || !validHubUserAccess(value.access) || value.access.userId !== change.userId
        || change.action === 'accessChange' && (value.access.status !== change.status
          || ![change.expectedVersion, change.expectedVersion + 1].includes(value.access.version))) return deny(503);
      return Object.freeze({ ...value.access });
    };
    const target = async (id: string) => {
      if (typeof id !== 'string') throw new HubMemberRequestError(400);
      await check();
      try {
        const { value } = await this.reads.run(request, 33, () => this.owner.command('connectionTarget', { evidence, expectedScope, id }));
        if (value === null) return deny(401);
        await check();
        if ('error' in value) throw new HubMemberRequestError(404);
        if (value.connection.ownerUserId !== principal.userId || value.connection.id !== id) return deny(503);
        return value;
      } catch (error) {
        if (error === rejected || error instanceof HubMemberRequestError) throw error;
        return deny(error instanceof AuthReadCancelledError ? 499 : 503);
      }
    };
    const changeConnection = async (input: HubConnectionChange) => {
      // Own immutable primitive/array data before any permission await. No
      // getter, proxy, toJSON, callback or consumer edit can retarget the work.
      let change: HubConnectionChange;
      try {
        if (input.action === 'create' || input.action === 'patch') input = { ...input, configuration: copyHubConnectionConfiguration(input.configuration) } as HubConnectionChange;
        change = JSON.parse(encodeHubMemberJson(input, HUB_CONNECTION_CHANGE_BYTES));
        if (!validHubConnectionChange(change)) throw new Error('invalid_connection_change');
      } catch { throw new HubMemberRequestError(400); }
      await check(); // Member-owned connection policy, not administrator().
      if (request.signal.aborted) return deny(499);
      let value: HubMemberCommands['connectionChange']['output'];
      try { value = (await this.persistence.run(34, () => this.owner.command('connectionChange', { evidence, expectedScope, change }))).value; }
      catch { await check(); return deny(503); } // Unknown effect. Never retry.
      if (value === null) return deny(401);
      await check();
      if (!validHubConnectionReply(hubConnectionReplyExpectation(change), value)) return deny(503);
      if (change.action === 'pin' && 'connection' in value && value.connection.nodeId !== change.nodeId) return deny(503);
      if ('error' in value) throw new HubMemberRequestError(value.error === 'missing' ? 404 : 409);
      if (change.action === 'delete') return value;
      const id = 'connection' in value ? value.connection.id : change.action === 'create' ? undefined : change.id;
      if (!id || !('epoch' in value) || value.epoch === undefined) return deny(503);
      const latest = await target(id);
      if (latest.epoch !== value.epoch) throw new HubMemberRequestError(409);
      return value; // Final proof cannot undo or replay the original effect.
    };
    return Object.freeze({
      principal, recoveryScope: expectedScope, check,
      storage: async <K extends StorageMaintenanceAction>(action: K) => {
        await administrator();
        const result = await this.persistence.run(107, () => this.owner.command('storageMaintenance', {
          evidence, expectedScope, command: { action },
        }));
        const value = result.value;
        if (!validStorageMaintenanceResult(value)) return deny(503);
        if ('error' in value) return deny(value.error);
        if (value.action !== action) return deny(503);
        await check();
        return value.value as Extract<HubMemberCommands['storageMaintenance']['output'], { action: K }>['value'];
      },
      createConnection: (configuration: HubConnectionCreate) => changeConnection({ action: 'create', configuration }),
      connection: async (id: string) => {
        const pinned = await target(id), expectedEpoch = pinned.epoch;
        return Object.freeze({ connection: pinned.connection, epoch: expectedEpoch,
          patch: (configuration: HubConnectionPatch) => changeConnection({ action: 'patch', id, expectedEpoch, configuration }),
          maintenance: (token: string) => changeConnection({ action: 'maintenance', id, expectedEpoch, token }),
          pin: (nodeId: string) => changeConnection({ action: 'pin', id, expectedEpoch, nodeId }),
          delete: () => changeConnection({ action: 'delete', id, expectedEpoch }),
          check: async () => { const latest = await target(id); if (latest.epoch !== expectedEpoch) throw new HubMemberRequestError(409); },
        });
      },
      createUser: (label: string) => changeUser(label),
      updateUser: (userId: string, label: string) => typeof userId === 'string'
        ? changeUser(label, userId) : Promise.reject(new HubMemberRequestError(400)),
      getUserAccess: (userId: string) => userAccess({ action: 'accessRead', userId }),
      setUserAccess: (userId: string, status: HubUserAccess['status'], expectedVersion: number) =>
        userAccess({ action: 'accessChange', userId, status, expectedVersion }),
      sessionState: async () => {
        await check();
        const read = async (command: HubMemberCommands['sessionStateSnapshot']['input']['command']) => {
          // An earlier refusal retires this request closure. Do not admit a
          // second owner read through an already retained final-check handle.
          if (rejected) throw rejected;
          if (this.closed) return deny(503);
          try {
            const { value } = await this.reads.run(request, command.action === 'read' ? 84 : 85,
              () => this.owner.command(command.action === 'read' ? 'sessionStateSnapshot' : 'sessionStateCheck', { evidence, expectedScope, command }));
            if (value === null) return deny(401);
            // Final check includes current credentials/scope AND both SQL
            // generations in one savepoint. Do not insert another unrelated
            // observation wait after that atomic proof.
            if (command.action === 'read') await check();
            else if (this.closed) return deny(503);
            return value;
          } catch (error) {
            if (error === rejected) throw error;
            return deny(error instanceof AuthReadCancelledError ? 499 : 503);
          }
        };
        const value = await read({ action: 'read' });
        if (value.action !== 'read' || value.directory.snapshot.principal.userId !== principal.userId
          || value.directory.snapshot.principal.admin !== principal.admin) return deny(503);
        const directoryVersion = value.directory.version, preferenceVersion = value.preferenceVersion;
        const epochs = new Map(value.directory.snapshot.connections.map((row, index) => [row.id, value.directory.epochs[index]!]));
        return Object.freeze({ connections: value.directory.snapshot.connections, users: value.directory.snapshot.users,
          preferences: new Map(value.preferences), authority: (id: string) => epochs.get(id),
          check: async () => {
            const result = await read({ action: 'check', directoryVersion, preferenceVersion });
            if (result.action !== 'check' || result.directoryVersion !== directoryVersion
              || result.preferenceVersion !== preferenceVersion || !result.ok) return deny(503);
          },
        });
      },
      connectionDirectory: async () => {
        await check();
        const read = async (command: Exclude<HubMemberCommands['connectionDirectory']['input']['command'], { action: 'version' }>) => {
          try {
            const execute = async () => {
              if (rejected) throw rejected;
              if (this.closed) return deny(503);
              const { value } = await this.reads.run(request, command.action === 'read' ? 82 : 83,
                () => this.owner.command(command.action === 'read' ? 'connectionDirectory' : 'connectionDirectoryCheck', { evidence, expectedScope, command }));
              if (this.closed) return deny(503);
              if (value === null) return deny(401);
              return value;
            };
            const value = await execute();
            if (command.action === 'read') { await check(); return value; }
            if (value.action !== 'check' || value.version !== command.version || !value.ok
              || value.target?.id !== command.target?.id || value.target?.epoch !== command.target?.epoch) return deny(503);
            // Retain the post-ACK delivery gate, but recheck the directory and
            // identity together. An unrelated memberSnapshot here allowed an
            // epoch change during that wait to pass a split final proof.
            // No identity/SQL await is inserted after the last atomic proof.
            return await execute();
          } catch (error) {
            if (error === rejected) throw error;
            return deny(error instanceof AuthReadCancelledError ? 499 : 503);
          }
        };
        const value = await read({ action: 'read' });
        if (value.action !== 'read' || value.snapshot.principal.userId !== principal.userId
          || value.snapshot.principal.admin !== principal.admin) return deny(503);
        const expectedVersion = value.version;
        const epochs = new Map(value.snapshot.connections.map((connection, index) => [connection.id, value.epochs[index]!]));
        return Object.freeze({ connections: value.snapshot.connections, users: value.snapshot.users,
          check: async (id?: string) => {
            await check();
            if (id !== undefined && !epochs.has(id)) return deny(503);
            const target = id === undefined ? undefined : { id, epoch: epochs.get(id)! };
            const result = await read({ action: 'check', version: expectedVersion, ...(target ? { target } : {}) });
            if (result.action !== 'check' || result.version !== expectedVersion || !result.ok
              || result.target?.id !== target?.id || result.target?.epoch !== target?.epoch) return deny(503);
          },
        });
      },
      users: async () => {
        await check();
        try {
          const { value } = await this.reads.run(request, 86,
            () => this.owner.command('userDirectory', { evidence, expectedScope }));
          if (value === null || value.principal.userId !== principal.userId || value.principal.admin !== principal.admin) return deny(401);
          await check();
          return value;
        } catch (error) {
          if (error === rejected) throw error;
          return deny(error instanceof AuthReadCancelledError ? 499 : 503);
        }
      },
      connections: async () => {
        await check();
        try {
          const { value } = await this.reads.run(request, 31, () => this.owner.command('connectionSnapshot', { evidence, expectedScope }));
          if (value === null || value.principal.userId !== principal.userId || value.principal.admin !== principal.admin) return deny(401);
          await check(); // Display snapshot never substitutes for fresh delivery authority.
          return value;
        } catch (error) {
          if (error === rejected) throw error;
          return deny(error instanceof AuthReadCancelledError ? 499 : 503);
        }
      },
      // page/list prune in the original SQL domain. Their wait has no read
      // deadline; cancellation affects only fresh delivery proof afterwards.
      auditPage: (options: HubAuditOptions = {}) => {
        // Capture before mutation() awaits permission, not after it.
        let copied: HubAuditOptions;
        try { copied = copyHubAuditOptions(options); } catch { return Promise.reject(new HubMemberRequestError(503)); }
        return mutation(async () =>
          (await this.persistence.run(15, () => this.owner.command('auditPage', { evidence, expectedScope, options: copied }))).value);
      },
      auditList: (limit = 100) => mutation(async () =>
        (await this.persistence.run(16, () => this.owner.command('auditList', { evidence, expectedScope, limit }))).value),
      keys: async (userId: string) => {
        await administrator();
        try {
          const { value } = await this.reads.run(request, 2, () => this.owner.command('memberKeysRead', proof(userId)));
          if (value === null) return deny(401);
          await check();
          return value;
        } catch (error) {
          if (error === rejected) throw error;
          return deny(error instanceof AuthReadCancelledError ? 499 : 503);
        }
      },
      issue: async (userId: string, fingerprint?: KeyInput['fingerprint']) => {
        let copied: KeyInput['fingerprint'];
        try { copied = copyHubMemberFingerprint(fingerprint); } catch { throw new HubMemberRequestError(400); }
        const value = await mutation(async () => (await this.persistence.run(24, () => this.owner.command('memberKeyIssue', {
          ...proof(userId), ...(copied === undefined ? {} : { fingerprint: copied }),
        }))).value);
        if ('error' in value) throw new HubMemberRequestError(value.error === 'configuration_required' ? 409 : 400);
        return value;
      },
      revoke: (userId: string, keyId: string, fingerprint?: KeyInput['fingerprint']) => {
        let copied: KeyInput['fingerprint'];
        try { copied = copyHubMemberFingerprint(fingerprint); }
        catch { return Promise.reject(new HubMemberRequestError(400)); }
        // Original HTTP deletion treats an unknown/noncanonical key ID as a
        // successful no-op. Keep that public contract without weakening the
        // fixed worker schema. Even a no-op must prove fresh administration
        // and scope on both sides; it must not bypass closure or revocation.
        if (typeof keyId === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(keyId))
          return mutation(async () => ({ ok: false }));
        return mutation(async () => (await this.persistence.run(25, () => this.owner.command('memberKeyRevoke', {
          ...proof(userId), keyId, ...(copied === undefined ? {} : { fingerprint: copied }),
        }))).value);
      },
    });
  }
}

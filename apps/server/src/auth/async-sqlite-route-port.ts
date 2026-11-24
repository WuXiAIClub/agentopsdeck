import { AuthPersistenceError } from './private-store.js';
import { relyingParty } from './passkeys.js';
import { sqliteAuthEvidenceFromRequest, type SqliteAuthCommands, type SqliteAuthKind } from './sqlite-owner-domain.js';
import type { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import type { AuthKeyDeliveryFence } from './current-key-binding.js';
import type { AuthPasskeyStore, AuthRouteAuthority, AuthRouteSessionStore } from './route-persistence.js';
import { originalJsonEvidenceFromRequest, type OriginalJsonRouteCapability, type OriginalJsonSessionInput,
  type OriginalJsonEvidence } from './original-json-command-domain.js';

/** Minimal original-owner route contract. Both the standalone original Auth
 * worker and a colocated original Auth/Hub worker provide this capability.
 * Lifecycle is deliberately excluded: a route adapter never closes its owner. */
export type SqliteAuthRouteOwner = Pick<AsyncSqliteAuthOwner, 'assertAccessKeyBinding' | 'snapshot' | 'command'>
  & { readonly originalJson?: OriginalJsonRouteCapability | undefined; readonly currentKeyBinding?: AuthKeyDeliveryFence };

/** Trusted fixed-key route integration. One complete original SQL
 * owner, no Set.has cache and no callable transaction guard sent to a worker.
 * NOT activated by application.ts: its Hub/runtime authority still needs a
 * complete awaited migration. Never instantiate beside its synchronous DB.
 * accessKeyDigest is private server configuration, not browser-provided data. */
export class AsyncSqliteAuthRoutePort {
  readonly passkeys: AuthPasskeyStore;
  readonly sessions: AuthRouteSessionStore;
  readonly authority: AuthRouteAuthority;
  private readonly key: string | undefined;
  constructor(private readonly owner: SqliteAuthRouteOwner, private readonly accessKeyDigest?: string) {
    if (accessKeyDigest !== undefined && !/^[a-f0-9]{64}$/.test(accessKeyDigest)) throw new AuthPersistenceError();
    owner.assertAccessKeyBinding(accessKeyDigest);
    this.key = accessKeyDigest?.slice(0, 24);
    this.passkeys = {
      status: key => this.invoke('status', {}, key), list: key => this.invoke('list', {}, key),
      registrationOptions: (request, key) => this.invoke('registrationOptions', {
        origin: relyingParty(request).origin, evidence: this.evidence(request),
      }, key),
      authenticationOptions: (request, key) => this.invoke('authenticationOptions', { origin: relyingParty(request).origin }, key),
      verifyAuthentication: async (request, response, key) => {
        const epoch = this.owner.currentKeyBinding?.capture();
        const result = await this.invoke('verifyAuthentication', { origin: relyingParty(request).origin, response }, key);
        return result.verified ? { ...result, keyIdentityHash: result.keyIdentityHash, isCurrent: () => {
          if (epoch !== undefined) this.owner.currentKeyBinding!.assertCurrent(epoch);
          this.check(key);
          return this.session(this.owner.originalJson ? 'authentication-current' : 'current', result.sessionToken);
        } } : result;
      },
      // Fail closed on the old callback-based port. Only the request-aware
      // authority commands below can enter an original mutation transaction.
      revoke: () => { throw new AuthPersistenceError(); },
      verifyRegistration: async () => { throw new AuthPersistenceError(); },
    };
    this.sessions = {
      has: token => this.session('current', token),
      add: (token, binding) => {
        if (binding !== undefined) throw new AuthPersistenceError();
        if (this.accessKeyDigest === undefined) return this.invoke('issueUnrestrictedSession', { token }, this.key);
        // Trusted administrator issuance AFTER the route validates key login.
        // Passkey verification already commits its session in the original
        // transaction and MUST NOT call this as a second issuance.
        return this.invoke('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: this.accessKeyDigest } }, this.key);
      },
      delete: token => {
        this.check(this.key);
        if (this.owner.originalJson) return this.session('delete', token);
        // Shared logout visits both stores. A member or malformed cookie is
        // not an Auth session; keep the original delete(false) semantics at
        // this boundary without weakening the worker's mutation schema.
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
        return this.invoke('deleteSession', { token }, this.key);
      },
    };
    this.authority = {
      keyIdentityHash: this.key,
      authorize: request => this.owner.originalJson ? this.jsonAuthorized(originalJsonEvidenceFromRequest(request))
        : this.invoke('authorized', sqliteAuthEvidenceFromRequest(request), this.key),
      revoke: (request, key, credentialHash) => this.invoke('revoke', {
        credentialHash, evidence: this.evidence(request),
      }, key),
      verifyRegistration: (request, response, metadata) => this.invoke('verifyRegistration', {
        origin: relyingParty(request).origin, response, evidence: this.evidence(request),
        ...(metadata.label === undefined ? {} : { label: metadata.label }),
      }, metadata.keyIdentityHash),
      sessionCurrent: token => this.session('current', token),
    };
  }
  /** Standalone fixed-key administrator evidence, not general membership.
   * Preserve the legacy explicit-key precedence: an invalid supplied key may
   * never fall back to a valid cookie. Passkey sessions are not key-login
   * sessions. The result is an awaited observation, NOT a permission callback
   * for a later mutation; that transaction must validate its original proof.
   * This port is not activated by application.ts or the Hub routes yet. */
  async administrator(request: Request): Promise<boolean> {
    this.check(this.key);
    if (this.accessKeyDigest === undefined) return false;
    const evidence = this.owner.originalJson ? originalJsonEvidenceFromRequest(request) : sqliteAuthEvidenceFromRequest(request);
    if (evidence.suppliedKeyDigest !== undefined) {
      return this.owner.originalJson ? this.jsonAuthorized({ suppliedKeyDigest: evidence.suppliedKeyDigest })
        : this.invoke('authorized', { suppliedKeyDigest: evidence.suppliedKeyDigest }, this.key);
    }
    if (evidence.sessionToken !== undefined) {
      return this.session('access-key', evidence.sessionToken);
    }
    this.check(this.key);
    return false;
  }
  private check(key: string | undefined) {
    this.owner.currentKeyBinding?.capture();
    this.owner.assertAccessKeyBinding(this.accessKeyDigest);
    const state = this.owner.snapshot();
    if (key !== this.key || state.closing || state.unavailable || state.ownerExitConfirmed) throw new AuthPersistenceError();
  }
  private evidence(request: Request) {
    return this.owner.originalJson ? originalJsonEvidenceFromRequest(request) : sqliteAuthEvidenceFromRequest(request);
  }
  private async session(action: OriginalJsonSessionInput['action'], token: string): Promise<boolean> {
    this.check(this.key);
    if (action === 'authentication-current' && !this.owner.originalJson) throw new AuthPersistenceError();
    const result = this.owner.originalJson ? await this.owner.originalJson.session({ action, token })
      : await this.invoke(action === 'delete' ? 'deleteSession' : action === 'access-key' ? 'accessKeySession' : 'sessionCurrent', { token }, this.key);
    this.check(this.key); return result;
  }
  private async jsonAuthorized(input: OriginalJsonEvidence): Promise<boolean> {
    this.check(this.key);
    if (!this.owner.originalJson) throw new AuthPersistenceError();
    const result = await this.owner.originalJson.authorized(input); this.check(this.key); return result;
  }
  private async invoke<K extends SqliteAuthKind>(kind: K, input: SqliteAuthCommands[K]['input'], key: string | undefined):
    Promise<SqliteAuthCommands[K]['output']> {
    this.check(key); const result = await this.owner.command(kind, input); this.check(key); return result;
  }
}

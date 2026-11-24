import { relyingParty } from '../auth/passkeys.js';
import { AsyncSqliteAuthRoutePort } from '../auth/async-sqlite-route-port.js';
import type { AuthPasskeyStore, AuthRouteAuthority, AuthRouteSessionStore } from '../auth/route-persistence.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import type { SqliteAuthCommands } from '../auth/sqlite-owner-domain.js';
import { sqliteAuthEvidenceFromRequest } from '../auth/sqlite-owner-domain.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import type { HubLegacyAuthCommand, HubRequestAuthKind } from './legacy-auth-domain.js';

/** Original application passkey authority, not the standalone administrator
 * guard. Member credentials cross only the private worker channel; the same
 * original Hub checks them again inside each original Auth mutation. No
 * observed principal, grant, callback or boolean is sent across the channel.
 * Hub-only production uses this port; other application roles retain their
 * original root until their local execution authority migrates together. */
export class AsyncHubAuthRoutePort {
  readonly passkeys: AuthPasskeyStore;
  readonly sessions: AuthRouteSessionStore;
  readonly authority: AuthRouteAuthority;
  private readonly key: string | undefined;
  constructor(private readonly owner: AsyncHubMemberOwner, private readonly digest?: string) {
    if (!owner.legacyAuth) throw new AuthPersistenceError();
    const original = new AsyncSqliteAuthRoutePort(owner.legacyAuth, digest);
    this.key = digest?.slice(0, 24);
    this.sessions = original.sessions;
    this.passkeys = {
      ...original.passkeys,
      registrationOptions: (request, key) => this.invoke(request, 'registrationOptions', {
        origin: relyingParty(request).origin, evidence: sqliteAuthEvidenceFromRequest(request),
      }, key),
    };
    this.authority = {
      ...original.authority,
      authorize: request => this.invoke(request, 'authorized', {}, this.key),
      revoke: (request, key, credentialHash) => this.invoke(request, 'revoke', {
        credentialHash, evidence: sqliteAuthEvidenceFromRequest(request),
      }, key),
      verifyRegistration: (request, response, metadata) => this.invoke(request, 'verifyRegistration', {
        origin: relyingParty(request).origin, response, evidence: sqliteAuthEvidenceFromRequest(request),
        ...(metadata.label === undefined ? {} : { label: metadata.label }),
      }, metadata.keyIdentityHash),
    };
  }
  private check(key: string | undefined) {
    this.owner.legacyAuth!.assertAccessKeyBinding(this.digest);
    const state = this.owner.snapshot();
    if (key !== this.key || state.closing || state.unavailable || state.ownerExitConfirmed) throw new AuthPersistenceError();
  }
  private async invoke<K extends HubRequestAuthKind>(request: Request, kind: K,
    input: SqliteAuthCommands[K]['input'], key: string | undefined): Promise<SqliteAuthCommands[K]['output']> {
    this.check(key);
    const command = { kind, input, hubEvidence: hubMemberEvidence(request) } as HubLegacyAuthCommand;
    const reply = await this.owner.command('legacyAuth', command);
    this.check(key);
    return reply.value as SqliteAuthCommands[K]['output'];
  }
}

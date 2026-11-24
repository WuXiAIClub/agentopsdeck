import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { encodeHubSessionId } from './session-id.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const unavailable = (error: unknown) => error instanceof HubMemberRequestError && error.status === 503;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const domain of ['receivedGrants', 'sessionCollaborators', 'sessionSharing', 'ownedSessionSharing'] as const) {
  test(`production ${domain} close freezes retained authority and waits for the original committed ACK`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'administrative-sharing-drain-'));
    const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-vault');
    const production = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
    const owner = store.createUser('Owner'), creator = store.createUser('Creator'), recipient = store.createUser('Recipient');
    store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Node', connectorUrl: 'http://unused.invalid' });
    store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
    const target = (userId: string) => ({ ownerUserId: owner.id, connectionId: 'node', userId });
    for (const user of [creator, recipient]) {
      const member = target(user.id);
      store.roles.save(LEGACY_HUB_PRINCIPAL, member, { ...store.roles.membership(member), role: 'developer', migrateLegacy: true,
        nodeVersion: store.connectionAuthority('node', owner.id)!, environments: { codex: 'developer', openclaw: 'disabled' } });
    }
    const request = (userId: string) => {
      const key = store.identities.issueKey(userId), token = store.identities.createSession(key.token)!;
      return new Request('http://fixture.invalid/', { headers: { cookie: `agentopsdeck_session=${token}` } });
    };
    const creatorRequest = request(creator.id), ownerRequest = request(owner.id);
    const sessionKey = 'codex:' + randomUUID(), sessionId = encodeHubSessionId('node', sessionKey);
    const creation = store.grants.authorize(target(creator.id), 'sessions:create', { runtime: 'codex' })!;
    store.grants.acceptCreatedSession(creation, sessionKey, randomUUID(), randomUUID(), () => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    let trapped = 0, hold = false;
    const command: Pick<AsyncHubMemberOwner, 'command'> = {
      command: (async (kind, input) => {
        const value = await production.command(kind, input);
        const action = (input as { command?: { action?: string } }).command?.action;
        if (hold && kind === domain && (domain === 'receivedGrants' || action === 'list' || action === 'create')) {
          trapped++; entered(); await gate;
        }
        return value;
      }) as AsyncHubMemberOwner['command'],
    };
    const services = createHubAdministrativeServices(command);
    try {
      const shared = await services.sharing.begin(creatorRequest, owner.id, sessionId);
      const owned = await services.ownedSharing.begin(ownerRequest, encodeHubSessionId('node', 'codex:' + randomUUID()));
      hold = true;
      const work = {
        receivedGrants: () => services.received.received(creatorRequest, '', 50),
        sessionCollaborators: () => services.collaborators.collaborators(creatorRequest, owner.id, sessionId),
        sessionSharing: () => shared.create(recipient.id, 'observer', {}),
        ownedSessionSharing: () => owned.create(recipient.id, 'observer', {}),
      }[domain]();
      const rejected = assert.rejects(work, unavailable);
      await dispatched;
      const closing = services.close(); assert.equal(services.close(), closing);
      let closed = false; void closing.then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      await assert.rejects(shared.create(recipient.id, 'observer', {}), unavailable);
      await assert.rejects(owned.create(recipient.id, 'observer', {}), unavailable);
      await assert.rejects(services.received.received(creatorRequest, '', 50), unavailable);
      await assert.rejects(services.collaborators.collaborators(creatorRequest, owner.id, sessionId), unavailable);
      assert.equal(trapped, 1);
      release(); await rejected; await closing;
      assert.equal(closed, true); assert.equal(trapped, 1);
      // Freezing/draining a route is NOT authority to close or replace its DB.
      assert.equal(store.getUser(owner.id)?.label, 'Owner');
      if (domain === 'sessionSharing') {
        const proof = store.grants.authorize(target(creator.id), 'sessions:share', { runtime: 'codex', sessionKey })!;
        assert.equal(store.grants.collaborators(proof).filter(grant => grant.userId === recipient.id).length, 1);
      }
    } finally { release(); await services.close(); await production.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

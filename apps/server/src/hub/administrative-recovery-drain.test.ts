import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const unavailable = (error: unknown) => error instanceof HubMemberRequestError && error.status === 503;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const domain of ['sessionGuidance', 'quickChatState', 'quickChatCleanup'] as const) {
  test(`production ${domain} close freezes recovery and drains the original ACK without removing receipts`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'administrative-recovery-drain-'));
    const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-vault');
    const production = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
    const owner = store.createUser('Owner');
    store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Node', connectorUrl: 'http://unused.invalid' });
    store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
    const token = store.identities.createSession(store.identities.issueKey(owner.id).token)!;
    const request = () => new Request('http://fixture.invalid/', { headers: { cookie: `agentopsdeck_session=${token}` } });
    const sessionId = encodeHubSessionId('node', 'codex:' + randomUUID());
    const target = JSON.stringify([sessionId, store.getConnection('node', owner.id)!.nodeId, store.connectionAuthority('node', owner.id)!]);
    const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: 2000, epoch: 'fixed' };
    const profile = randomUUID(), admitted = randomUUID();
    store.quickChat.saveProfile(owner.id, 0, { id: profile, name: 'Profile', target: 'fixed', model: 'fixed', outputLimit: 2000 }, capability);
    store.quickChat.admit(owner.id, admitted, profile, 1, 'PRIVATE_PROMPT', capability);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    let trapped = 0, hold = false;
    const command: Pick<AsyncHubMemberOwner, 'command'> = {
      command: (async (kind, input) => {
        const value = await production.command(kind, input);
        const action = (input as { command?: { action?: string } }).command?.action;
        if (hold && kind === domain && ['save', 'inspect', 'cancel'].includes(action ?? '')) {
          trapped++; entered(); await gate;
        }
        return value;
      }) as AsyncHubMemberOwner['command'],
    };
    const services = createHubAdministrativeServices(command);
    try {
      const guidance = await services.guidance.begin(request(), sessionId);
      const recovery = await services.quickChatRecovery.begin(request());
      hold = true;
      const work = {
        sessionGuidance: () => guidance.save(0, 'Saved while closing', true),
        quickChatState: () => recovery.inspect(admitted),
        quickChatCleanup: () => recovery.cancel(admitted),
      }[domain]();
      const rejected = assert.rejects(work, unavailable);
      await dispatched;
      const closing = services.close(); assert.equal(services.close(), closing);
      let closed = false; void closing.then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      await assert.rejects(guidance.save(0, 'Denied', true), unavailable);
      await assert.rejects(recovery.inspect(admitted), unavailable);
      await assert.rejects(recovery.cancel(admitted), unavailable);
      await assert.rejects(recovery.clear(admitted), unavailable);
      await assert.rejects(services.guidance.begin(request(), sessionId), unavailable);
      await assert.rejects(services.quickChatRecovery.begin(request()), unavailable);
      assert.equal(trapped, 1);
      release(); await rejected; await closing;
      assert.equal(closed, true); assert.equal(trapped, 1);
      assert.equal(store.sessionGuidance.config(owner.id, target)?.text, domain === 'sessionGuidance' ? 'Saved while closing' : undefined);
      assert.equal(store.quickChat.receipt(owner.id, admitted)?.state, domain === 'quickChatCleanup' ? 'failed' : 'admitted');
      assert.equal(store.createUser('Store remains open').label, 'Store remains open');
    } finally { release(); await services.close(); await production.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

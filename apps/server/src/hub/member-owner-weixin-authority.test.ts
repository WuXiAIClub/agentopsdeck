import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { validHubMemberInput, type HubMemberEvidence } from './member-owner-domain.js';
import { WEIXIN_ORIGIN } from './weixin-transport.js';

const account = { botId: 'synthetic-bot', peerId: 'synthetic-peer', token: 'synthetic-provider-secret', baseUrl: WEIXIN_ORIGIN };
for (const kind of ['worker', 'original'] as const) {
  test(`${kind} WeChat binding observes live administrator Key revocation on the same owner`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-weixin-live-')), file = join(root, 'hub.sqlite');
    const administratorKey = 'synthetic-weixin-live-admin';
    const seed = new HubStore(file, 'synthetic-vault', [], administratorKey);
    const admin = seed.createUser('Synthetic administrator');
    seed.roles.setHubRole({ userId: 'default', admin: true }, admin.id, 'admin', 0);
    const adminCredential = seed.identities.issueKey(admin.id).token;
    const user = seed.createUser('Synthetic member').id, key = seed.identities.issueKey(user);
    const row = seed.weixin.create(user, key.id, randomUUID()).row;
    seed.weixin.bind(row, account);
    const evidence: HubMemberEvidence = { weixinBinding: { id: row.id, user: row.user, keyId: row.keyId } };
    await seed.close();
    const original = kind === 'original' ? new HubStore(file, 'synthetic-vault', [], administratorKey) : undefined;
    const owner = original ? new OriginalHubAdministrativeCommands(original) : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault', administratorKey });
    try {
      const initial = await owner.command('memberSnapshot', evidence);
      assert.ok(initial);
      const administrator = await owner.command('memberSnapshot', { accessKey: adminCredential });
      assert.ok(administrator?.principal.admin);
      assert.deepEqual(await owner.command('memberKeyRevoke', { evidence: { accessKey: adminCredential }, expectedScope: administrator.recoveryScope, userId: user, keyId: key.id }), { ok: true });
      assert.equal(await owner.command('memberSnapshot', evidence), null);
      const proof = { evidence, expectedScope: initial.recoveryScope };
      assert.equal(await owner.command('sessionStateSnapshot', { ...proof, command: { action: 'read' } }), null);
      assert.equal(await owner.command('connectorAccess', { ...proof, command: { action: 'open', id: 'missing', maintenance: false } }), null);
    } finally { await owner.close(); await original?.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
for (const kind of ['worker', 'original'] as const) for (const administrator of [false, true]) {
  for (const fault of ['expired', 'phase', 'removed', 'rebound', 'key-rotated', 'key-mismatch'] as const) {
    test(`${kind} WeChat ${administrator ? 'administrator' : 'member'} ${fault} rechecks original binding for every read`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-weixin-owner-')), file = join(root, 'hub.sqlite');
      let adminKey = administrator ? 'synthetic-configured-admin-key' : undefined;
      const seed = new HubStore(file, 'synthetic-vault', [], adminKey);
      const user = administrator ? 'default' : seed.createUser('Synthetic member').id;
      const key = seed.identities.issueKey(user);
      const row = seed.weixin.create(user, administrator ? seed.weixinAdministratorKeyId! : key.id, randomUUID()).row;
      seed.weixin.bind(row, account);
      const evidence: HubMemberEvidence = { weixinBinding: { id: row.id, user: row.user, keyId: row.keyId } };
      await seed.close();
      let original: HubStore | undefined;
      const open = () => {
        if (kind === 'worker') return new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-vault', ...(adminKey === undefined ? {} : { administratorKey: adminKey }) });
        original = new HubStore(file, 'synthetic-vault', [], adminKey);
        return new OriginalHubAdministrativeCommands(original);
      };
      let owner = open();
      const close = async () => { await owner.close(); await original?.close(); original = undefined; };
      try {
        const initial = await owner.command('memberSnapshot', evidence);
        assert.ok(initial); assert.deepEqual(initial.principal, { userId: user, admin: administrator });
        const proof = { evidence, expectedScope: initial.recoveryScope };
        const first = await owner.command('sessionStateSnapshot', { ...proof, command: { action: 'read' } });
        assert.ok(first?.action === 'read');
        const command = { action: 'check' as const, directoryVersion: first.directory.version, preferenceVersion: first.preferenceVersion };
        assert.equal((await owner.command('sessionStateCheck', { ...proof, command }))?.action, 'check');
        assert.deepEqual(await owner.command('connectorAccess', { ...proof, command: { action: 'open', id: 'missing', maintenance: false } }), { error: 'missing' });
        assert.equal(validHubMemberInput('workspaceGet', proof), false);
        assert.equal(validHubMemberInput('memberKeyIssue', { ...proof, userId: user }), false);
        assert.equal(validHubMemberInput('connectorAccess', { ...proof, command: { action: 'open', id: 'node', maintenance: true } }), false);
        await assert.rejects(owner.command('workspaceGet', proof));
        await close();
        // Only stopped synthetic storage is modified. No peer live writer and
        // no fabricated previously-authorized principal enters the owner.
        const db = new DatabaseSync(file);
        try {
          if (fault === 'expired') db.prepare('UPDATE hub_weixin_bindings SET expires_at=0').run();
          if (fault === 'phase') db.prepare("UPDATE hub_weixin_bindings SET phase='qr'").run();
          if (fault === 'removed') db.prepare('DELETE FROM hub_weixin_bindings').run();
          if (fault === 'rebound') db.prepare('UPDATE hub_weixin_bindings SET id=?').run(randomUUID());
          if (fault === 'key-mismatch') db.prepare('UPDATE hub_weixin_bindings SET key_id=?').run(randomUUID());
          if (fault === 'key-rotated') {
            if (administrator) adminKey = 'synthetic-rotated-admin-key';
            else db.prepare('DELETE FROM hub_login_keys WHERE id=?').run(key.id);
          }
        } finally { db.close(); }
        owner = open();
        assert.equal(await owner.command('memberSnapshot', evidence), null);
        assert.equal(await owner.command('sessionStateSnapshot', { ...proof, command: { action: 'read' } }), null);
        assert.equal(await owner.command('sessionStateCheck', { ...proof, command }), null);
        assert.equal(await owner.command('connectorAccess', { ...proof, command: { action: 'open', id: 'missing', maintenance: false } }), null);
      } finally { await close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

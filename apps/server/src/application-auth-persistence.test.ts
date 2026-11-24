import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

const administratorKey = 'isolated-auth-persistence-admin';
const cookieOf = (response: Response) => {
  const cookie = /^agentopsdeck_session=(?:hub_session_)?[A-Za-z0-9_-]{43}(?=;)/.exec(response.headers.get('set-cookie') ?? '')?.[0];
  assert.ok(cookie); return cookie;
};

// Hold the ORIGINAL committed operation, not a replacement SQL writer. A
// cancelled client may stop waiting for a read, but cannot release its owner.
for (const backend of ['json', 'sqlite'] as const) {
  for (const held of ['memberSessionCreate', 'memberIdentity', 'auditAppend'] as const) {
    test(`actual ${backend} auth cancellation/drain retains original ${held} ACK without cookie or replay`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-auth-drain-'));
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      const member = seed.createUser('Original drain member'), key = seed.identities.issueKey(member.id);
      await seed.close();
      let arrived!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { arrived = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const original = OriginalHubAdministrativeCommands.prototype.command, calls: string[] = [];
      let retained = false;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        calls.push(kind);
        const reply = original.call(this, kind, input);
        if (kind !== held || retained) return reply;
        retained = true;
        return reply.then(async value => { arrived(); await gate; return value; });
      });
      const application = createApplication(config), abort = new AbortController();
      const response = application.app.request('/api/auth/login', { method: 'POST', signal: abort.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: key.token }) });
      const settle = () => new Promise<void>(resolve => setImmediate(resolve));
      try {
        await entered;
        abort.abort();
        await settle();
        let drained = false;
        const closing = application.close().then(() => { drained = true; });
        await settle();
        assert.equal(drained, false, 'client cancellation is not an original persistence acknowledgement');
        const beforeLate = calls.length;
        assert.equal((await application.app.request('/api/auth/status')).status, 503);
        assert.equal(calls.length, beforeLate, 'late request must not reach closed auth/SQL');
        release();
        const result = await response;
        // Issuance's facade fences its late ACK at close; the later identity
        // and final-proof read paths report the already-cancelled HTTP wait.
        assert.equal(result.status, held === 'memberSessionCreate' ? 503 : 408);
        assert.equal(result.headers.get('set-cookie'), null);
        await closing;
        assert.equal(drained, true);
        assert.equal(calls.filter(kind => kind === 'memberSessionCreate').length, 1);
        assert.equal(calls.filter(kind => kind === held).length, 1, 'drain must not dispatch a replacement');
        const old = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
        try {
          assert.equal(old.identities.audit.list().filter(row => row.event === 'access_key_login' && row.userId === member.id).length,
            held === 'auditAppend' ? 1 : 0);
        } finally { await old.close(); }
      } finally { release(); await response; await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

for (const backend of ['json', 'sqlite'] as const) {
  test(`actual ${backend} authentication keeps original commits, persistent bans and audit after lost ACK/reopen`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-auth-persistence-'));
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_AUTH_MAX_FAILURES: '2',
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const member = seed.createUser('Existing authentication member'), key = seed.identities.issueKey(member.id);
    await seed.close();
    const calls: string[] = [], original = OriginalHubAdministrativeCommands.prototype.command;
    let lose: string | undefined, lost = 0, limiterSubject = '';
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      calls.push(kind);
      if (kind === 'loginLimiterFailure') limiterSubject = (input as { subject: string }).subject;
      const result = original.call(this, kind, input);
      if (kind !== lose) return result;
      lose = undefined; lost++;
      return result.then(() => { throw Error('PRIVATE original authentication commit reply'); });
    });
    let application = createApplication(config);
    const count = (kind: string) => calls.filter(value => value === kind).length;
    const login = (accessKey: string) => application.app.request('/api/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey }) });
    const expect = async (promise: Response | Promise<Response>, status: number) => {
      const response = await promise, text = await response.clone().text();
      assert.equal(response.status, status, text); assert.doesNotMatch(text, /PRIVATE|original authentication commit reply/);
      return response;
    };
    try {
      const administratorCookie = cookieOf(await expect(login(administratorKey), 200));
      const headers = { cookie: administratorCookie };
      for (const kind of ['memberSessionCreate', 'memberIdentity', 'auditAppend']) {
        const before = count('memberSessionCreate'), beforeLost = lost;
        lose = kind;
        const response = await expect(login(key.token), 503);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(count('memberSessionCreate'), before + 1, 'lost original reply must not replay issuance');
        assert.equal(lost, beforeLost + 1); assert.equal(lose, undefined);
      }
      const memberCookie = cookieOf(await expect(login(key.token), 200));
      const memberHeaders = { cookie: memberCookie };
      assert.equal((await (await expect(application.app.request('/api/auth/status', { headers: memberHeaders }), 200)).json()).authenticated, true);
      await expect(application.app.request('/api/auth/audit?page=true', { headers: memberHeaders }), 403);
      const page = await (await expect(application.app.request('/api/auth/audit?page=true', { headers }), 200)).json();
      assert.equal(page.persistent, true);
      assert.equal(page.records.filter((row: { event: string; userId?: string }) => row.event === 'access_key_login' && row.userId === member.id).length, 2,
        'lost audit acknowledgement must retain exactly the original append');
      const auditList = await (await expect(application.app.request('/api/auth/audit', { headers }), 200)).json();
      assert.equal(auditList.records.length, page.records.length);
      for (const kind of ['memberIdentity', 'memberSessionCreate', 'auditAppend', 'auditPage', 'auditList', 'loginLimiterCheck', 'loginLimiterSuccess'])
        assert.ok(count(kind) > 0, kind + ' must use the production awaited port');

      lose = 'memberSessionDelete'; const beforeDelete = count('memberSessionDelete');
      await expect(application.app.request('/api/auth/logout', { method: 'POST', headers: memberHeaders }), 503);
      assert.equal(count('memberSessionDelete'), beforeDelete + 1);
      assert.equal((await (await expect(application.app.request('/api/auth/status', { headers: memberHeaders }), 200)).json()).authenticated, false);

      lose = 'loginLimiterFailure';
      const beforeFailure = count('loginLimiterFailure');
      await expect(login('wrong-key'), 503);
      assert.equal(count('loginLimiterFailure'), beforeFailure + 1);
      await expect(login('wrong-key'), 429);
      assert.equal(count('loginLimiterFailure'), beforeFailure + 2);
      assert.match(limiterSubject, /^[a-f0-9]{24}$/);
      await application.close(); application = createApplication(config);
      // Neither new facade construction nor a successful read resets a ban.
      await expect(login(key.token), 429);
      assert.equal((await (await expect(application.app.request('/api/auth/status', { headers }), 200)).json()).authenticated, true);
      assert.equal((await (await expect(application.app.request('/api/auth/status', { headers: memberHeaders }), 200)).json()).authenticated, false);
      const reopened = await (await expect(application.app.request('/api/auth/audit?page=true', { headers }), 200)).json();
      assert.equal(reopened.records.filter((row: { event: string; userId?: string }) => row.event === 'access_key_login' && row.userId === member.id).length, 2);
      await application.close();
      const originalStore = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      try {
        assert.equal(originalStore.createLoginLimiter(config.authRateLimit).check(limiterSubject).allowed, false);
        assert.equal(originalStore.identities.requestIdentity(new Request('http://fixture.invalid/', { headers: memberHeaders })), undefined);
        assert.equal(originalStore.identities.audit.list().filter(row => row.event === 'access_key_login' && row.userId === member.id).length, 2);
      } finally { await originalStore.close(); }
    } finally { await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

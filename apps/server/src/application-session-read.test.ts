import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { AuthPersistenceError } from './auth/private-store.js';
import type { RequestAuthorization } from './auth/awaited-request-authorization.js';
import type { HubPrincipal } from './hub/identity.js';

function configuration(directory: string, role: 'all' | 'connector') {
  return loadConfig({ HOME: directory, AOD_SERVER_ROLE: role, AOD_ACCESS_KEY: 'PRIVATE-bootstrap',
    AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'PRIVATE-fixture-vault',
    AOD_SESSION_TITLES_FILE: join(directory, 'titles.json'), AOD_PASSKEYS_FILE: join(directory, 'passkeys.json'),
    AOD_AUTH_SESSIONS_FILE: join(directory, 'auth.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(directory, 'connector.sqlite'),
    AOD_CONNECTOR_TOKENS_FILE: join(directory, 'tokens.json') });
}

for (const outcome of ['administrator', 'member', 'revoked', 'rejected'] as const) {
  test(`application legacy session read awaits original Hub observation: ${outcome}`, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-app-session-read-'));
    let observe!: RequestAuthorization;
    const application = createApplication(configuration(directory, 'all'), () => ({ app: new Hono(),
      stopAdmissions: async () => {}, close: async () => {},
      localToken: 'PRIVATE-local-token', localMaintenanceToken: 'PRIVATE-maintenance-token',
      mediaLibrary: { isSignedStreamRequest: () => false },
      registerLegacyRoutes(_target: Hono, authority: RequestAuthorization) { observe = authority; },
    }) as any);
    let resolve!: (value: HubPrincipal | undefined) => void, reject!: (error: unknown) => void, calls = 0, settled = false;
    const original = new Promise<HubPrincipal | undefined>((yes, no) => { resolve = yes; reject = no; });
    const command = OriginalHubAdministrativeCommands.prototype.command;
    context.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'memberSnapshot') {
        calls++; return original.then(principal => principal ? { principal, recoveryScope: 'a'.repeat(64) } : null);
      }
      return command.call(this, kind, input);
    });
    try {
      const response = Promise.resolve(observe(new Request('http://fixture/api/sessions/state')));
      void response.then(() => { settled = true; }, () => { settled = true; });
      await new Promise<void>(done => setImmediate(done));
      assert.equal(settled, false); assert.equal(calls, 1);
      if (outcome === 'rejected') {
        const rejected = assert.rejects(response, AuthPersistenceError);
        reject(Error('PRIVATE-original-error')); await rejected;
      } else {
        resolve(outcome === 'revoked' ? undefined : { userId: 'PRIVATE-user', admin: outcome === 'administrator' });
        assert.equal(await response, outcome === 'administrator');
      }
    } finally {
      resolve(undefined); await application.close(); rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('application standalone session reads retain the configured access-key authorization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-app-session-key-'));
  let observe!: RequestAuthorization;
  const application = createApplication(configuration(directory, 'connector'), () => ({ app: new Hono(),
    stopAdmissions: async () => {}, close: async () => {},
    localToken: 'PRIVATE-local-token', localMaintenanceToken: 'PRIVATE-maintenance-token',
    mediaLibrary: { isSignedStreamRequest: () => false },
    registerLegacyRoutes(_target: Hono, authority: RequestAuthorization) { observe = authority; },
  }) as any);
  try {
    for (const key of ['PRIVATE-bootstrap', 'PRIVATE-wrong', undefined]) {
      const request = new Request('http://fixture/api/sessions/state', {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
      assert.equal(await observe(request), key === 'PRIVATE-bootstrap');
    }
  } finally { await application.close(); rmSync(directory, { recursive: true, force: true }); }
});

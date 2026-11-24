import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationHttpShell } from './application-http-shell.js';
import { loadConfig } from './config.js';
import { registerApplicationAuthorization } from './auth/application-authorization.js';
import { AuthAuditLog } from './auth/security.js';

test('HTTP shell rejects unsafe direct composition as well as loaded configuration', () => {
  assert.throws(() => createApplicationHttpShell({ ...loadConfig({}), listenHost: '0.0.0.0' }), /requires AOD_ACCESS_KEY/);
});

for (const mode of ['origin', 'permission', 'authorized']) {
  test(`voice ${mode} admission precedes body work and retains the original message read chain`, async context => {
    const previous = process.env.AOD_VOICE_ENABLED;
    process.env.AOD_VOICE_ENABLED = 'false';
    context.after(() => {
      if (previous === undefined) delete process.env.AOD_VOICE_ENABLED;
      else process.env.AOD_VOICE_ENABLED = previous;
    });
    const shell = createApplicationHttpShell(loadConfig({ AOD_ACCESS_KEY: 'synthetic-shell-key' }));
    const authorization = registerApplicationAuthorization(shell.app, { hasHub: false, principal: () => undefined,
      authorize: request => request.method === 'GET' || mode !== 'permission', recordActivity: () => {},
      audit: new AuthAuditLog(), signedStream: () => false, allowedBrowserOrigin: shell.allowedBrowserOrigin });
    context.after(() => authorization.close());
    let messageReads = 0;
    shell.app.get('/api/sessions/:id/messages', current => { messageReads++; return current.json({ messages: [] }); });
    const stream = new ReadableStream({ start() {}, pull() { throw new Error('body must not be read'); } }, { highWaterMark: 0 });
    const request = new Request('http://localhost/api/sessions/synthetic/voice', { method: 'POST',
      headers: { origin: mode === 'origin' ? 'https://untrusted.invalid' : 'http://localhost' }, body: stream,
      duplex: 'half' } as RequestInit);
    const response = await shell.app.request(request);
    assert.equal(response.status, mode === 'origin' ? 403 : mode === 'permission' ? 401 : 503);
    assert.equal(messageReads, mode === 'authorized' ? 1 : 0);
    if (mode === 'authorized') assert.deepEqual(await response.json(), { error: 'voice_disabled' });
  });
}

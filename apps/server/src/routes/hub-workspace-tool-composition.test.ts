import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { registerHubBrowser } from './hub-workspace-browser.js';
import { registerHubRemoteRoutes } from './hub-workspace-remote.js';
import { registerHubResearchRoutes } from './hub-workspace-research.js';
import { registerHubQuickChat } from './hub-quick-chat.js';

for (const register of [registerHubBrowser, registerHubRemoteRoutes, registerHubResearchRoutes]) {
  test(`${register.name}: incomplete async authority rejects composition before publication or effects`, () => {
    let effects = 0;
    const forbidden = () => { effects++; throw Error('must not run'); };
    for (const access of [undefined, {}, { requests: { begin: forbidden } },
      { requests: { begin: forbidden }, audit: { append: forbidden } },
      { requests: {}, audit: { append: forbidden }, close: forbidden },
      { requests: { begin: forbidden }, audit: {}, close: forbidden }]) {
      const app = new Hono();
      assert.throws(() => register(app, { mode: 'async', access } as never), /ports are required/);
      assert.equal(app.routes.length, 0);
    }
    assert.equal(effects, 0);
  });
}

test('quick chat: async persistence is required before routes are published', () => {
  for (const service of [undefined, {}, { persistence: {} }, { persistence: { begin: null } }]) {
    const app = new Hono();
    assert.throws(() => registerHubQuickChat(app, { mode: 'async', service } as never), /persistence ports are required/);
    assert.equal(app.routes.length, 0);
  }
});

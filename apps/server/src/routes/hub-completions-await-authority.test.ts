import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubPrincipal } from '../hub/identity.js';
import { registerHubCompletionRoutes } from './hub-completions.js';

for (const action of ['summary', 'observe', 'read'] as const) for (const stage of ['admission', 'delivery'] as const) {
  test(`completion ${action} ${stage} rejects authority revoked in the principal await gap`, async () => {
    const app = new Hono(); let current: HubPrincipal | undefined = { userId: 'member', admin: false };
    let checks = 0, effects = 0;
    registerHubCompletionRoutes(app, {
      principal: () => {
        const observed = current;
        if (++checks === (stage === 'admission' ? 2 : 3)) queueMicrotask(() => { current = undefined; });
        if (!observed) throw new HTTPException(401);
        return observed;
      },
      synchronousStoreAuthority: () => { if (!current) throw new HTTPException(401); return current; },
      port: { command: () => { effects++; return action === 'summary' ? { items: [] } : action === 'observe'
        ? { observation: { token: 'token', generation: 'generation', throughSequence: 1, expiresAt: 1 } }
        : { throughSequence: 1 }; } },
    });
    const body = action === 'summary' ? { sessions: [] } : action === 'observe' ? { sessionKey: 'conn:YQ' }
      : { sessionKey: 'conn:YQ', requestId: 'receipt', token: 'token', throughSequence: 1 };
    const response = await app.request(`/api/hub/v1/completions/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(effects, stage === 'admission' ? 0 : 1, 'a committed original effect must not be undone or repeated');
  });
}

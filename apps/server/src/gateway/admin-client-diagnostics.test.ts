import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminRpcClient } from './admin-client.js';

test('admin RPC rejects upstream errors without copying their diagnostics', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: { message: 'PRIVATE-upstream-detail' } }, { status: 502 });
  try {
    const client = new AdminRpcClient({ url: 'https://gateway.example.invalid', ownerToken: undefined });
    await assert.rejects(client.request('gateway.health'), error => {
      assert.equal((error as Error).message, 'Admin RPC request failed');
      assert.doesNotMatch(String(error), /PRIVATE/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin RPC redacts transport exceptions before passing them to callers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('PRIVATE-transport-detail'); };
  try {
    const client = new AdminRpcClient({ url: 'https://gateway.example.invalid', ownerToken: undefined });
    await assert.rejects(client.request('gateway.health'), { message: 'Admin RPC transport unavailable' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

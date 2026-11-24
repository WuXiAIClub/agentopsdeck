import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTTPException } from 'hono/http-exception';
import { ConnectorTokenStore, type ConnectorPrincipal } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ChangeSignal } from '../utils/change-signal.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorReadAuthority, synchronousConnectorReadAuthority } from './read-authority.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const quiet = new PerformanceDiagnostics(() => {});
const request = (authorization: string, signal?: AbortSignal) => new Request('http://local/', {
  headers: { authorization }, ...(signal ? { signal } : {}),
});
function held<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}

test('real worker checks original credential and current scope; header and returned principal cannot replace evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'read-authority-'));
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: 'PRIVATE-bootstrap' }, quiet);
  const authority = new AsyncConnectorReadAuthority(owner, { diagnostics: quiet });
  try {
    await owner.open();
    const first = await owner.command('tokenCreate', { label: 'first', scopes: ['agents:read'] });
    const second = await owner.command('tokenCreate', { label: 'second', scopes: ['agents:read'] });
    const req = request(`Bearer ${first.token}`);
    const handle = await authority.begin(req, 'agents:read');
    req.headers.set('authorization', `Bearer ${second.token}`);
    handle.principal.tokenId = second.record.id;
    await handle.check();
    await assert.rejects(authority.begin(request(`Bearer ${first.token}`), 'system:metrics:read'),
      (error: unknown) => error instanceof HTTPException && error.status === 403);
    const revision = authority.changes.revision;
    assert.equal(await owner.command('tokenRevoke', { tokenId: first.record.id }), true);
    assert.ok(authority.changes.revision > revision);
    await assert.rejects(async () => { await handle.check(); }, (error: unknown) => error instanceof HTTPException && error.status === 403);
    await (await authority.begin(request(`Bearer ${second.token}`), 'agents:read')).check();
    assert.doesNotMatch(JSON.stringify(quiet.snapshot()), /PRIVATE|Bearer/);
  } finally { await authority.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('sync compatibility adapter rechecks original credential, not a mutable request header', async () => {
  const root = mkdtempSync(join(tmpdir(), 'read-authority-sync-'));
  try {
    const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), undefined, quiet);
    const first = tokens.create({ label: 'first', scopes: ['agents:read'] });
    const second = tokens.create({ label: 'second', scopes: ['agents:read'] });
    const authority = synchronousConnectorReadAuthority(tokens), req = request(`Bearer ${first.token}`);
    const handle = await authority.begin(req, 'agents:read');
    req.headers.set('authorization', `Bearer ${second.token}`); tokens.revoke(first.record.id);
    assert.throws(() => handle.check(), (error: unknown) => error instanceof HTTPException && error.status === 403);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ['abort', 'timeout', 'close'] as const) test(`read authority ${mode} retains physical work until original settles`, async () => {
  const original = held<ConnectorPrincipal | null>(); let calls = 0;
  const owner = { authorityChanges: new ChangeSignal(), command: (() => { calls++; return original.promise; }) as AsyncConnectorOwner['command'] };
  const authority = new AsyncConnectorReadAuthority(owner, { diagnostics: quiet, timeoutMs: mode === 'timeout' ? 15 : 1000 });
  const abort = new AbortController();
  const pending = authority.begin(request('Bearer PRIVATE', abort.signal), 'agents:read');
  const refused = assert.rejects(pending);
  await tick(); assert.equal(calls, 1);
  if (mode === 'abort') abort.abort();
  let drained = false;
  if (mode !== 'timeout') void authority.close().then(() => { drained = true; });
  if (mode === 'timeout') await refused;
  const close = authority.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  original.resolve({ tokenId: 'id', label: 'label', scopes: ['agents:read'] });
  await refused; await close; assert.equal(calls, 1);
  await assert.rejects(authority.begin(request('Bearer PRIVATE'), 'agents:read'));
});

test('read authority refuses malformed and swapped worker identity on delivery checks', async () => {
  let value: unknown = { tokenId: 'first', label: 'label', scopes: ['agents:read'] };
  const authority = new AsyncConnectorReadAuthority({ authorityChanges: new ChangeSignal(),
    command: (async () => value) as AsyncConnectorOwner['command'] }, { diagnostics: quiet });
  try {
    const handle = await authority.begin(request('Bearer PRIVATE'), 'agents:read');
    value = { tokenId: 'second', label: 'label', scopes: ['agents:read'] };
    await assert.rejects(async () => { await handle.check(); });
    value = { tokenId: 'first', label: 'label', scopes: ['agents:read'], authorized: true };
    await assert.rejects(async () => { await handle.check(); });
  } finally { await authority.close(); }
});

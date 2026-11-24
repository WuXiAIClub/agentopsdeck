import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { ChatMessage } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkMessages } from './async-sdk-messages.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import { AsyncSdkStatus } from './async-sdk-status.js';
import { registerSdkMessagesHttp, type SdkMessagesHttp } from './sdk-messages-http.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

const token = 'isolated-sdk-status-http', authorization = `Bearer ${token}`, wait = { timeoutMs: 5000 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function fixture(runtime: SdkAgentId) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-status-http-')), file = join(directory, 'connector.sqlite');
  const tokenFile = join(directory, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, token), lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  const config = { file, tokenFile, bootstrapToken: token, sdkModels: { 'claude-code': { model: 'default' }, ghcp: { model: 'default' } } };
  let owner = new AsyncConnectorOwner(config, diagnostics); await owner.open();
  const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'create', payloadJson: '{}' });
  assert.ok('receipt' in created && created.key); const key = created.key;
  let wakes = 0, displays = 0, projections = 0, failProjection = false, fallback = 0;
  let port: Pick<AsyncConnectorOwner, 'command'> = owner;
  const proxy: Pick<AsyncConnectorOwner, 'command'> = { command: (kind, input) => port.command(kind, input) };
  const messages = new AsyncSdkMessages(proxy, () => { wakes++; });
  const projected = new Map<string, ChatMessage>();
  const status = new AsyncSdkStatus(proxy, () => { displays++; return { connected: true, gateway: 'connected', session: { model: `display-${displays}`, totalTokens: 123 } }; },
    report => { projections++; projected.set(report[0].id, report[0]); if (failProjection) throw Error('isolated projection failure'); projected.set(report[1].id, report[1]); }, diagnostics);
  const deps: SdkMessagesHttp = { messages, status, ready: () => false, diagnostics, timeoutMs: 5000 };
  const app = new Hono(); registerSdkMessagesHttp(app, '/sessions/:sessionKey', deps);
  app.post('/sessions/:sessionKey/messages', c => { fallback++; return c.json({ legacy: true }); });
  const path = `/sessions/${key}`, scope = { runtime, key, authorization, commandKey: 'status' };
  const post = (body: unknown = { message: ' /status ', idempotencyKey: 'status' }, headers: Record<string, string> = {}) => app.request(`${path}/messages`,
    { method: 'POST', headers: { authorization, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const recover = (headers: Record<string, string> = {}) => app.request(`${path}/commands/status/status`, { headers: { authorization, ...headers } });
  return { owner, config, tokens, app, deps, post, recover, scope, status, messages, lines, projected, path,
    counts: () => ({ wakes, displays, projections, fallback }),
    failProjection: (v: boolean) => { failProjection = v; },
    port: (value: Pick<AsyncConnectorOwner, 'command'>) => { port = value; },
    reopen: async () => { await owner.close(); owner = new AsyncConnectorOwner(config, diagnostics); await owner.open(); port = owner; },
    close: async () => { await owner.close(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: real worker status HTTP preserves original wire, report IDs, fingerprint and reopen recovery`, async () => {
    const f = await fixture(runtime);
    try {
      const response = await f.post(); assert.equal(response.status, 200);
      const body = await response.json(); assert.equal(body.status, 'ok'); assert.equal(body.deliveryMode, 'web-only');
      assert.equal(body.deliver, false); assert.deepEqual(body.media, []); assert.equal(body.command.state, 'accepted');
      assert.equal(body.idempotencyKey, body.command.id); assert.equal(body.command.key, 'status');
      assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'status');
      const original = [...f.projected.values()]; assert.equal(original.length, 2); assert.match(original[1]!.text, /display-1/);
      assert.match(original[1]!.text, /last known projection/);
      assert.equal(f.counts().wakes, 0); assert.equal(f.counts().fallback, 0);
      await f.owner.command('maintenancePause', {});
      assert.deepEqual(await (await f.post()).json(), body);
      assert.deepEqual([...f.projected.values()], original);
      const conflict = await f.post({ message: '/status', idempotencyKey: 'status' }); assert.equal(conflict.status, 409);
      await f.reopen(); f.projected.clear();
      const recovered = await f.recover(); assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), body);
      assert.deepEqual([...f.projected.values()], original);
      assert.equal(f.counts().displays, 3, 'read recovery cannot recompute a report');
      assert.doesNotMatch(f.lines.join('\n'), /isolated-sdk-status-http|display-1|Bearer /);
      assert.match(f.lines.join('\n'), /sdk-message-http/);
    } finally { await f.close(); }
  });

  test(`${runtime}: projection failure preserves original accepted receipt and read-only recovery repairs partial upserts`, async () => {
    const f = await fixture(runtime);
    try {
      f.failProjection(true);
      const response = await f.post(); assert.equal(response.status, 503); assert.equal(f.projected.size, 1);
      const original = await f.owner.command('sdkMessageStatusRead', f.scope);
      assert.ok('receipt' in original && original.receipt?.state === 'accepted' && original.report);
      f.failProjection(false);
      const read = await f.recover(); assert.equal(read.status, 200); assert.equal(f.projected.size, 2);
      assert.deepEqual([...f.projected.values()], original.report);
      assert.equal(f.counts().displays, 1); assert.equal(f.counts().wakes, 0);
      const actor = await f.owner.command('tokenAuthenticate', { authorization });
      assert.ok(actor); await f.owner.command('tokenRevoke', { tokenId: actor.tokenId });
      const before = f.counts().projections;
      assert.equal((await f.recover()).status, 401); assert.equal(f.counts().projections, before);
    } finally { await f.close(); }
  });

  test(`${runtime}: HTTP deadline retains original physical status write; late commit is recovered without send/native replay`, async () => {
    const f = await fixture(runtime), hold = gate(); let writes = 0;
    try {
      let completed!: () => void; const physical = new Promise<void>(resolve => { completed = resolve; });
      f.port({ command: (async (kind, input) => {
        if (kind === 'sdkMessageStatus') { writes++; await hold.promise; }
        const result = await f.owner.command(kind, input);
        if (kind === 'sdkMessageStatus') completed(); return result;
      }) as typeof f.owner.command });
      f.deps.status = { send: (input, options) => f.status.send(input, { ...options, timeoutMs: 5 }), read: f.status.read.bind(f.status) };
      const response = await f.post(); assert.equal(response.status, 503); assert.equal(writes, 1); assert.equal(f.projected.size, 0);
      hold.release(); await physical;
      assert.equal((await f.recover()).status, 200); assert.equal(f.projected.size, 2);
      assert.equal(writes, 1); assert.equal(f.counts().wakes, 0);
    } finally { hold.release(); await f.close(); }
  });

  test(`${runtime}: status cannot clear active or unknown execution even during maintenance`, async () => {
    const f = await fixture(runtime);
    try {
      const sent = await f.messages.send({ ...f.scope, commandKey: 'ordinary', payloadJson: '{"message":"original execution"}' }, wait);
      assert.ok('receipt' in sent && sent.receipt?.state === 'accepted');
      const dispatch = new AsyncSdkDispatch({ runtime, owner: f.owner, deadlineMs: 5000,
        adapter: { ready: true, epoch: 'original-epoch', send: async () => ({ nativeRequestId: 'original-native-request' }),
          interrupt: async () => { throw Error('status must not interrupt'); },
          inspectSettlement: async ref => ({ ...ref, nativeQuiescent: false, historyPersisted: false }) } });
      assert.equal(await dispatch.dispatch(f.scope.key), 'accepted');
      const original = await f.owner.command('sdkSnapshotRead', { runtime, key: f.scope.key });
      assert.ok(original.execution); await f.owner.command('maintenancePause', {});
      assert.equal((await f.post()).status, 200);
      assert.match([...f.projected.values()][1]!.text, /Active run: yes/);
      assert.deepEqual(await f.owner.command('sdkSnapshotRead', { runtime, key: f.scope.key }), original);
      const ref = { key: f.scope.key, id: original.execution.id, epoch: original.execution.epoch, nativeSessionId: original.execution.nativeSessionId };
      assert.equal(await f.owner.command('sdkExecutionUnknown', { runtime, ref }), true);
      const unknown = await f.owner.command('sdkSnapshotRead', { runtime, key: f.scope.key });
      const result = await f.status.send({ ...f.scope, commandKey: 'unknown-report', payloadJson: '{"message":"/status"}' }, wait);
      assert.ok('report' in result && result.report); assert.match(result.report[1].text, /Execution: unknown/);
      assert.deepEqual(await f.owner.command('sdkSnapshotRead', { runtime, key: f.scope.key }), unknown);
    } finally { await f.close(); }
  });

  test(`${runtime}: revoke after original status commit fences HTTP delivery without losing its report`, async () => {
    const f = await fixture(runtime), committed = gate(), release = gate();
    try {
      f.port({ command: (async (kind, input) => {
        const result = await f.owner.command(kind, input);
        if (kind === 'sdkMessageStatus') { committed.release(); await release.promise; }
        return result;
      }) as typeof f.owner.command });
      const pending = f.post(); await committed.promise;
      const saved = await f.owner.command('sdkMessageStatusRead', f.scope);
      assert.ok('report' in saved && saved.report && saved.receipt?.state === 'accepted');
      const actor = await f.owner.command('tokenAuthenticate', { authorization });
      assert.ok(actor); await f.owner.command('tokenRevoke', { tokenId: actor.tokenId });
      release.release(); assert.equal((await pending).status, 401);
      assert.equal(f.projected.size, 0); assert.equal(f.counts().wakes, 0);
      assert.equal((await f.recover()).status, 401);
    } finally { release.release(); await f.close(); }
  });

  test(`${runtime}: revoke while original status claim waits cannot create a report or receipt`, async () => {
    const f = await fixture(runtime), entered = gate(), release = gate();
    try {
      f.port({ command: (async (kind, input) => {
        if (kind === 'sdkMessageStatus') { entered.release(); await release.promise; }
        return f.owner.command(kind, input);
      }) as typeof f.owner.command });
      const pending = f.post(); await entered.promise;
      const actor = await f.owner.command('tokenAuthenticate', { authorization });
      assert.ok(actor); await f.owner.command('tokenRevoke', { tokenId: actor.tokenId });
      release.release(); assert.equal((await pending).status, 401);
      assert.equal(f.projected.size, 0); assert.equal(f.counts().wakes, 0);
    } finally { release.release(); await f.close(); }
  });

  test(`${runtime}: status HTTP denies key conflicts, empty grants and insufficient scopes without synchronous fallback`, async () => {
    const f = await fixture(runtime);
    try {
      for (const headers of [{ 'x-agentopsdeck-execution-grant': '' }, { 'x-agentopsdeck-execution-grant': 'forged' }]) {
        assert.equal((await f.post(undefined, headers)).status, 403);
        assert.equal((await f.recover(headers)).status, 403);
      }
      assert.equal((await f.post(undefined, { 'idempotency-key': 'different' })).status, 400);
      assert.equal((await f.post({ message: '/status', idempotencyKey: 'bad key' })).status, 400);
      for (const scopes of [['messages:send'], ['messages:read']] as const) {
        const actor = await f.owner.command('tokenCreate', { label: 'limited', scopes: [...scopes] });
        assert.equal((await f.post(undefined, { authorization: `Bearer ${actor.token}` })).status, 403);
      }
      assert.equal(f.counts().fallback, 0); assert.equal(f.counts().wakes, 0); assert.equal(f.projected.size, 0);
      assert.equal((await f.recover()).status, 404);
      await tick();
    } finally { await f.close(); }
  });
}

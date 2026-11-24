import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {setImmediate as turn} from 'node:timers/promises';
import {CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER} from '@agentopsdeck/shared';
import {asyncNativeFileFixture, deferredNative} from './async-native-file-fixture.js';
import {AsyncNativeFileBackgroundAccess} from './async-native-file-background-access.js';
import {validNativeFileBackgroundCommand, validNativeFileBackgroundResult,
  type NativeFileBackgroundWork, type NativeFileBackgroundResult} from './native-file-background-domain.js';
import {ConnectorClient} from './connector-client.js';
import {AsyncNativeFileBackground} from './async-native-file-background.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {AuthPersistenceError} from '../auth/private-store.js';

for (const mode of ['original', 'worker'] as const) {
  for (const domain of ['board', 'card'] as const) {
    test(`${mode}/${domain}: private SSE applies actual Connector contents and shutdown drains original projection ACK`, {timeout: 20_000}, async t => {
      const f = await asyncNativeFileFixture(t, mode, domain), port = await f.begin(), id = randomUUID();
      await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision});
      const body = JSON.parse(await readFile(f.remotePath(id), 'utf8')) as {title?: string; content?: {title: string}};
      if (body.content) body.content.title = 'Background Agent'; else body.title = 'Background Agent';
      await writeFile(f.remotePath(id), JSON.stringify(body));
      const entered = deferredNative(), release = deferredNative(); let held = false;
      f.hooks.backgroundAck = async command => {
        if (command.action === 'apply' && command.snapshot.state === 'ready' && !held) {held = true; entered.resolve(); await release.promise;}
      };
      const {background} = f.current();
      try {
        await background.syncTick(); await entered.promise;
        const document = await f.document(id);
        assert.equal('kind' in document ? (document.content as {title: string}).title : document.title, 'Background Agent');
        let closed = false; const closing = background.close().then(() => {closed = true;});
        await turn(); assert.equal(closed, false, 'close retains admitted original ACK');
        release.resolve(); await closing;
        await background.syncTick(); assert.equal(f.calls.subscribe, 1);
        assert.equal(f.calls.install, 1); assert.equal(f.calls.write, 0);
      } finally {release.resolve(); await background.close();}
    });
  }
  test(`${mode}: private reference scan is bounded, unknown scan ACK is recoverable, and scopes cannot be substituted`, async t => {
    const f = await asyncNativeFileFixture(t, mode), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision});
    await assert.rejects(f.current().owner.command('nativeFileBackground', {action: 'scan', after: ''}));
    const access = f.current().backgroundAccess;
    const page = await access.command({action: 'scan', after: ''}); assert.equal(page.action, 'scan');
    if (page.action !== 'scan') throw Error('wrong page');
    assert.ok(page.work.length <= 4); const work = page.work[0]!; assert.equal(work.bindingId, id);
    assert.equal('user' in work, false); assert.equal('connectionId' in work, false);
    assert.deepEqual(await access.command({action: 'scan', after: ''}), page, 'same reference on read ACK recovery');
    await assert.rejects(access.command({action: 'apply', reference: work.reference,
      scope: {domain: 'board', resourceId: 'other'}, snapshot: {state: 'unavailable'}}));
    const client = await f.current().resolver.nativeFileBackground!(access, work.reference);
    await assert.rejects(client.json('/users'), /does not authorize this operation/);
    await f.ok({...f.scope, action: 'revoke', bindingId: id});
    assert.deepEqual(await access.command({action: 'current', reference: work.reference}), {action: 'current', reference: work.reference, current: false});
    await assert.rejects(client.json('/workspace/board-files'), error => error instanceof AuthPersistenceError
      || error instanceof Error && /unavailable|changed/i.test(error.message));
    await assert.rejects(access.command({action: 'closed', reference: work.reference}));
    assert.deepEqual(await access.command({action: 'release', reference: work.reference}), {action: 'release', reference: work.reference});
    assert.deepEqual(await access.command({action: 'release', reference: work.reference}), {action: 'release', reference: work.reference});
    assert.equal(f.calls.install, 1); assert.equal(f.calls.write, 0);
  });
  for (const change of ['node', 'authority', 'incarnation'] as const) {
    test(`${mode}: ${change} replacement cannot resurrect a pinned private reference`, async t => {
      const f = await asyncNativeFileFixture(t, mode), id = randomUUID();
      await (await f.begin()).bind({requestId: id, sessionId: f.sessionId, revision: f.revision});
      const access = f.current().backgroundAccess, page = await access.command({action: 'scan', after: ''});
      assert.equal(page.action, 'scan'); if (page.action !== 'scan') return;
      const work = page.work[0]!;
      f.sql(change === 'node' ? "UPDATE env_connections SET node_id='replaced' WHERE id='local'"
        : change === 'authority' ? "UPDATE env_connections SET authority_version=authority_version+1 WHERE id='local'"
        : "UPDATE users SET created_at=created_at+1 WHERE id='default'");
      assert.deepEqual(await access.command({action: 'current', reference: work.reference}), {action: 'current', reference: work.reference, current: false});
      await assert.rejects(access.command({action: 'access', reference: work.reference}));
      await assert.rejects(access.command({action: 'apply', reference: work.reference, scope: f.scope, snapshot: {state: 'unavailable'}}));
      // Scan prunes invalid references. A new incarnation cannot reclaim an
      // old capability, even if it later acquires an independently valid one.
      await access.command({action: 'scan', after: ''});
      await assert.rejects(access.command({action: 'access', reference: work.reference}));
    });
  }
  test(`${mode}: unavailable retains last good projection and closed only revokes exact binding`, async t => {
    const f = await asyncNativeFileFixture(t, mode), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision});
    await port.writable(); const before = await f.document(id);
    const access = f.current().backgroundAccess, page = await access.command({action: 'scan', after: ''});
    if (page.action !== 'scan') throw Error('wrong page'); const work = page.work[0]!;
    assert.equal((await access.command({action: 'apply', reference: work.reference, scope: f.scope, snapshot: {state: 'unavailable'}})).action, 'apply');
    assert.deepEqual(await f.document(id), before);
    assert.equal((await port.get(id)).state, 'active');
    await access.command({action: 'closed', reference: work.reference});
    assert.equal((await port.get(id)).state, 'revoked'); assert.equal(f.calls.remove, 0);
    assert.deepEqual(await access.command({action: 'current', reference: work.reference}), {action: 'current', reference: work.reference, current: false});
  });
  test(`${mode}: runner recovers a lost original scan ACK without reinstalling or writing`, {timeout: 20_000}, async t => {
    const f = await asyncNativeFileFixture(t, mode), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision});
    const applied = deferredNative(); let first = true;
    f.hooks.backgroundAck = command => {
      if (command.action === 'scan' && first) {first = false; throw Error('PRIVATE_LOST_SCAN_ACK');}
      if (command.action === 'apply' && command.snapshot.state === 'ready') applied.resolve();
    };
    const {background} = f.current(); await assert.rejects(background.syncTick());
    await background.syncTick(); await applied.promise; await background.close();
    assert.equal(f.calls.install, 1); assert.equal(f.calls.write, 0);
  });
}

for (const frame of ['unrequested', 'malformed'] as const) test(`background ${frame} frame never applies content and broken diagnostics cannot interrupt cleanup`, async () => {
  const reference = randomUUID(), bindingId = randomUUID(), work: NativeFileBackgroundWork = {
    reference, bindingId, domain: 'board', resourceId: 'default', group: randomUUID(),
  };
  const entered = deferredNative(), release = deferredNative(); let applied = 0, released = 0;
  const access = new AsyncNativeFileBackgroundAccess({command: async command => {
    if (command.action === 'scan') return {action: 'scan', cursor: '', work: [work]};
    if (command.action === 'current') return {...command, current: true};
    if (command.action === 'apply') {
      assert.equal(command.snapshot.state, 'unavailable'); applied++; entered.resolve(); await release.promise;
      return {action: 'apply', reference, applied: 'retained'};
    }
    if (command.action === 'release') {released++; return command;}
    throw Error('unexpected command');
  }});
  const client = {async *fileBoardEvents() {
    yield {event: 'board-file.snapshot', data: frame === 'malformed' ? '{' : JSON.stringify({id: randomUUID(), snapshot: {state: 'missing'}})};
  }, async *fileCardEvents() {assert.fail('wrong domain');}};
  const diagnostics = {start() {throw Error('PRIVATE_BROKEN_DIAGNOSTIC');}} as unknown as PerformanceDiagnostics;
  const runner = new AsyncNativeFileBackground(access, async () => client as unknown as ConnectorClient, diagnostics);
  try {
    await runner.syncTick(); await entered.promise;
    let closed = false; const closing = runner.close().then(() => {closed = true;});
    await turn(); assert.equal(closed, false); release.resolve(); await closing;
    assert.equal(applied, 1); assert.equal(released, 1);
    await assert.rejects(access.command({action: 'current', reference}));
  } finally {release.resolve(); await runner.close();}
});

test('background close attempts every reference release despite an original failure, then retires its lane', async () => {
  const works: NativeFileBackgroundWork[] = [0, 1].map(() => ({reference: randomUUID(), bindingId: randomUUID(), domain: 'board', resourceId: 'default', group: randomUUID()}));
  const releases: string[] = [], entered = deferredNative(), release = deferredNative();
  const access = new AsyncNativeFileBackgroundAccess({command: async command => {
    if (command.action === 'scan') return {action: 'scan', cursor: '', work: works};
    if (command.action === 'current') return {...command, current: true};
    if (command.action === 'apply') {entered.resolve(); await release.promise; return {action: 'apply', reference: command.reference, applied: 'retained'};}
    if (command.action === 'release') {releases.push(command.reference); if (releases.length === 1) throw Error('PRIVATE_RELEASE_FAILURE'); return command;}
    throw Error('unexpected command');
  }});
  const runner = new AsyncNativeFileBackground(access, async () => {throw Error('PRIVATE_OFFLINE');}, new PerformanceDiagnostics(() => {}));
  await runner.syncTick(); await entered.promise;
  const closing = runner.close(); const failed = assert.rejects(closing, AggregateError); release.resolve(); await failed;
  assert.deepEqual(releases.sort(), works.map(w => w.reference).sort());
  await assert.rejects(access.command({action: 'scan', after: ''}));
});

test('private native file validators reject extra identity, forged replies and overfull work pages', () => {
  const reference = randomUUID(), work: NativeFileBackgroundWork = {reference, domain: 'board', resourceId: 'default', bindingId: randomUUID(), group: randomUUID()};
  assert.equal(validNativeFileBackgroundCommand({action: 'scan', after: '', user: 'default'}), false);
  assert.equal(validNativeFileBackgroundCommand({action: 'apply', reference, scope: {domain: 'board', resourceId: 'default'}, snapshot: {state: 'ready', value: {}}}), false);
  assert.equal(validNativeFileBackgroundResult({action: 'scan', cursor: '', work: Array(5).fill(work)}), false);
  assert.equal(validNativeFileBackgroundResult({action: 'access', reference, domain: 'board', connection: {}, epoch: 1, token: 'PRIVATE'}), false);
});

test('private ACK lane copies inputs, rejects mismatched replies and close waits for admitted work', async () => {
  const entered = deferredNative(), release = deferredNative(), reference = randomUUID();
  const lane = new AsyncNativeFileBackgroundAccess({command: async command => {
    entered.resolve(); await release.promise;
    return {action: command.action, reference} as NativeFileBackgroundResult;
  }});
  const command = {action: 'release' as const, reference};
  const pending = lane.command(command); command.reference = randomUUID();
  await entered.promise; let closed = false; const close = lane.close().then(() => {closed = true;});
  await turn(); assert.equal(closed, false); await assert.rejects(lane.command(command));
  release.resolve(); assert.deepEqual(await pending, {action: 'release', reference}); await close;
  const forged = new AsyncNativeFileBackgroundAccess({command: async () => ({action: 'release', reference: randomUUID()})});
  await assert.rejects(forged.command({action: 'release', reference})); await forged.close();
});

for (const domain of ['board', 'card'] as const) test(`${domain}: Connector file heartbeat performs no authority query, business frame still does`, async () => {
  let checks = 0;
  const client = new ConnectorClient('http://connector', 'synthetic', () => new Response(
    'event: heartbeat\ndata: {}\n\nevent: heartbeat\ndata: {}\n\nevent: board-file.snapshot\ndata: {}\n\n',
    {headers: {'content-type': 'text/event-stream', [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max)}}),
    undefined, undefined, {authorize: () => {checks++;}});
  const controller = new AbortController(), ids = [randomUUID()];
  const stream = domain === 'board' ? client.fileBoardEvents(ids, controller.signal) : client.fileCardEvents(ids, controller.signal);
  assert.equal((await stream.next()).value?.event, 'heartbeat'); const opened = checks; assert.ok(opened > 0);
  assert.equal((await stream.next()).value?.event, 'heartbeat'); assert.equal(checks, opened);
  await stream.next(); assert.equal(checks, opened + 1);
  controller.abort(); await stream.return();
});

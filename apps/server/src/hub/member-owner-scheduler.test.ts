import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HubMemberOwnerScheduler } from './member-owner-scheduler.js';

function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
const tick = () => new Promise<void>(done => setImmediate(done));
test('pending original verifier yields to revocation and Hub work; close drains all accepted work', async () => {
  const scheduler = new HubMemberOwnerScheduler(), verifier = gate(), hub = gate(), events: string[] = [];
  let authorized = true;
  const verification = scheduler.schedule('auth', async () => {
    events.push('verify-start'); await verifier.promise; events.push(authorized ? 'invalid-grant' : 'verify-revoked');
  });
  const hub1 = scheduler.schedule('hub', async () => { events.push('hub1'); await hub.promise; });
  const hub2 = scheduler.schedule('hub', async () => { events.push('hub2'); });
  const revoke = scheduler.schedule('auth', async () => { authorized = false; events.push('revoke'); });
  const close = scheduler.schedule('close', async () => { events.push('close'); });
  assert.throws(() => scheduler.schedule('auth', async () => {}));
  assert.throws(() => scheduler.schedule('hub', async () => {}));
  await revoke; await tick(); assert.deepEqual(events, ['verify-start', 'hub1', 'revoke']);
  hub.release(); await hub1; await hub2; assert.equal(events.includes('close'), false);
  verifier.release(); await verification; await close;
  assert.deepEqual(events, ['verify-start', 'hub1', 'revoke', 'hub2', 'verify-revoked', 'close']);
});
test('original close still runs after rejected work without admitting replacement or replay', async () => {
  const scheduler = new HubMemberOwnerScheduler(), gate1 = gate(), events: string[] = [];
  const failed = scheduler.schedule('hub', async () => { events.push('original'); await gate1.promise; throw Error('isolated'); });
  const rejection = assert.rejects(failed);
  const independent = scheduler.schedule('auth', async () => { events.push('auth'); });
  const close = scheduler.schedule('close', async () => { events.push('close-both'); });
  await independent; assert.deepEqual(events, ['original', 'auth']);
  gate1.release(); await rejection; await close;
  assert.deepEqual(events, ['original', 'auth', 'close-both']);
});

test('configuration barrier drains both lanes and holds later Auth/Hub work until original ACK', async () => {
  const scheduler = new HubMemberOwnerScheduler(), auth = gate(), hub = gate(), ack = gate(), events: string[] = [];
  const firstAuth = scheduler.schedule('auth', async () => { events.push('auth'); await auth.promise; });
  const firstHub = scheduler.schedule('hub', async () => { events.push('hub'); await hub.promise; });
  const barrier = scheduler.schedule('barrier', async () => { events.push('update'); await ack.promise; });
  const laterAuth = scheduler.schedule('auth', async () => { events.push('later-auth'); });
  const laterHub = scheduler.schedule('hub', async () => { events.push('later-hub'); });
  const close = scheduler.schedule('close', async () => { events.push('close'); });
  await tick(); assert.deepEqual(events, ['auth', 'hub']);
  auth.release(); await firstAuth; await tick(); assert.deepEqual(events, ['auth', 'hub']);
  hub.release(); await firstHub; await tick(); assert.deepEqual(events, ['auth', 'hub', 'update']);
  ack.release(); await Promise.all([barrier, laterAuth, laterHub, close]);
  assert.deepEqual(events, ['auth', 'hub', 'update', 'later-auth', 'later-hub', 'close']);
});

test('rejected barrier fences subsequent lanes but close still drains without retrying update', async () => {
  const scheduler = new HubMemberOwnerScheduler(), events: string[] = [];
  const barrier = scheduler.schedule('barrier', async () => { events.push('update'); throw Error('unknown'); });
  const auth = scheduler.schedule('auth', async () => { events.push('invalid-auth'); });
  const hub = scheduler.schedule('hub', async () => { events.push('invalid-hub'); });
  const failures = [barrier, auth, hub].map(work => assert.rejects(work));
  const close = scheduler.schedule('close', async () => { events.push('close'); });
  await Promise.all([...failures, close]); assert.deepEqual(events, ['update', 'close']);
});

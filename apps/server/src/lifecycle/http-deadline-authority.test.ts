import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as nativeSetTimeout } from 'node:timers';
import { SessionReadAuthority } from '../auth/session-read-authority.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { awaitHttpAdmission, controlledHttpDeadline } from './http-deadline-test-support.js';

const realTimer = nativeSetTimeout;
const silence = new PerformanceDiagnostics(() => {});
function gate() { let release!: () => void; return { promise: new Promise<void>(ok => { release = ok; }), release: () => release() }; }

test('actual authority may expire before physical effect admission, barrier fails instead of hanging', async t => {
  const authEntered = gate(), authHeld = gate(), physicalEntered = gate(); let effects = 0;
  const authority = new SessionReadAuthority(async () => {
    authEntered.release(); await authHeld.promise; return 'original';
  }, silence, 20);
  const clock = controlledHttpDeadline(t);
  const response = authority.run(new Request('http://localhost/original'), () => {
    effects++; physicalEntered.release(); return new Response('original');
  });
  try {
    await awaitHttpAdmission(authEntered.promise, response, 'original authorization');
    assert.equal((await clock.expire(20, response)).status, 503);
    await assert.rejects(awaitHttpAdmission(physicalEntered.promise, response), /before admission \(503\)/);
    assert.equal(effects, 0); assert.equal(authority.pending, 1);
    let drained = false; const closing = authority.close().then(() => { drained = true; });
    await new Promise<void>(ok => setImmediate(ok)); assert.equal(drained, false);
    authHeld.release(); await closing;
    assert.equal(effects, 0); assert.equal(authority.pending, 0);
  } finally { clock.restore(); authHeld.release(); await authority.close(); }
});

test('actual authority controlled original deadline retains real admission, execution and close semantics', async t => {
  const entered = gate(), held = gate(); let actors = 0, effects = 0;
  const authority = new SessionReadAuthority(async () => {
    actors++; await new Promise<void>(ok => realTimer(ok, 30)); return 'original';
  }, silence, 10);
  const clock = controlledHttpDeadline(t);
  const response = authority.run(new Request('http://localhost/original'), async () => {
    effects++; entered.release(); await held.promise; return new Response('original');
  });
  try {
    await awaitHttpAdmission(entered.promise, response);
    assert.equal(effects, 1); assert.equal(actors, 1);
    assert.equal((await clock.expire(10, response)).status, 503);
    assert.equal(authority.pending, 1);
    let drained = false; const closing = authority.close().then(() => { drained = true; });
    await new Promise<void>(ok => setTimeout(ok, 1)); assert.equal(drained, false);
    held.release(); await closing;
    assert.equal(effects, 1); assert.equal(actors, 1); assert.equal(authority.pending, 0);
  } finally { clock.restore(); held.release(); await authority.close(); }
});

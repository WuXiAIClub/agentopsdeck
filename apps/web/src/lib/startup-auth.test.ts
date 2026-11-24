import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readStartupAuth, type StartupAuthStatus } from './startup-auth.js';

const active = () => new AbortController();
test('startup accepts literal authenticated status and preserves the original account recovery scope', async () => {
  const status = { authenticated: true, recoveryScope: 'a'.repeat(64) };
  const controller = active(); let calls = 0;
  const result = await readStartupAuth(async signal => { calls++; assert.equal(signal, controller.signal); return status; }, controller.signal);
  assert.deepEqual(result, status); assert.notEqual(result, status); assert.equal(calls, 1);
});
test('legacy status without a recovery scope and confirmed sign-out remain compatible', async () => {
  for (const authenticated of [false, true])
    assert.deepEqual(await readStartupAuth(async () => ({ authenticated }), active().signal), { authenticated });
});
test('a temporary read failure remains a failure, never a fabricated sign-out or a retry', async () => {
  let calls = 0; const error = new Error('PRIVATE storage failure');
  await assert.rejects(readStartupAuth(async () => { calls++; throw error; }, active().signal), error);
  assert.equal(calls, 1);
});
test('pre-cancelled startup read never dispatches', async () => {
  const controller = active(); controller.abort(); let calls = 0;
  assert.equal(await readStartupAuth(async () => { calls++; return { authenticated: true }; }, controller.signal), undefined);
  assert.equal(calls, 0);
});
test('cancelled stale response cannot choose an account even when transport ignores abort', async () => {
  const controller = active(); let resolve!: (value: StartupAuthStatus) => void;
  const result = readStartupAuth(() => new Promise(accept => { resolve = accept; }), controller.signal);
  controller.abort(); resolve({ authenticated: true, recoveryScope: 'b'.repeat(64) });
  assert.equal(await result, undefined);
});
test('malformed or truthy status is not permission to unlock', async () => {
  for (const status of [null, {}, { authenticated: 'true' }, { authenticated: 1 },
    { authenticated: true, recoveryScope: 'invalid' }, { authenticated: true, recoveryScope: {} }]) {
    await assert.rejects(readStartupAuth(async () => status as StartupAuthStatus, active().signal), /Invalid authentication status/);
  }
});
test('bootstrap reads, revocation invalidation and lazy login are wired without implicit destructive recovery', () => {
  const component = readFileSync(new URL('src/components/StartupAuth.tsx', `file://${process.cwd()}/`), 'utf8');
  const main = readFileSync(new URL('src/main.tsx', `file://${process.cwd()}/`), 'utf8');
  assert.match(component, /api\.authStatus\(signal\)/);
  assert.match(component, /return \(\) => \{ controller\.abort\(\); window\.removeEventListener/);
  assert.match(component, /agentopsdeck:auth-required/);
  assert.doesNotMatch(component, /logout|loginWithAccessKey|forgetStoredAccessKey|clearAllCachedData|location\.reload/);
  assert.match(main, /lazy\(\(\) => import\('\.\/components\/auth'\)/);
  assert.doesNotMatch(main, /import \{[^\n]*UnlockScreen[^\n]*\} from '\.\/components\/auth'/);
  assert.match(component, /document\.documentElement\.dataset\.osDesktopImmersive === 'true'/);
  assert.match(main, /document\.documentElement\.dataset\.osDesktopImmersive === 'true'\s*\?\s*<OsPowerBootFallback[^>]*progress="18%"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyOriginalRequest, originalRequestScope, pinOriginalRequestScope } from './original-request-scope.js';

test('original request copy retains private scope and cancellation by default', () => {
  const controller = new AbortController();
  const request = new Request('http://hub.invalid/private', { signal: controller.signal });
  pinOriginalRequestScope(request, 'private-scope');
  const copied = copyOriginalRequest(request);
  assert.equal(originalRequestScope(copied), 'private-scope');
  controller.abort();
  assert.equal(copied.signal.aborted, true);
});

test('detaching lease lifetime preserves private authority without inheriting HTTP cancellation', () => {
  const controller = new AbortController();
  const request = new Request('http://hub.invalid/private', { signal: controller.signal });
  pinOriginalRequestScope(request, 'private-scope');
  const copied = copyOriginalRequest(request, { signal: null });
  controller.abort();
  assert.equal(copied.signal.aborted, false);
  assert.equal(originalRequestScope(copied), 'private-scope');
  assert.throws(() => pinOriginalRequestScope(copied, 'replacement'), /scope_changed/);
});

test('caller-controlled headers cannot supply a private original-request scope', () => {
  const request = new Request('http://hub.invalid/private', { headers: { 'x-agentopsdeck-original-scope': 'forged' } });
  assert.equal(originalRequestScope(copyOriginalRequest(request, { signal: null })), undefined);
});

test('live copied request retains ephemeral cancellation sources across forced GC without attaching detached leases', () => {
  const loader = import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
  const moduleUrl = new URL('./original-request-scope.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    const {copyOriginalRequest, originalRequestScope, pinOriginalRequestScope} = await import(${JSON.stringify(moduleUrl)});
    const root = new AbortController();
    function copies() {
      const source = new Request('http://hub.invalid/', {signal: root.signal});
      pinOriginalRequestScope(source, 'private-scope');
      return {live: copyOriginalRequest(copyOriginalRequest(source)),
        detached: copyOriginalRequest(source, {signal: null})};
    }
    const {live, detached} = copies();
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
      globalThis.gc();
    }
    assert.equal(live.signal.aborted, false);
    root.abort();
    assert.equal(live.signal.aborted, true);
    assert.equal(detached.signal.aborted, false);
    assert.equal(originalRequestScope(live), 'private-scope');
    assert.equal(originalRequestScope(detached), 'private-scope');
    console.log('request-gc-chain-ok');
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', ...loader, '--input-type=module', '-e', script],
    {encoding: 'utf8', timeout: 15_000});
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'request-gc-chain-ok');
});

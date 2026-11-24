import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test configuration only. No provider credentials or live data paths are read.
export function permissionsJointMode(args) {
  const fixtureFlags = args.filter(value => value === '--provider-fixture');
  assert.ok(fixtureFlags.length <= 1, 'Duplicate provider fixture flag');
  const providerFixture = fixtureFlags.length === 1;
  args = args.filter(value => value !== '--provider-fixture');
  const browserFlags = args.filter(value => value.startsWith('--browser-'));
  args = args.filter(value => !value.startsWith('--browser-'));
  let browser;
  if (browserFlags.length) {
    assert.equal(browserFlags.length, 2, 'Pass both explicit browser module and executable');
    const options = Object.fromEntries(browserFlags.map(value => {
      const split = value.indexOf('=');
      assert.ok(split > 0);
      return [value.slice(0, split), value.slice(split + 1)];
    }));
    assert.deepEqual(Object.keys(options).sort(), ['--browser-executable', '--browser-module']);
    assert.ok(isAbsolute(options['--browser-module']) && isAbsolute(options['--browser-executable']));
    browser = { module: options['--browser-module'], executable: options['--browser-executable'] };
  }
  assert.ok([1, 2, 4].includes(args.length), 'Usage: CODEx [CANDIDATE [MODEL LOOPBACK_PROVIDER_ORIGIN]]');
  if (providerFixture) assert.equal(args.length, 4, 'Provider fixture requires a sealed candidate and explicit loopback provider');
  const [command, candidateRoot, model, inputOrigin] = args;
  assert.ok(command && isAbsolute(command), 'Pass an absolute installed Codex executable');
  if (candidateRoot !== undefined) assert.ok(candidateRoot && isAbsolute(candidateRoot), 'Use an absolute sealed candidate');
  if (browser) assert.ok(candidateRoot, 'Browser acceptance requires a sealed candidate');
  let providerOrigin;
  if (model !== undefined) {
    assert.match(model, /^[a-zA-Z0-9._-]{1,100}$/);
    const url = new URL(inputOrigin);
    assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'Only an explicit credential-free loopback provider origin is supported');
    providerOrigin = url.origin;
  }
  return { command, candidateRoot, model, providerOrigin, realModel: model !== undefined && !providerFixture,
    ...(providerFixture ? { providerFixture: true } : {}), ...(browser ? { browser } : {}) };
}

export function candidateJointModule(candidateRoot, specifier) {
  assert.ok(candidateRoot && isAbsolute(candidateRoot));
  assert.match(specifier, /^\.\.\/apps\/server\/src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.ts$/);
  return pathToFileURL(join(candidateRoot, 'apps/server/dist', specifier.slice('../apps/server/src/'.length).replace(/\.ts$/, '.js'))).href;
}

export function jointModelMessage(ordinal, realModel) {
  assert.ok(Number.isSafeInteger(ordinal) && ordinal > 0 && ordinal <= 6);
  return realModel
    ? `This is an isolated permissions acceptance test. Reply with exactly JOINT_REPLY_${ordinal} and no other text. Do not use tools, read files, or follow earlier reply markers.`
    : 'Report isolated progress. Do not use tools or access files.';
}

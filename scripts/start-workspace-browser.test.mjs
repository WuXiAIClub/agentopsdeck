import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runtimeOptions } from './start-workspace-browser.mjs';
import { buildStreamFrameState, streamLaunchOptions, writeAtomicJson } from './playwright-browser-stream-daemon.mjs';
test('runtime launcher is explicit, non-root, loopback-only and never disables Chromium sandbox', () => {
  assert.throws(() => runtimeOptions({}, 1000));
  assert.throws(() => runtimeOptions({ AOD_BROWSER_EGRESS_ISOLATED: 'true' }, 0));
  const env = { AOD_BROWSER_EGRESS_ISOLATED: 'true' };
  assert.deepEqual(runtimeOptions(env, 1000), { headless: true, chromiumSandbox: true, host: '127.0.0.1', port: 9324, wsPath: '/agentopsdeck-browser' });
  for (const port of ['0', '-1', '80', '1234.5', '65536', 'NaN']) assert.throws(() => runtimeOptions({ ...env, AOD_BROWSER_RUNTIME_PORT: port }, 1000));
});

test('stream daemon uses the same explicit isolation and sandbox admission before launching', () => {
  const executable = '/fixture/chromium';
  const environment = { AOD_BROWSER_EGRESS_ISOLATED: 'true' };
  assert.throws(() => streamLaunchOptions(executable, {}, 1000));
  for (const uid of [0, -1, null, NaN]) {
    assert.throws(() => streamLaunchOptions(executable, environment, uid));
  }
  for (const value of [undefined, '', 'relative/chromium']) {
    assert.throws(() => streamLaunchOptions(value, environment, 1000));
  }
  const options = streamLaunchOptions(executable, environment, 1000);
  assert.equal(options.executablePath, executable);
  assert.equal(options.headless, true);
  assert.equal(options.chromiumSandbox, true);
  assert.equal(options.args.some(argument => /sandbox/.test(argument)), false);
});

test('writeAtomicJson enforces 0700 directory and 0600 file permissions, rejects symlinks and propagates errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-stream-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const outDir = join(root, 'nested/browser-stream');
  const stateFile = join(outDir, 'state.json');
  await writeAtomicJson(stateFile, { ok: true, status: 'streaming' });

  const dirMode = (await stat(outDir)).mode & 0o777;
  const fileMode = (await stat(stateFile)).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { ok: true, status: 'streaming' });

  await chmod(stateFile, 0o644);
  await writeAtomicJson(stateFile, { ok: true, status: 'streaming', seq: 2 });
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);

  const symlinkTarget = join(root, 'outside.json');
  await writeFile(symlinkTarget, '{}');
  const symlinkPath = join(outDir, 'link-state.json');
  await symlink(symlinkTarget, symlinkPath);
  await assert.rejects(writeAtomicJson(symlinkPath, { ok: true }), /symbolic link/);
  await assert.rejects(writeAtomicJson('relative/state.json', { ok: true }), /Absolute target path/);
});

function acceptsWorkspaceStreamFrame(data) {
  return Boolean(
    data
      && typeof data.status === 'string'
      && typeof data.url === 'string'
      && typeof data.title === 'string'
      && Number.isFinite(data.width)
      && data.width > 0
      && Number.isFinite(data.height)
      && data.height > 0
      && (data.error == null || typeof data.error === 'string')
      && (data.canGoBack === undefined || typeof data.canGoBack === 'boolean')
      && (data.canGoForward === undefined || typeof data.canGoForward === 'boolean')
      && (data.frameDataUrl === undefined || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data.frameDataUrl)),
  );
}

test('buildStreamFrameState emits WorkspaceOsDesktop-compatible status contract for streaming and error frames', () => {
  const frame = buildStreamFrameState({
    seq: '1',
    frameSeq: 1,
    updatedAt: 1700000000000,
    url: 'https://example.com',
    title: 'Example Domain',
    viewportMode: 'desktop',
    width: 1280,
    height: 720,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    frameDataUrl: `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`,
  });
  assert.equal(frame.ok, true);
  assert.equal(frame.status, 'streaming');
  assert.equal(acceptsWorkspaceStreamFrame(frame), true);

  const errorFrame = buildStreamFrameState({
    seq: '2',
    frameSeq: 2,
    updatedAt: 1700000001000,
    url: 'about:home',
    title: 'Cloud Browser',
    viewportMode: 'desktop',
    width: 1280,
    height: 720,
    canGoBack: false,
    canGoForward: false,
    extra: { error: 'navigation timeout' },
  });
  assert.equal(errorFrame.ok, false);
  assert.equal(errorFrame.status, 'error');
  assert.equal(acceptsWorkspaceStreamFrame(errorFrame), true);
});

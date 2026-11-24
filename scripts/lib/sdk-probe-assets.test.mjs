import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sdkProbeFiles, sdkProbeHttpModule, verifySdkProbeAssets } from './sdk-probe-assets.mjs';

async function fixture(t, omitted) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-sdk-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'detached-operation');
  const compiled = join(root, 'release/apps/server/dist');
  await mkdir(join(scripts, 'lib'), { recursive: true });
  await mkdir(compiled, { recursive: true });
  for (const file of sdkProbeFiles) if (file !== omitted) await writeFile(join(scripts, file), '');
  const dependency = join(compiled, '../node_modules/@hono/node-server');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ main: 'index.js' }));
  await writeFile(join(dependency, 'index.js'), 'exports.serve = () => {};');
  return { scripts, compiled, dependency };
}

test('SDK bundle preflight rejects a missing fork host before any process or credential access', async t => {
  const { scripts, compiled } = await fixture(t, 'lib/sdk-service-host.mjs');
  await assert.rejects(verifySdkProbeAssets(scripts, compiled), /Incomplete SDK probe bundle: lib\/sdk-service-host/);
});

test('SDK inventory includes the candidate verifier imported by both entrypoints', async t => {
  const { scripts, compiled } = await fixture(t, 'stage-candidate-release.mjs');
  await assert.rejects(verifySdkProbeAssets(scripts, compiled), /Incomplete SDK probe bundle: stage-candidate-release/);
});

test('SDK bundle preflight also includes the worker --import telemetry', async t => {
  const { scripts, compiled } = await fixture(t, 'lib/sdk-probe-stream-shapes.mjs');
  await assert.rejects(verifySdkProbeAssets(scripts, compiled), /Incomplete SDK probe bundle: lib\/sdk-probe-stream-shapes/);
});

test('a detached maintenance bundle resolves HTTP dependencies from the candidate', async t => {
  const { scripts, compiled, dependency } = await fixture(t);
  await verifySdkProbeAssets(scripts, compiled);
  assert.equal(sdkProbeHttpModule(compiled), join(dependency, 'index.js'));
});

test('SDK bundle preflight rejects a candidate without its HTTP runtime dependency', async t => {
  const { scripts, compiled, dependency } = await fixture(t);
  await rm(dependency, { recursive: true });
  assert.throws(() => sdkProbeHttpModule(compiled), { code: 'MODULE_NOT_FOUND' });
  await assert.rejects(verifySdkProbeAssets(scripts, compiled), { code: 'MODULE_NOT_FOUND' });
});

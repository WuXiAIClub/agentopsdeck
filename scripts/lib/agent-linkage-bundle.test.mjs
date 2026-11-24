import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentLinkageFiles, stageAgentLinkageBundle, verifyAgentLinkageBundle } from './agent-linkage-bundle.mjs';
const source = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-linkage-bundle-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  await stageAgentLinkageBundle(source, bundle);
  return { root, bundle };
}

test('detached bundle includes all static and worker assets with exact hashes', async t => {
  const { bundle } = await fixture(t);
  const proof = await verifyAgentLinkageBundle(bundle);
  assert.equal(proof.files, agentLinkageFiles.length);
  assert.ok(agentLinkageFiles.includes('stage-candidate-release.mjs'));
  assert.ok(agentLinkageFiles.includes('lib/sdk-service-host.mjs'));
  assert.ok(agentLinkageFiles.includes('lib/sdk-probe-stream-shapes.mjs'));
});
for (const name of ['stage-candidate-release.mjs', 'lib/sdk-service-host.mjs', 'lib/sdk-probe-stream-shapes.mjs']) {
  test(`missing ${name} is rejected without executing any probe`, async t => {
    const { bundle } = await fixture(t);
    await rm(join(bundle, name));
    await assert.rejects(verifyAgentLinkageBundle(bundle), /Incomplete acceptance bundle/);
  });
}
test('does not overwrite a previous operation', async t => {
  const { bundle } = await fixture(t);
  const before = await readFile(join(bundle, 'probe-bundle.json'), 'utf8');
  await assert.rejects(stageAgentLinkageBundle(source, bundle), { code: 'EEXIST' });
  assert.equal(await readFile(join(bundle, 'probe-bundle.json'), 'utf8'), before);
});
test('tampered script is rejected', async t => {
  const { bundle } = await fixture(t);
  await writeFile(join(bundle, 'verify-candidate-file-boards.mjs'), '// drift');
  await assert.rejects(verifyAgentLinkageBundle(bundle), /Acceptance bundle drift/);
});
test('new relative import must be added to inventory before staging', async t => {
  const { root, bundle } = await fixture(t);
  await writeFile(join(bundle, 'verify-candidate-file-boards.mjs'), "import './missing-new-helper.mjs';");
  await assert.rejects(stageAgentLinkageBundle(bundle, join(root, 'next')), /Unlisted acceptance dependency/);
});
test('symlinked assets cannot masquerade as bundle files', async t => {
  const { bundle } = await fixture(t);
  const path = join(bundle, 'stage-candidate-release.mjs');
  await rm(path);
  await symlink(join(source, 'stage-candidate-release.mjs'), path);
  await assert.rejects(verifyAgentLinkageBundle(bundle), /Incomplete acceptance bundle/);
});

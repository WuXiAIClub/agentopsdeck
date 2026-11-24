import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createUpgradeProfile, validateUpgradeProfile, renderUpgradeProfiles } from './windows-upgrade-profiles.mjs';

function profile(id = 'inno-fixture') {
  return { schema: 1, id, version: '2.4.8', installerSha256: 'a'.repeat(64), sourceRevision: 'b'.repeat(40),
    files: ['AgentOpsDeck.exe', 'runtime/node.exe', 'package.json', 'release.json', 'desktop-launcher.cjs', 'lifecycle.cjs']
      .map(path => ({ path, bytes: 1, sha256: 'c'.repeat(64) })) };
}

test('portable upgrades compile separate whole profiles, clearing all previous rows', () => {
  const first = profile('first'), second = profile('second');
  second.files[0].sha256 = 'd'.repeat(64);
  const text = renderUpgradeProfiles([first, second]);
  assert.equal((text.match(/PriorFiles.Clear;/g) ?? []).length, 2);
  assert.equal((text.match(/if MatchesPriorPayload then Exit;/g) ?? []).length, 2);
  assert.match(text, /LoadPortableProfile0;[\s\S]*LoadPortableProfile1;/);
  assert.match(text, /RegStringEquals\(InnoKey, 'DisplayVersion', '2.4.8'\)/);
  assert.equal((text.match(/PriorFiles.Add/g) ?? []).length, 12);
});

for (const path of ['../file', '/file', 'C:/file', 'x\\file', 'x//file', 'x/.env', 'auth.json',
  'credentials/key', 'state.sqlite', 'x/NUL.txt', 'x/file.']) {
  test(`portable profile refuses unsafe or state-bearing path ${path}`, () => {
    const value = profile();
    value.files.push({ path, bytes: 1, sha256: 'a'.repeat(64) });
    assert.throws(() => validateUpgradeProfile(value), /Unsafe/);
  });
}

test('incomplete, aliased, duplicated and oversized catalogs cannot authorize an upgrade', () => {
  const incomplete = profile(); incomplete.files.pop();
  assert.throws(() => validateUpgradeProfile(incomplete), /Incomplete/);
  const alias = profile(); alias.files.push({ ...alias.files[0], path: 'agentopsdeck.exe' });
  assert.throws(() => validateUpgradeProfile(alias), /alias/);
  const large = profile(); large.files[0].bytes = 2 ** 31;
  assert.throws(() => validateUpgradeProfile(large), /bound/);
  assert.throws(() => renderUpgradeProfiles([profile(), profile()]), /Duplicate/);
});

test('createUpgradeProfile enforces pinned regular-file admission, depth bounds and pre-read byte budgets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-win-upgrade-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const installer = join(root, 'AgentOpsDeckSetup.exe');
  const installerContent = Buffer.from('installer-binary-fixture');
  const expectedSha256 = createHash('sha256').update(installerContent).digest('hex');
  await writeFile(installer, installerContent);

  const payload = join(root, 'payload');
  await mkdir(join(payload, 'runtime'), { recursive: true });
  await writeFile(join(payload, 'AgentOpsDeck.exe'), 'launcher');
  await writeFile(join(payload, 'runtime/node.exe'), 'node-runtime');
  await writeFile(join(payload, 'desktop-launcher.cjs'), 'module.exports = {};');
  await writeFile(join(payload, 'lifecycle.cjs'), 'module.exports = {};');
  await writeFile(join(payload, 'package.json'), JSON.stringify({ name: 'agentopsdeck', version: '1.0.0' }));
  await writeFile(join(payload, 'release.json'), JSON.stringify({
    version: '1.0.0',
    sourceRevision: 'b'.repeat(40),
  }));

  const valid = await createUpgradeProfile({ installer, payload, expectedSha256, id: 'valid-1.0.0' });
  assert.equal(valid.id, 'valid-1.0.0');
  assert.equal(valid.files.length, 6);

  await assert.rejects(
    createUpgradeProfile({ installer, payload, expectedSha256, id: 'budget-fail', maxPayloadBytes: 24 }),
    /exceeds payload bound/,
  );

  const deepDir = join(payload, 'd1/d2/d3/d4');
  await mkdir(deepDir, { recursive: true });
  await writeFile(join(deepDir, 'leaf.txt'), 'leaf');
  await assert.rejects(
    createUpgradeProfile({ installer, payload, expectedSha256, id: 'depth-fail', maxDirectoryDepth: 2 }),
    /exceeds directory depth bound/,
  );
  await rm(join(payload, 'd1'), { recursive: true, force: true });

  const symPath = join(payload, 'sym.txt');
  await symlink(join(payload, 'AgentOpsDeck.exe'), symPath);
  await assert.rejects(
    createUpgradeProfile({ installer, payload, expectedSha256, id: 'symlink-fail' }),
    /Unsupported payload object/,
  );
  await rm(symPath, { force: true });

  const hardlinkPath = join(payload, 'hardlink.txt');
  await link(join(payload, 'AgentOpsDeck.exe'), hardlinkPath);
  await assert.rejects(
    createUpgradeProfile({ installer, payload, expectedSha256, id: 'hardlink-fail' }),
    /Unbounded or linked payload/,
  );
  await rm(hardlinkPath, { force: true });
});

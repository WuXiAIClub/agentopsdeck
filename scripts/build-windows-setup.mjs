import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, copyFile, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stageCandidateRelease, verifyCandidateRelease } from './stage-candidate-release.mjs';
import { renderUpgradeProfiles, validateUpgradeProfile } from './windows-upgrade-profiles.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pascal = text => "'" + text.replaceAll("'", "''") + "'";
async function inventory(root_, prefix = '') {
  const rows = [];
  for (const entry of (await readdir(join(root_, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    const file = join(root_, name), stat = await lstat(file);
    assert.ok(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'Unsupported installer object');
    if (stat.isDirectory()) rows.push(...await inventory(root_, name));
    else {
      assert.equal(stat.nlink, 1, 'Linked installer file');
      const bytes = await readFile(file);
      rows.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  return rows;
}
function execute(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, 'Build tool failed: ' + executable + '\n' + result.stdout + result.stderr);
  return result.stdout.trim();
}
export async function buildWindowsSetup({ runtimeRoot, nativeRoot, compiler, output, revision = 19 }) {
  assert.equal(process.platform, 'win32', 'Run packaging and its verification on Windows');
  for (const file of [runtimeRoot, nativeRoot, compiler, output]) assert.ok(isAbsolute(file), 'Absolute paths required');
  assert.ok(output.length < 85, 'Use a short output directory for Inno source path limits');
  assert.ok(Number.isInteger(revision) && revision > 0 && revision < 65536);
  const source = execute('git', ['rev-parse', 'HEAD']);
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(execute('git', ['status', '--porcelain', '--untracked-files=normal']), '', 'Freeze and commit all source before packaging');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  await mkdir(output);
  const payload = join(output, 'payload'), generated = join(output, 'generated'), packaging = join(output, 'packaging');
  await Promise.all([mkdir(generated), mkdir(packaging)]);
  await stageCandidateRelease({ root, destination: payload });
  await verifyCandidateRelease(payload);
  const candidate = JSON.parse(await readFile(join(payload, 'candidate-manifest.json'), 'utf8'));
  await unlink(join(payload, 'candidate-manifest.json'));
  const profileDirectory = join(root, 'native', 'windows', 'installer', 'upgrade-profiles');
  const profiles = [];
  for (const name of (await readdir(profileDirectory)).filter(name => name.endsWith('.json')).sort()) {
    profiles.push(validateUpgradeProfile(JSON.parse(await readFile(join(profileDirectory, name), 'utf8'))));
  }
  const node = join(runtimeRoot, 'runtime', 'node.exe'), nodeBytes = await readFile(node);
  assert.ok(profiles.some(profile => profile.files.some(file => file.path === 'runtime/node.exe' && file.sha256 === sha(nodeBytes))),
    'Runtime must match an independently catalogued vendor binary');
  const version = execute(node, ['--version']);
  for (const name of await readdir(nativeRoot)) {
    if (name === 'AgentOpsDeck.exe' || name.endsWith('.cjs') && !name.includes('.test.')) await copyFile(join(nativeRoot, name), join(payload, name));
  }
  for (const required of ['AgentOpsDeck.exe', 'cli.cjs', 'desktop-launcher.cjs', 'lifecycle.cjs']) {
    assert.ok((await lstat(join(payload, required))).isFile());
  }
  await mkdir(join(payload, 'runtime'), { recursive: true });
  await copyFile(join(nativeRoot, 'runtime', 'private-path-check.exe'), join(payload, 'runtime', 'private-path-check.exe'));
  await copyFile(node, join(payload, 'runtime', 'node.exe'));
  await cp(join(runtimeRoot, 'licenses'), join(payload, 'licenses'), { recursive: true, errorOnExist: true });
  const installerRevision = metadata.version + '.' + revision + '-snapshot-' + source.slice(0, 7);
  const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(payload, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, private: true, type: 'module' }) + '\n');
  await json(join(payload, 'release.json'), { product: 'AgentOpsDeck', version: metadata.version, sourceRevision: source,
    target: 'win32-x64', node: version.slice(1), entry: 'apps/server/dist/index.js', mode: 'all',
    automaticUpdates: false, localInstallerRevision: installerRevision, authenticode: 'unsigned local candidate' });
  const notices = [];
  for (const item of candidate.packages) {
    const package_ = JSON.parse(await readFile(join(payload, item.path, 'package.json'), 'utf8'));
    notices.push(`${item.name}@${item.version}: ${typeof package_.license === 'string' ? package_.license : 'See packaged license texts'}`);
  }
  await writeFile(join(payload, 'THIRD-PARTY-NOTICES.txt'), 'Runtime package notices; license texts remain with their packages.\n'
    + notices.join('\n') + '\nNode.js license notices are preserved under licenses.\n');
  await json(join(payload, 'inventory.json'), await inventory(payload));
  const files = await inventory(payload);
  assert.ok(files.every(file => !/(^|\/)\.env(?:\.|$)|auth\.json$|\.sqlite(?:-|$)|\.agentopsdeck-(install-id|installed|claude-owner|claude-binding)/.test(file.path)));
  await json(join(payload, 'windows-payload-manifest.json'), { format: 1, product: 'AgentOpsDeck', sourceRevision: source,
    standaloneApplicationPayload: true, includesNode: true, includesUserStateOrCredentials: false,
    excludesOwnPath: 'windows-payload-manifest.json', files });
  const finalFiles = await inventory(payload);
  const target = ['procedure LoadKnownFiles;', 'begin', ...finalFiles.map(file =>
    '  KnownFiles.Add(' + pascal(file.path.replaceAll('/', '\\') + '|' + file.sha256) + ');'), 'end;', ''].join('\n');
  await writeFile(join(generated, 'target-files.iss'), target);
  await writeFile(join(generated, 'portable-upgrade-profiles.iss'), renderUpgradeProfiles(profiles));
  const baseline = profiles[0];
  await writeFile(join(generated, 'trusted-baseline.iss'), ['const', "  LegacyId = 'unsupported-legacy';",
    "  LegacyMetadataHash = 'unsupported';", "  LegacyUninstallerHash = 'unsupported';",
    'procedure LoadBaselineFiles;', 'begin', '  PriorFiles.Clear;', ...baseline.files.map(file =>
      '  PriorFiles.Add(' + pascal(file.path.replaceAll('/', '\\') + '|' + file.sha256) + ');'), 'end;', ''].join('\n'));
  for (const number of [9, 10, 11]) await writeFile(join(generated, `prior${number}-files.iss`),
    `procedure LoadPrior${number}Files;\nbegin\n  LoadBaselineFiles;\nend;\n`);
  await writeFile(join(generated, 'trusted-priors.iss'), 'function LoadPriorFiles(Marker: String): Boolean;\nbegin\n  Result := False;\nend;\n');
  await writeFile(join(generated, 'payload-files.iss'), finalFiles.map(file => {
    const name = file.path.replaceAll('/', '\\');
    assert.ok(!/[;"]/.test(name));
    const parent = win32.dirname(name);
    return `Source: "{#PayloadDir}\\${name}"; DestDir: "{app}${parent === '.' ? '' : '\\' + parent}"; Flags: ignoreversion`;
  }).join('\n') + '\n');
  let recipe = await readFile(join(root, 'native', 'windows', 'installer', 'packaging', 'AgentOpsDeck.iss'), 'utf8');
  recipe = '#define PortableUpgradeProfiles\n' + recipe.replace('AppVersion=2.4.6', 'AppVersion=' + metadata.version)
    .replace('AppVerName=AgentOpsDeck 2.4.6', 'AppVerName=AgentOpsDeck ' + installerRevision)
    .replace('VersionInfoVersion=2.4.6.12', 'VersionInfoVersion=' + metadata.version + '.' + revision)
    .replace('AgentOpsDeck-Setup-2.4.6.12-Inno-Windows-x64', 'AgentOpsDeck-Setup-' + installerRevision + '-Windows-x64')
    .replace('SetupIconFile=..\\..\\inno-installer-2.4.6\\assets\\AgentOpsDeck.ico', 'SetupIconFile=' + join(root, 'native', 'windows', 'assets', 'AgentOpsDeck.ico'));
  await writeFile(join(packaging, 'AgentOpsDeck.iss'), recipe);
  let lifecycle = await readFile(join(root, 'native', 'windows', 'installer', 'packaging', 'lifecycle.iss'), 'utf8');
  lifecycle = lifecycle.replaceAll('Target: AgentOpsDeck 2.4.6', 'Target: AgentOpsDeck ' + metadata.version)
    .replaceAll('Target: 2.4.6;', 'Target: ' + metadata.version + ';')
    .replaceAll('installer 2.4.6.12-Inno', 'installer ' + installerRevision);
  await writeFile(join(packaging, 'lifecycle.iss'), lifecycle);
  await copyFile(join(root, 'native', 'windows', 'installer', 'packaging', 'payload-verification.iss'),
    join(packaging, 'payload-verification.iss'));
  const log = execute(compiler, [join(packaging, 'AgentOpsDeck.iss')], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  await writeFile(join(output, 'compile.log'), log);
  const setup = join(output, 'out', 'AgentOpsDeck-Setup-' + installerRevision + '-Windows-x64.exe');
  const bytes = await readFile(setup);
  const report = { sourceRevision: source, version: metadata.version, installerRevision, setup, bytes: bytes.length,
    sha256: sha(bytes), payloadFiles: finalFiles.length, runtimePackages: candidate.packages.length, node: version,
    portablePriorProfiles: profiles.map(profile => ({ id: profile.id, installerSha256: profile.installerSha256 })),
    includesUserStateOrCredentials: false, uploadedToGitLab: false, actualInstallationTestRequired: true };
  await json(join(output, 'build-report.json'), report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeRoot, nativeRoot, compiler, output, ...extra] = process.argv.slice(2);
  try {
    assert.equal(extra.length, 0);
    console.log(JSON.stringify(await buildWindowsSetup({ runtimeRoot, nativeRoot, compiler, output }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

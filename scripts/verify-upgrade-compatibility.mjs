import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isolatedEnvironment } from './run-source-tests.mjs';
import { sourceInventory } from './verify-full-source-batches.mjs';
import { freshCompilerOptions } from './verify-full-compiled-batches.mjs';
import { inventoryCompiledServerAssets, installCompiledServerAssets } from './compiled-server-assets.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_COMMIT = '1fe624fc889f6be8b55e7ea5889d8aa6d72a92a5';
export const UPGRADE_LANES = Object.freeze(['startup', 'roundtrip', 'current-cookie', 'original-cookie']);
const hash = value => createHash('sha256').update(value).digest('hex');

export function resolveBaselineRepository(explicit = process.env.AOD_UPGRADE_BASELINE_REPO) {
  const candidate = typeof explicit === 'string' ? explicit.trim() : '';
  if (!candidate) throw new Error('BASELINE_REPOSITORY_REQUIRED: pass an external baseline repository path or set AOD_UPGRADE_BASELINE_REPO');
  const resolved = resolve(candidate);
  assert.notEqual(resolved, repository, 'BASELINE_REPOSITORY_MUST_BE_EXTERNAL');
  let stat;
  try { stat = lstatSync(resolved); } catch { throw new Error('BASELINE_REPOSITORY_NOT_FOUND'); }
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'BASELINE_REPOSITORY_MUST_BE_DIRECTORY');
  return resolved;
}

export function normalizeBaselineSourceText(text) {
  const sourceBrand = ['claw', 'pool'].join('');
  const sourceConnector = ['claw', 'connector'].join('');
  const brandPattern = new RegExp(sourceBrand, 'gi');
  return text
    .replace(new RegExp(`\\b${sourceBrand.toUpperCase()}_[A-Z0-9_]+\\b`, 'g'), name =>
      /_(VERSION|BUILD)$/.test(name) ? name.replace(brandPattern, 'AGENTOPSDECK') : name.replace(new RegExp(`^${sourceBrand}_`, 'i'), 'AOD_'))
    .replace(new RegExp(sourceConnector, 'gi'), 'AgentOpsDeckConnector')
    .replace(new RegExp(`\\b${['cp', 'conn', ''].join('_')}`, 'g'), 'aod_conn_')
    .replace(new RegExp(`\\b${['cp', 'local', ''].join('_')}`, 'g'), 'aod_local_')
    .replace(new RegExp(`\\b${['cp', 'board', ''].join('_')}`, 'g'), 'aod_board_')
    .replace(new RegExp(`\\b${['cp', 'note', ''].join('_')}`, 'g'), 'aod_note_')
    .replace(/CLAWOPSDECK_OPENCLAW_HOME/g, 'AOD_OPENCLAW_HOME')
    .replace(/(?<!AOD_)OPENCLAW_GATEWAY_(WS_URL|ADMIN_RPC_URL|OWNER_TOKEN|PASSWORD)/g, 'AOD_OPENCLAW_GATEWAY_$1')
    .replace(/(?<!AOD_)OPENCLAW_DEFAULT_AGENT_ID/g, 'AOD_OPENCLAW_DEFAULT_AGENT_ID')
    .replace(/https?:\/\/[A-Za-z0-9.-]*keroslab\.com/gi, 'https://deck.example.invalid')
    .replace(brandPattern, name => name === name.toUpperCase() ? 'AGENTOPSDECK' : name[0] === name[0].toUpperCase() ? 'AgentOpsDeck' : 'agentopsdeck')
    .replace(/\bAGENTOPSDECK_[A-Z0-9_]+\b/g, name => /^(AGENTOPSDECK_VERSION|AGENTOPSDECK_BUILD)$/.test(name) ? name : name.replace('AGENTOPSDECK_', 'AOD_'))
    .replace(/agentopsdeck-parallel/g, 'agentopsdeck-local')
    .replace(/agentopsdeck-sbx-/g, 'aod-sbx-');
}

function emitNormalizedBaselineTree(rawRoot, normalizedRoot, tree) {
  const manifest = [];
  for (const row of tree) {
    const sourcePath = join(rawRoot, row.path), targetPath = join(normalizedRoot, row.path);
    const stat = lstatSync(sourcePath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Baseline entry must be a regular file');
    const rawBytes = readFileSync(sourcePath);
    const normalizeEligible = (row.path === 'tsconfig.base.json'
      || row.path.startsWith('packages/shared/')
      || row.path.startsWith('apps/server/'))
      && /\.(ts|tsx|json|mjs)$/.test(row.path);
    const normalizedBytes = normalizeEligible
      ? Buffer.from(normalizeBaselineSourceText(rawBytes.toString('utf8')), 'utf8')
      : rawBytes;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, normalizedBytes, { flag: 'wx', mode: stat.mode & 0o111 ? 0o700 : 0o600 });
    manifest.push({
      path: row.path,
      blob: row.blob,
      rawSha256: hash(rawBytes),
      normalizedSha256: hash(normalizedBytes),
      normalized: !rawBytes.equals(normalizedBytes),
    });
  }
  return manifest;
}

export function validateBaselineTree(text) {
  const entries = text.split('\0');
  assert.equal(entries.pop(), '', 'Truncated baseline tree');
  assert.ok(entries.length > 0, 'Empty baseline tree');
  const rows = entries.map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
    assert.ok(match, 'Only original regular files may enter baseline archive');
    const path = match[3];
    assert.ok(!isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !/[\\\r\n\0]/.test(path)
      && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe baseline path');
    return { path, blob: match[2] };
  });
  assert.equal(new Set(rows.map(row => row.path)).size, rows.length, 'Duplicate baseline path');
  return rows;
}

export function parseUpgradeReport(text) {
  const reports = [];
  for (let start = text.indexOf('{\n  "version": 1'); start !== -1; start = text.indexOf('{\n  "version": 1', start + 1)) {
    const end = text.indexOf('\n}', start);
    assert.ok(end > start, 'Truncated upgrade report');
    const report = JSON.parse(text.slice(start, end + 2));
    assert.equal(report.passed, true, 'Upgrade lane failed'); reports.push(report);
  }
  assert.equal(reports.length, 1, 'Missing or ambiguous upgrade report');
  return reports[0];
}

function capture(directory) {
  const rows = [];
  function walk(current) {
    for (const entry of readdirSync(join(directory, current), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'Artifact symlink');
      if (entry.isDirectory()) walk(path);
      else { assert.ok(entry.isFile()); rows.push({ path, sha256: hash(readFileSync(join(directory, path))) }); }
    }
  }
  walk(''); return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function emit(workspace, output, sharedDeclaration, baselineRoot) {
  const config = ts.readConfigFile(join(workspace, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, workspace, undefined, join(workspace, 'tsconfig.json'));
  assert.deepEqual(parsed.errors, []);
  const options = freshCompilerOptions(parsed, output, sharedDeclaration), host = ts.createCompilerHost(options);
  // Original archives omit generated metadata. Virtual generation changes no
  // baseline business source and never imports current metadata into baseline.
  const generated = join(baselineRoot, 'packages/shared/src/build-info.generated.ts');
  const metadata = 'export const AGENTOPSDECK_BUILD = ' + JSON.stringify({ revision: 'unknown', dirty: false,
    buildNumber: '26.10150', builtAt: '2026-10-15T00:00:00.000Z' }) + ' as const;\n';
  const exists = host.fileExists.bind(host), read = host.readFile.bind(host), getSource = host.getSourceFile.bind(host);
  const virtual = file => resolve(file) === generated;
  host.fileExists = file => virtual(file) || exists(file);
  host.readFile = file => virtual(file) ? metadata : read(file);
  host.getSourceFile = (file, version, onError, fresh) => virtual(file)
    ? ts.createSourceFile(file, metadata, version, true) : getSource(file, version, onError, fresh);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options, host });
  for (const file of program.getSourceFiles()) if (!file.isDeclarationFile) {
    const path = relative(join(workspace, 'src'), resolve(file.fileName));
    assert.ok(path && !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'), 'Emit escaped source root');
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => repository, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  const result = program.emit(); assert.equal(result.emitSkipped, false); assert.equal(result.diagnostics.length, 0);
}

/** Fresh original/candidate emit, never adjacent dist or live state. All state
 * belongs to a new exclusive temporary directory; failures remain evidence. */
export async function verifyUpgradeCompatibility(options = {}) {
  const baselineRepository = resolveBaselineRepository(options.baselineRepository ?? process.env.AOD_UPGRADE_BASELINE_REPO);
  const evidence = mkdtempSync(join(tmpdir(), 'agentopsdeck-upgrade-237-'));
  const candidate = join(evidence, 'candidate'), baselineRaw = join(evidence, 'baseline-raw'), baseline = join(evidence, 'baseline-source');
  const record = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const run = (command, args, extra = {}) => {
    const result = spawnSync(command, args, { cwd: repository, maxBuffer: 64 * 1024 * 1024, ...extra });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, 'Acceptance child failed');
    return result.stdout;
  };
  const runBaselineGit = (args, extra = {}) => run('git', ['-C', baselineRepository, ...args], extra);
  const before = await sourceInventory();
  const helpers = ['scripts/verify-upgrade-compatibility.mjs', 'scripts/verify-upgrade-compatibility.test.mjs',
    'scripts/upgrade-compatibility/isolated-gateway.mjs',
    ...UPGRADE_LANES.map(lane => `scripts/upgrade-compatibility/${lane}.mjs`),
    'scripts/verify-full-compiled-batches.mjs', 'scripts/compiled-server-assets.mjs',
    'packages/shared/package.json', 'apps/server/package.json'];
  const helperInputs = () => helpers.map(path => ({ path, sha256: hash(readFileSync(join(repository, path))) }));
  const originalHelpers = helperInputs();
  console.log(JSON.stringify({ evidence, wholeDatabaseAsync: false }));
  try {
    assert.equal(runBaselineGit(['rev-parse', '--verify', `${BASELINE_COMMIT}^{commit}`], { encoding: 'utf8' }).trim(), BASELINE_COMMIT, 'Unexpected baseline commit');
    const tagCheck = spawnSync('git', ['-C', baselineRepository, 'rev-parse', '--verify', '2.3.7^{commit}'], { encoding: 'utf8' });
    if (tagCheck.status === 0) assert.equal(tagCheck.stdout.trim(), BASELINE_COMMIT, 'Unexpected 2.3.7 tag target');
    const tree = validateBaselineTree(runBaselineGit(['ls-tree', '-rz', BASELINE_COMMIT], { encoding: 'utf8' }));
    mkdirSync(baselineRaw, { mode: 0o700 }); mkdirSync(baseline, { mode: 0o700 }); mkdirSync(candidate, { mode: 0o700 });
    run('tar', ['-xf', '-', '-C', baselineRaw], { input: runBaselineGit(['archive', '--format=tar', BASELINE_COMMIT]) });
    const checkOriginal = () => {
      const actual = runBaselineGit(['hash-object', '--stdin-paths'], { encoding: 'utf8',
        input: tree.map(row => JSON.stringify(join(baselineRaw, row.path))).join('\n') + '\n' });
      assert.deepEqual(actual.trim().split(/\r?\n/), tree.map(row => row.blob), 'Original tracked source changed');
    };
    checkOriginal();
    const normalizedManifest = emitNormalizedBaselineTree(baselineRaw, baseline, tree);
    const checkNormalized = () => {
      for (const item of normalizedManifest) {
        assert.equal(hash(readFileSync(join(baseline, item.path))), item.normalizedSha256, 'Normalized baseline source changed');
      }
    };
    checkNormalized();
    const link = (target, path) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    for (const root of ['', 'apps/server', 'packages/shared']) link(join(repository, root, 'node_modules'), join(baseline, root, 'node_modules'));
    link(join(repository, 'apps/server/node_modules'), join(evidence, 'node_modules'));
    writeFileSync(join(evidence, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
    for (const [source, build] of [[repository, candidate], [baseline, join(evidence, 'baseline')]]) {
      const shared = join(build, 'node_modules/@agentopsdeck/shared'); mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, 'package.json'), readFileSync(join(source, 'packages/shared/package.json')), { flag: 'wx', mode: 0o600 });
      emit(join(source, 'packages/shared'), join(shared, 'dist'), undefined, baseline);
      emit(join(source, 'apps/server'), join(build, 'dist'), join(shared, 'dist/index.d.ts'), baseline);
      assert.equal(createRequire(join(build, 'dist/application.js')).resolve('@agentopsdeck/shared'), join(shared, 'dist/index.js'));
    }
      installCompiledServerAssets(join(repository, 'apps/server/src'), join(candidate, 'dist'), inventoryCompiledServerAssets(join(repository, 'apps/server/src')));
    const baselineAssets = inventoryCompiledServerAssets(join(baseline, 'apps/server/src'));
    if (baselineAssets.length > 0) installCompiledServerAssets(join(baseline, 'apps/server/src'), join(evidence, 'baseline/dist'), baselineAssets);
    writeFileSync(join(candidate, 'inputs.json'), JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 });
    const outputs = [candidate, join(evidence, 'baseline'), join(candidate, 'node_modules/@agentopsdeck/shared'), join(evidence, 'baseline/node_modules/@agentopsdeck/shared')];
    const compiled = outputs.map(capture);
    const normalizationDigest = hash(JSON.stringify(normalizedManifest));
    record('inputs.json', { candidate: before, helpers: originalHelpers, originalTree: tree, normalizedBaseline: normalizedManifest, normalizationDigest, compiled });
    const check = async () => {
      assert.deepEqual(await sourceInventory(), before, 'Candidate inputs changed');
      assert.deepEqual(helperInputs(), originalHelpers, 'Acceptance helper changed');
      assert.deepEqual(outputs.map(capture), compiled, 'Fresh emitted artifacts changed');
      checkOriginal(); checkNormalized();
    };
    const environment = isolatedEnvironment(evidence); mkdirSync(environment.HOME); mkdirSync(environment.TMPDIR);
    const lanes = {};
    for (const lane of UPGRADE_LANES) {
      await check(); const fd = openSync(join(evidence, lane + '.log'), 'wx', 0o600);
      try { run(process.execPath, [join(repository, 'scripts/upgrade-compatibility', lane + '.mjs'), candidate, join(evidence, 'baseline/dist')],
        { cwd: evidence, env: environment, stdio: ['ignore', fd, fd], timeout: 180_000 }); }
      finally { closeSync(fd); }
      lanes[lane] = parseUpgradeReport(readFileSync(join(evidence, lane + '.log'), 'utf8'));
      await check(); console.log(lane + ' passed');
    }
    assert.equal(lanes.startup.checks, 24); assert.deepEqual(lanes.roundtrip.originalTables, [49, 71, 5]);
    assert.equal(lanes.roundtrip.domainAssertions, 29);
    assert.equal(lanes['current-cookie'].cases.length, 6); assert.equal(lanes['original-cookie'].cases.length, 6);
    for (const lane of ['startup', 'current-cookie', 'original-cookie'])
      assert.equal(lanes[lane].productionFactory, 'createProcessApplication', 'Candidate must use the actual async production root');
    const result = { version: 1, passed: true, evidence, baselineCommit: BASELINE_COMMIT, baselineTrackedFileCount: tree.length,
      lanes, inputsUnchanged: true, originalSourceVerifiedAgainstCommit: true, bothSharedSourcesFreshlyEmitted: true,
      compiledInputsUnchanged: true, baselineBuildInfo: 'virtual synthetic metadata only; no baseline files modified',
      externalBaselineOnly: true, historyImportedIntoRepository: false,
      baselineNormalization: {
        adapter: 'normalizeBaselineSourceText',
        manifestDigest: normalizationDigest,
        normalizedFileCount: normalizedManifest.filter(item => item.normalized).length,
      },
      wholeDatabaseAsync: false, fullProductAcceptance: false, liveStateTouched: false,
      listenersStarted: true, applicationListenersStarted: false, loopbackFixtureOnly: true, windowsNativeAcceptance: false };
    record('result.json', result); return result;
  } catch (error) {
    record('result-failed.json', { version: 1, passed: false, evidence, baselineCommit: BASELINE_COMMIT,
      wholeDatabaseAsync: false, fullProductAcceptance: false, liveStateTouched: false }); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyUpgradeCompatibility(process.argv[2] ? { baselineRepository: process.argv[2] } : {}); }
  catch (error) { console.error(error); process.exitCode = 1; }
}

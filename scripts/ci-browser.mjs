import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function verifyInventory(root = repository) {
  const rows = JSON.parse(await readFile(join(root, 'docs/browser-inventory.json'), 'utf8'));
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.browser\.(mjs|mts)$/.test(entry.name)) files.push(relative(root, path));
    }
  }
  await visit(join(root, 'apps'));
  assert.deepEqual(rows.map(row => row.path), files.sort(), 'Browser inventory drift: review every new/removed entry');
  for (const row of rows) {
    assert.ok(['ci-selected', 'fixture-candidate', 'isolated-runtime', 'external-opt-in', 'helper', 'benchmark'].includes(row.category));
    assert.ok(row.reason.length > 10);
  }
  return rows;
}

export async function runFixture({ file, marker, timeout = 120_000, playwright }) {
  assert.ok(Number.isInteger(timeout) && timeout > 0 && timeout <= 120_000);
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-browser-'));
  const home = join(directory, 'home'), temp = join(directory, 'tmp');
  await mkdir(home); await mkdir(temp);
  // Do not inherit credentials, proxies, NODE_OPTIONS, native-agent paths or opt-ins.
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    CI: 'true', LANG: 'C.UTF-8', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' };
  if (playwright) env.AOD_TEST_PLAYWRIGHT = playwright;
  let child;
  try {
    await new Promise((accept, reject) => {
      let output = '', timedOut = false;
      child = spawn(process.execPath, [file], { cwd: repository, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); process.stdout.write(chunk); });
      child.stderr.on('data', chunk => process.stderr.write(chunk));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); kill();
        if (timedOut) reject(new Error('Browser fixture timed out'));
        else if (code !== 0 || signal) reject(new Error(`Browser fixture failed: exit=${code}, signal=${signal}`));
        else if (!output.includes(marker)) reject(new Error(`Missing acceptance marker: ${marker}`));
        else accept();
      });
    });
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await rm(directory, { recursive: true, force: true });
  }
}

export async function playwrightImportEntry(packageFile) {
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  assert.equal(metadata.version, '1.63.0');
  assert.equal(metadata.exports['.'].import, './index.mjs');
  return join(dirname(packageFile), metadata.exports['.'].import);
}

async function main() {
  assert.equal(process.platform, 'linux', 'Browser gate is native Linux CI only');
  const require = createRequire(join(repository, 'apps/server/package.json'));
  // require.resolve('.') selects CJS; absolute dynamic import needs the package's
  // explicit ESM export to expose named chromium/firefox/webkit bindings.
  const playwright = await playwrightImportEntry(require.resolve('playwright-core/package.json'));
  const inventory = await verifyInventory();
  const markers = {
    'desktop-history-controller.browser.mjs': '"controllerOnly":true',
    'history-anchor-index.browser.mjs': '"anchorIndex":',
    'workspace-binding-lines.browser.mjs': 'PASS: 13 card kinds',
  };
  const selected = inventory.filter(row => row.category === 'ci-selected');
  assert.deepEqual(selected.map(row => row.path.split('/').at(-1)), Object.keys(markers));
  console.log(JSON.stringify({ browserGate: 'start', playwright: '1.63.0', inventory: inventory.length, selected: selected.map(row => row.path) }));
  for (const row of selected) {
    console.log(`BROWSER START ${row.path}`);
    await runFixture({ file: join(repository, row.path), marker: markers[row.path.split('/').at(-1)], playwright });
    console.log(`BROWSER PASS ${row.path}`);
  }
  console.log(JSON.stringify({ browserGate: 'passed', executed: selected.length, skippedWithinSelection: 0, notExecuted: inventory.length - selected.length }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

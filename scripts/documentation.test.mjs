import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guides = ['README', 'installation', 'configuration', 'user-guide', 'integrations',
  'operations', 'troubleshooting', 'development', 'modules', 'api', 'security-review', 'i18n', 'ci',
  'open-source-review-standard', 'technology-stack', 'open-source-review-1.0.0', 'native-security', 'release-blockers'];

test('selected third-party evidence stays an inventory, not publication approval', () => {
  const inventory = JSON.parse(text('docs/review/third-party-license-inventory.json'));
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.status, 'inventory-only');
  assert.equal(inventory.releaseApproved, false);
  assert.ok(inventory.limits.length >= 3);
  assert.equal(inventory.packages.length, 8);
  for (const dependency of inventory.packages) {
    assert.ok(dependency.name && dependency.version && dependency.declaredLicense);
    assert.ok(dependency.files.length > 0);
    for (const file of dependency.files) {
      assert.match(file.path, /^(LICENSE|LICENCE|NOTICE|COPYING)(?:[._-]|$)/i);
      assert.equal(file.path.includes('/'), false);
      assert.equal(file.path.includes('\\'), false);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(file.size) && file.size > 0);
    }
  }
});

function text(path) {
  return readFileSync(join(repository, path), 'utf8');
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

function executableExamples(content) {
  return [...content.matchAll(/^```(?:sh|dotenv)\n([\s\S]*?)^```\s*$/gm)]
    .map(match => match[1].trim());
}

test('every server source directory is covered by both module maps', () => {
  const directories = readdirSync(join(repository, 'apps/server/src'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `apps/server/src/${entry.name}`);
  for (const language of ['', '.zh-CN']) {
    const content = text(`docs/modules${language}.md`);
    for (const path of directories) assert.ok(content.includes(path), `Undocumented module: ${path}`);
  }
});

test('public Markdown links resolve locally without escaping the source tree', () => {
  const files = ['README.md', 'README.zh-CN.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE-STATUS.md']
    .map(path => join(repository, path)).concat(markdownFiles(join(repository, 'docs')));
  let checked = 0;
  for (const file of files) {
    const content = readFileSync(file, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const destination = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(destination)) continue;
      const path = resolve(dirname(file), decodeURIComponent(destination.split(/[?#]/)[0]));
      const local = relative(repository, path);
      assert.ok(local !== '..' && !local.startsWith(`..${sep}`), `Outside source: ${relative(repository, file)}`);
      assert.ok(existsSync(path), `Broken link in ${relative(repository, file)}: ${destination}`);
      checked++;
    }
  }
  assert.ok(checked > 80, 'Documentation should expose the setup and maintenance navigation');
});

test('English and Simplified Chinese guides are paired and indexed', () => {
  for (const guide of guides) {
    const english = `docs/${guide}.md`;
    const chinese = `docs/${guide}.zh-CN.md`;
    assert.ok(text(english).includes(`](${guide}.zh-CN.md)`), `Missing Chinese link: ${english}`);
    assert.ok(text(chinese).includes(`](${guide}.md)`), `Missing English link: ${chinese}`);
    if (guide === 'README') continue;
    assert.ok(text('docs/README.md').includes(`](${guide}.md)`), `Missing index entry: ${guide}`);
    assert.ok(text('docs/README.zh-CN.md').includes(`](${guide}.zh-CN.md)`), `Missing Chinese index: ${guide}`);
  }
  assert.ok(text('README.md').includes('](docs/README.md)'));
  assert.ok(text('README.zh-CN.md').includes('](docs/README.zh-CN.md)'));
});

test('setup examples match package contracts and never overwrite an existing env file', () => {
  const manifest = JSON.parse(text('package.json'));
  const manager = manifest.packageManager;
  const minimumNode = manifest.engines.node.replace(/^>=/, '');
  for (const path of ['docs/installation.md', 'docs/installation.zh-CN.md']) {
    const content = text(path);
    assert.ok(content.includes(minimumNode), `${path}: Node prerequisite drift`);
    assert.ok(content.includes(`corepack prepare ${manager} --activate`), `${path}: pnpm drift`);
    assert.ok(content.includes('pnpm install --frozen-lockfile --prod=false'));
    assert.ok(content.includes('node scripts/create-local-config.mjs'));
    assert.ok(content.includes('pnpm --filter @agentopsdeck/server start'));
    assert.ok(content.includes('--env AOD_LISTEN_HOST=0.0.0.0'));
    assert.ok(content.includes('--env AOD_DATA_DIR=/data'));
    assert.ok(!content.includes('cp .env.example .env'), 'Never overwrite private config');
  }
  for (const guide of ['installation', 'integrations', 'operations', 'troubleshooting', 'development']) {
    assert.deepEqual(executableExamples(text(`docs/${guide}.md`)),
      executableExamples(text(`docs/${guide}.zh-CN.md`)), `Bilingual command drift: ${guide}`);
  }
  for (const script of ['create-local-config.mjs', 'run-script-tests.mjs', 'run-source-tests.mjs']) {
    assert.ok(existsSync(join(repository, 'scripts', script)));
  }
  for (const script of ['dev', 'build', 'check:publication', 'check:publication:release', 'check:i18n']) {
    assert.equal(typeof manifest.scripts[script], 'string');
  }
  assert.equal(JSON.parse(text('apps/server/package.json')).name, '@agentopsdeck/server');
  assert.equal(JSON.parse(text('apps/server/package.json')).scripts.start,
    'node --disable-warning=ExperimentalWarning dist/index.js');
});

test('common configuration tables stay bilingual and refer to implemented fields', () => {
  const variables = path => [...text(path).matchAll(/^\| `(AOD_[A-Z_]+)` \|/gm)].map(match => match[1]);
  const english = variables('docs/configuration.md');
  assert.deepEqual(english, variables('docs/configuration.zh-CN.md'));
  assert.ok(english.length >= 12);
  const sources = text('apps/web/vite.config.ts') + readdirSync(join(repository, 'apps/server/src'))
    .filter(path => /^config(?:-[\w-]+)?\.ts$/.test(path))
    .map(path => text(`apps/server/src/${path}`)).join('\n');
  for (const variable of english) assert.ok(sources.includes(variable), `Undocumented implementation: ${variable}`);
});

test('instance guidance does not confuse branding with cookie isolation', () => {
  const english = text('docs/configuration.md');
  const chinese = text('docs/configuration.zh-CN.md');
  assert.ok(english.includes('their names\nalone do not isolate two deployments'));
  assert.ok(chinese.includes('名称本身不能隔离两个部署'));
  assert.ok(!english.includes('separate from AgentOpsDeck cookies'));
  assert.ok(!chinese.includes('AgentOpsDeck 前缀应用变量不能'));
});

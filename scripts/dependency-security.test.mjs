import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const minimums = {
  '@hono/node-server': ['2.1.3'],
  '@simplewebauthn/server': ['13.3.2'],
  hono: ['4.13.16'],
  nanoid: ['3.3.18', '5.1.16'],
  postcss: ['8.5.23'],
  vite: ['6.4.4'],
  browserslist: ['4.28.7'],
  'source-map-js': ['1.2.2'],
  'baseline-browser-mapping': ['2.11.0'],
};

function meetsMinimum(name, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split('.').map(Number);
  return minimums[name].some(minimum => {
    const required = minimum.split('.').map(Number);
    return actual[0] === required[0] && (actual[1] > required[1]
      || (actual[1] === required[1] && actual[2] >= required[2]));
  });
}

test('every affected package resolution satisfies its reviewed security floor', () => {
  const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
  const packages = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
  assert.ok(packages, 'Expected pnpm v9 package resolutions');
  const seen = new Set();
  for (const match of packages.matchAll(/^  '?([^\s']+)@([^\s':]+)'?:$/gm)) {
    const [, name, version] = match;
    if (!Object.hasOwn(minimums, name)) continue;
    seen.add(name);
    assert.ok(meetsMinimum(name, version), `${name}@${version} is below its security floor or outside its reviewed major`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(minimums).sort());
});

test('security floors reject each old resolution and do not cross nanoid majors', () => {
  const vulnerable = {
    '@hono/node-server': '1.19.14', '@simplewebauthn/server': '13.3.1',
    hono: '4.12.25', nanoid: '5.1.11', postcss: '8.5.15', vite: '6.4.3',
    browserslist: '4.28.2', 'source-map-js': '1.2.1', 'baseline-browser-mapping': '2.10.37',
  };
  for (const [name, version] of Object.entries(vulnerable)) assert.equal(meetsMinimum(name, version), false, name);
  assert.equal(meetsMinimum('nanoid', '3.3.12'), false);
  assert.equal(meetsMinimum('nanoid', '4.0.0'), false);
  for (const [name, versions] of Object.entries(minimums)) {
    for (const version of versions) {
      assert.equal(meetsMinimum(name, version), true, name);
      assert.equal(meetsMinimum(name, `${version}-rc.1`), false, name);
    }
  }
});

test('transitive constraints are parent-scoped compatible upgrades, not audit exemptions', () => {
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(root.pnpm.overrides, {
    '@babel/helper-compilation-targets>browserslist': '^4.28.7',
    '@tailwindcss/node>source-map-js': '^1.2.2',
    'browserslist>baseline-browser-mapping': '^2.11.0',
    'vite>postcss': '^8.5.23',
    'postcss>nanoid': '^3.3.18',
    'postcss>source-map-js': '^1.2.2',
  });
  assert.equal(root.pnpm.auditConfig, undefined);
  for (const packagePath of ['../package.json', '../apps/server/package.json', '../apps/web/package.json', '../packages/shared/package.json']) {
    assert.equal(JSON.parse(readFileSync(new URL(packagePath, import.meta.url), 'utf8')).version, '1.0.0');
  }
});

test('direct manifest ranges cannot resolve below reviewed security floors', () => {
  for (const packagePath of ['../apps/server/package.json', '../apps/web/package.json']) {
    const { dependencies } = JSON.parse(readFileSync(new URL(packagePath, import.meta.url), 'utf8'));
    for (const [name, range] of Object.entries(dependencies)) {
      if (Object.hasOwn(minimums, name)) assert.ok(meetsMinimum(name, range.replace(/^\^/, '')), `${name} ${range}`);
    }
  }
});

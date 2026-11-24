import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { readPrivateWorkerCredential } from '../apps/server/src/connector/private-worker-credential.ts';

const source = await readFile(new URL('./probe-gemini-tool-image-compat.mjs', import.meta.url), 'utf8');
const admission = source.slice(source.indexOf('if (process.env.'), source.indexOf('const crcTable'));
assert.match(source, /import \{ readPrivateWorkerCredential \} from '\.\.\/apps\/server\/src\/connector\/private-worker-credential\.ts'/);

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-gemini-key-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'synthetic-credential');
  await writeFile(file, 'fixture-not-a-real-key\n', { mode: 0o600 });
  return { root, file };
}

function admit(file, overrides = {}) {
  return runInNewContext(`(async () => { ${admission} return key; })()`, {
    readPrivateWorkerCredential,
    process: { env: { AOD_GEMINI_COMPAT_PROBE: '1', AOD_GEMINI_PROBE_KEY_FILE: file,
      AOD_GEMINI_PROBE_BASE_URL: 'http://127.0.0.1:1', AOD_GEMINI_PROBE_RECEIPT: '/synthetic/receipt', ...overrides } },
  });
}

test('Gemini admission uses the existing bounded private credential helper without provider access', async context => {
  const { file } = await fixture(context);
  assert.equal(await admit(file), 'fixture-not-a-real-key');
});

test('Gemini admission requires every explicit gate before reading credentials', async context => {
  const { file } = await fixture(context);
  for (const name of ['AOD_GEMINI_COMPAT_PROBE', 'AOD_GEMINI_PROBE_KEY_FILE',
    'AOD_GEMINI_PROBE_BASE_URL', 'AOD_GEMINI_PROBE_RECEIPT']) {
    await assert.rejects(admit(file, { [name]: '' }), /Explicit synthetic probe permission/);
  }
});

test('Gemini admission rejects relative paths, file/parent symlinks, hardlinks and directories', async context => {
  const { root, file } = await fixture(context);
  const alias = join(root, 'alias'), parent = join(root, 'parent');
  await symlink(file, alias);
  await symlink(root, parent, 'dir');
  for (const path of [relative(process.cwd(), file), alias, join(parent, 'synthetic-credential'), root]) {
    await assert.rejects(admit(path), error => error.message === 'Private worker credential could not be verified');
  }
  await link(file, join(root, 'hardlink'));
  await assert.rejects(admit(file), /could not be verified/);
});

test('Gemini admission rejects non-private permissions without leaking path or content', async context => {
  const { file } = await fixture(context);
  for (const mode of [0o644, 0o660, 0o400]) {
    await chmod(file, mode);
    await assert.rejects(admit(file), error => error.message === 'Private worker credential could not be verified');
  }
});

test('Gemini admission rejects empty, oversized and malformed synthetic credentials', async context => {
  const { file } = await fixture(context);
  for (const content of ['', ' '.repeat(4), 'fixture token', 'fixture\u0000token', Buffer.from([0xff]), 'x'.repeat(16385)]) {
    await writeFile(file, content);
    await assert.rejects(admit(file), error => error.message === 'Private worker credential could not be verified');
  }
  await writeFile(file, 'x'.repeat(16384));
  assert.equal((await admit(file)).length, 16384);
});

test('Gemini admission refuses a missing file before constructing images or a relay', async context => {
  const { root } = await fixture(context);
  await mkdir(join(root, 'empty'));
  await assert.rejects(admit(join(root, 'empty/missing')), /could not be verified/);
  assert.ok(source.indexOf('const key = await readPrivateWorkerCredential') < source.indexOf('const images ='));
  assert.ok(source.indexOf('const key = await readPrivateWorkerCredential') < source.indexOf('const relay ='));
});

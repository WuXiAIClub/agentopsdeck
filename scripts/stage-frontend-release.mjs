import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const webPrefix = 'apps/web/dist/';
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(entry.isFile() || entry.isDirectory(), 'No links or special files in frontend candidate');
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), path));
    else if (path !== 'candidate-manifest.json') {
      const bytes = await readFile(join(directory, entry.name));
      files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return files;
}

/** Carry forward a verified backend exactly; never consume the worktree's server build. */
export async function stageFrontendRelease({ previous, expectedManifest, webRoot, destination }) {
  for (const path of [previous, webRoot, destination]) assert.ok(isAbsolute(path), 'Absolute paths required');
  previous = await realpath(previous);
  webRoot = await realpath(webRoot);
  destination = resolve(destination);
  for (const source of [previous, webRoot]) {
    assert.ok(destination !== source && !destination.startsWith(source + sep) && !source.startsWith(destination + sep), 'Source and destination must be disjoint');
  }
  assert.equal((await verifyCandidateRelease(previous)).manifestSha256, expectedManifest, 'Previous release changed');
  const original = JSON.parse(await readFile(join(previous, 'candidate-manifest.json'), 'utf8'));
  const webFiles = await inventory(webRoot);
  assert.ok(webFiles.some(file => file.path === 'index.html'), 'Frontend build missing index.html');
  await mkdir(destination); // Fail if it exists; never overwrite or delete another release.
  for (const entry of await readdir(previous)) {
    if (entry === 'candidate-manifest.json') continue;
    await cp(join(previous, entry), join(destination, entry), { recursive: true, force: false, errorOnExist: true,
      filter: path => path !== join(previous, 'apps/web/dist') });
  }
  await chmod(destination, 0o755);
  await chmod(join(destination, 'apps/web'), 0o755);
  await cp(webRoot, join(destination, 'apps/web/dist'), { recursive: true, force: false, errorOnExist: true });
  const files = await inventory(destination);
  assert.deepEqual(files.filter(file => !file.path.startsWith(webPrefix)), original.files.filter(file => !file.path.startsWith(webPrefix)), 'Backend or dependencies changed');
  assert.deepEqual(files.filter(file => file.path.startsWith(webPrefix)).map(file => ({ ...file, path: file.path.slice(webPrefix.length) })), webFiles, 'Frontend build changed during staging');
  assert.equal((await verifyCandidateRelease(previous)).manifestSha256, expectedManifest, 'Previous release changed during staging');
  await writeFile(join(destination, 'candidate-manifest.json'), JSON.stringify({ ...original, status: 'staged-unverified', files }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  const candidate = await verifyCandidateRelease(destination);
  return { destination, previous, previousManifest: expectedManifest, backendUnchanged: true, webFiles: webFiles.length, ...candidate };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 6, 'Usage: node scripts/stage-frontend-release.mjs PREVIOUS MANIFEST WEB_DIST DESTINATION');
  const [, , previous, expectedManifest, webRoot, destination] = process.argv;
  console.log(JSON.stringify(await stageFrontendRelease({ previous, expectedManifest, webRoot, destination })));
}

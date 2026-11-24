import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/;
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);

async function packageJson(directory) {
  const handle = await open(join(directory, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Package metadata must be a regular file');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function resolveDependency(directory, name) {
  if (!packageName.test(name)) throw new Error(`Invalid dependency name: ${name}`);
  for (let parent = directory; ; parent = dirname(parent)) {
    const candidate = join(parent, 'node_modules', name);
    try { return await realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (parent === dirname(parent)) return undefined;
  }
}

async function dependencies(root, server, shared) {
  const installed = join(root, 'node_modules'), graph = new Map();
  const visit = async directory => {
    if (graph.has(directory)) return graph.get(directory);
    const metadata = await packageJson(directory);
    const node = { source: directory, name: metadata.name, version: metadata.version, edges: new Map() };
    graph.set(directory, node);
    const requirements = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies };
    for (const name of Object.keys(requirements).sort()) {
      const source = await resolveDependency(directory, name);
      const optional = Object.hasOwn(metadata.optionalDependencies ?? {}, name)
        || (!Object.hasOwn(metadata.dependencies ?? {}, name) && metadata.peerDependenciesMeta?.[name]?.optional === true);
      if (!source) {
        if (optional) continue;
        throw new Error(`Missing installed runtime dependency: ${name}`);
      }
      if (source !== shared && !inside(installed, source)) throw new Error(`Runtime dependency is outside the workspace package store: ${name}`);
      const identity = await packageJson(source);
      if (identity.name !== name || typeof identity.version !== 'string') throw new Error(`Invalid installed runtime identity: ${name}`);
      node.edges.set(name, await visit(source));
    }
    return node;
  };
  return visit(server);
}

function packageLayout(graph) {
  const placements = [];
  const place = (node, directory, available, ancestors = new Set()) => {
    if (ancestors.has(node.source)) throw new Error('Cannot stage a shadowed dependency cycle without links');
    const scope = new Map(available), added = [];
    for (const [name, dependency] of node.edges) {
      if (scope.get(name)?.source === dependency.source) continue;
      const placement = { ...dependency, path: join(directory, 'node_modules', name) };
      scope.set(name, placement);
      placements.push(placement);
      added.push(placement);
    }
    for (const dependency of added) place(dependency, dependency.path, scope, new Set([...ancestors, node.source]));
  };
  place(graph, 'apps/server', new Map());
  return placements;
}

async function copyFile(source, target) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw new Error('Candidate inputs must be regular files');
    await writeFile(target, await input.readFile(), { flag: 'wx', mode: stat.mode & 0o111 ? 0o755 : 0o644 });
  } finally { await input.close(); }
}

async function copyTree(source, target, compiled = false) {
  const stat = await lstat(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Candidate inputs must be real directories');
  await mkdir(target, { recursive: true });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.env' || entry.name.startsWith('.env.')) continue;
    if (compiled && /\.test\.(js|d\.ts)(\.map)?$/.test(entry.name)) continue;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Candidate inputs contain an unsupported link or special file');
    const input = join(source, entry.name), output = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(input, output, compiled);
    else await copyFile(input, output);
  }
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name))) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Candidate contains an unsupported link or special file');
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), name));
    else {
      const content = await readRegularFile(join(directory, entry.name));
      files.push({ path: name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    }
  }
  return files;
}

async function readRegularFile(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Candidate files must be regular files without hard links');
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function verifyCandidateRelease(destination) {
  if (!isAbsolute(destination) || await realpath(destination) !== resolve(destination)) throw new Error('Candidate must be a real absolute directory');
  const content = await readRegularFile(join(destination, 'candidate-manifest.json'));
  const manifest = JSON.parse(content.toString('utf8'));
  if (manifest.format !== 1 || manifest.entrypoint !== 'apps/server/dist/index.js' || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported candidate manifest');
  }
  const files = (await inventory(destination)).filter(file => file.path !== 'candidate-manifest.json');
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('Candidate inventory differs from its manifest');
  return { manifestSha256: createHash('sha256').update(content).digest('hex'), files: files.length, entrypoint: manifest.entrypoint };
}

export async function stageCandidateRelease({ root = defaultRoot, destination }) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('Provide a new absolute candidate destination');
  root = await realpath(root);
  const target = join(await realpath(dirname(resolve(destination))), resolve(destination).split(sep).at(-1));
  if (inside(root, target) || inside(target, root)) throw new Error('Candidate destination must be outside the source workspace');
  const server = join(root, 'apps/server'), shared = join(root, 'packages/shared');
  for (const input of ['apps/server', 'apps/server/dist', 'apps/web/dist', 'packages/shared', 'packages/shared/dist', 'node_modules']) {
    if (await realpath(join(root, input)) !== join(root, input)) throw new Error('Candidate workspace inputs must not be redirected');
  }
  const packages = packageLayout(await dependencies(root, server, shared));
  await mkdir(target);
  try {
    await copyTree(join(server, 'dist'), join(target, 'apps/server/dist'), true);
    await copyFile(join(server, 'package.json'), join(target, 'apps/server/package.json'));
    await copyTree(join(root, 'apps/web/dist'), join(target, 'apps/web/dist'));
    for (const identity of packages) {
      const output = join(target, identity.path);
      if (identity.source === shared) {
        await copyTree(join(shared, 'dist'), join(output, 'dist'), true);
        await copyFile(join(shared, 'package.json'), join(output, 'package.json'));
      } else await copyTree(identity.source, output);
    }
    for (const required of ['apps/server/dist/index.js', 'apps/server/dist/application.js', 'apps/web/dist/index.html']) {
      if (!(await lstat(join(target, required))).isFile()) throw new Error(`Missing built candidate entry: ${required}`);
    }
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'agentopsdeck-candidate', private: true, type: 'module',
      scripts: { start: 'node apps/server/dist/index.js' } }, null, 2) + '\n', { flag: 'wx' });
    const manifest = { format: 1, status: 'staged-unverified', entrypoint: 'apps/server/dist/index.js',
      platform: process.platform, arch: process.arch, node: process.version,
      packages: packages.map(identity => ({ name: identity.name, version: identity.version, path: identity.path }))
        .sort((first, second) => first.path.localeCompare(second.path)),
      files: await inventory(target) };
    await writeFile(join(target, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { destination: target, packages: manifest.packages.length, files: manifest.files.length,
      manifestSha256: createHash('sha256').update(await readFile(join(target, 'candidate-manifest.json'))).digest('hex') };
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/stage-candidate-release.mjs /absolute/new/destination');
  console.log(JSON.stringify(await stageCandidateRelease({ destination: process.argv[2] })));
}

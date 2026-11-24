import { constants } from 'node:fs';
import { lstat, open, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_DIRECTORY_DEPTH = 32;
export const MAX_PAYLOAD_FILES = 20000;
export const MAX_PAYLOAD_BYTES = 2 ** 31;

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pascal = value => "'" + value.replaceAll("'", "''") + "'";

async function readPinnedRegularFile(targetPath, maxBytes, label = 'payload') {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(targetPath, flags);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      throw Error(`Unsupported ${label} object`);
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw Error(`Unbounded or linked ${label}`);
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw Error('Upgrade profile exceeds payload bound');
    }
    const content = await handle.readFile();
    if (content.length !== stat.size || content.length > maxBytes) {
      throw Error('Upgrade profile file changed or exceeds payload bound');
    }
    return content;
  } finally {
    await handle.close();
  }
}

export function validateUpgradeProfile(profile) {
  if (profile?.schema !== 1 || typeof profile.id !== 'string' || !/^[a-z0-9.-]{1,100}$/.test(profile.id)
    || !/^\d+\.\d+\.\d+$/.test(profile.version ?? '') || !digest(profile.installerSha256)
    || !/^[a-f0-9]{40}$/.test(profile.sourceRevision ?? '') || !Array.isArray(profile.files)
    || profile.files.length < 1 || profile.files.length > MAX_PAYLOAD_FILES) throw Error('Invalid bounded upgrade profile');
  const paths = new Set();
  let bytes = 0;
  for (const file of profile.files) {
    if (typeof file.path !== 'string' || file.path.length > 240 || /[\\:\x00-\x1f<>|?*]/.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
        || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
      || !digest(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || /(?:^|\/)(?:\.env|auth\.json|credentials)(?:\/|$)|\.sqlite(?:-|$)/i.test(file.path)) {
      throw Error('Unsafe upgrade profile entry');
    }
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw Error('Upgrade profile case/path alias');
    paths.add(key);
    bytes += file.bytes;
    if (bytes > MAX_PAYLOAD_BYTES) throw Error('Upgrade profile exceeds payload bound');
  }
  for (const required of ['AgentOpsDeck.exe', 'runtime/node.exe', 'package.json', 'release.json', 'desktop-launcher.cjs', 'lifecycle.cjs']) {
    if (!paths.has(required.toLowerCase())) throw Error('Incomplete upgrade profile');
  }
  return profile;
}

export function renderUpgradeProfiles(profiles) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 16) throw Error('Bounded known profiles required');
  profiles.forEach(validateUpgradeProfile);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw Error('Duplicate upgrade profile identity');
  const rows = ['// Full independently catalogued payloads only; never combine per-file hashes.'];
  for (let index = 0; index < profiles.length; index++) {
    rows.push(`procedure LoadPortableProfile${index};`, 'begin', '  PriorFiles.Clear;');
    for (const file of profiles[index].files) {
      rows.push(`  PriorFiles.Add(${pascal(file.path.replaceAll('/', '\\') + '|' + file.sha256)});`);
    }
    rows.push('end;', '');
  }
  rows.push('procedure LoadPortableUpgradeProfile;', 'begin');
  for (let index = 0; index < profiles.length; index++) {
    rows.push(`  LoadPortableProfile${index};`, '  if MatchesPriorPayload then Exit;');
  }
  rows.push('end;', '', 'function PortableRegistrationVersion: Boolean;', 'begin',
    '  Result := ' + [...new Set(profiles.map(profile => profile.version))]
      .map(version => `RegStringEquals(InnoKey, 'DisplayVersion', ${pascal(version)})`).join(' or ') + ';',
    'end;', '');
  return rows.join('\n');
}

export async function createUpgradeProfile({
  installer,
  payload,
  expectedSha256,
  id,
  maxPayloadBytes = MAX_PAYLOAD_BYTES,
  maxPayloadFiles = MAX_PAYLOAD_FILES,
  maxDirectoryDepth = MAX_DIRECTORY_DEPTH,
}) {
  if (!isAbsolute(installer) || !isAbsolute(payload) || !digest(expectedSha256)) throw Error('Exact installer identity and absolute payload required');
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1 || maxPayloadBytes > MAX_PAYLOAD_BYTES
    || !Number.isSafeInteger(maxPayloadFiles) || maxPayloadFiles < 1 || maxPayloadFiles > MAX_PAYLOAD_FILES
    || !Number.isSafeInteger(maxDirectoryDepth) || maxDirectoryDepth < 1 || maxDirectoryDepth > MAX_DIRECTORY_DEPTH) {
    throw Error('Invalid bounded upgrade profile limits');
  }
  const setup = await lstat(installer), root = await lstat(payload);
  if (!setup.isFile() || setup.isSymbolicLink() || setup.nlink !== 1 || !root.isDirectory() || root.isSymbolicLink()) {
    throw Error('Supplied installer identity mismatch');
  }
  let installerBytes;
  try {
    installerBytes = await readPinnedRegularFile(installer, maxPayloadBytes, 'installer');
  } catch (error) {
    if (/exceeds payload bound/.test(error.message)) throw error;
    throw Error('Supplied installer identity mismatch');
  }
  if (hash(installerBytes) !== expectedSha256) throw Error('Supplied installer identity mismatch');
  const files = [];
  const capturedMetadata = new Map();
  let totalBytes = 0;
  async function visit(prefix = '', depth = 0) {
    if (depth > maxDirectoryDepth) throw Error('Upgrade profile exceeds directory depth bound');
    const entries = await readdir(join(payload, prefix), { withFileTypes: true });
    if (entries.length > maxPayloadFiles) throw Error('Unbounded or linked payload');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const target = join(payload, relative);
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw Error('Unsupported payload object');
      if (stat.isDirectory()) await visit(relative, depth + 1);
      else {
        if (stat.nlink !== 1 || files.length >= maxPayloadFiles) throw Error('Unbounded or linked payload');
        const remainingBudget = maxPayloadBytes - totalBytes;
        if (remainingBudget < 0 || stat.size > remainingBudget) throw Error('Upgrade profile exceeds payload bound');
        const content = await readPinnedRegularFile(target, remainingBudget, 'payload');
        totalBytes += content.length;
        if (relative === 'release.json' || relative === 'package.json') {
          capturedMetadata.set(relative, content.toString('utf8'));
        }
        files.push({ path: relative, bytes: content.length, sha256: hash(content) });
      }
    }
  }
  await visit();
  if (!capturedMetadata.has('release.json') || !capturedMetadata.has('package.json')) {
    throw Error('Incomplete upgrade profile');
  }
  const release = JSON.parse(capturedMetadata.get('release.json'));
  const package_ = JSON.parse(capturedMetadata.get('package.json'));
  if (package_.version !== release.version) throw Error('Payload product versions disagree');
  return validateUpgradeProfile({ schema: 1, id, version: release.version, sourceRevision: release.sourceRevision,
    installer: basename(installer), installerSha256: expectedSha256,
    provenance: 'Exact user-supplied or locally verified installer payload; not a vendor signature or a self-reported installed inventory',
    files });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [installer, payload, expectedSha256, id, output, ...extra] = process.argv.slice(2);
  try {
    if (!output || extra.length) throw Error('Usage: windows-upgrade-profiles.mjs INSTALLER PAYLOAD SHA256 ID OUTPUT');
    const profile = await createUpgradeProfile({ installer, payload, expectedSha256, id });
    await writeFile(output, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ id: profile.id, version: profile.version, files: profile.files.length,
      installerSha256: profile.installerSha256 }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

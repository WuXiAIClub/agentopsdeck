import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

const marker = '// BEGIN VERIFIED CONFIGURATION INHERITANCE\n';
const endMarker = '// END VERIFIED CONFIGURATION INHERITANCE\n';
const digestPattern = /^[a-f0-9]{64}$/;

// Local deployment helper, not an application/runtime permission bypass.
// Exact, operator-approved releases inherit a previously accepted config only.
// Never alias the identity used by verifyNodeRelease, imports or revision reporting.
export function inheritLauncherConfiguration(source, candidate, baseline) {
  assert.match(candidate, digestPattern); assert.match(baseline, digestPattern);
  assert.notEqual(candidate, baseline);
  assert.ok(source.includes('const release = selected.directory;'));
  let aliases = {};
  if (source.includes(marker)) {
    const start = source.indexOf(marker), end = source.indexOf(endMarker, start);
    assert.ok(end > start, 'Incomplete configuration inheritance block');
    const block = source.slice(start + marker.length, end);
    const match = block.match(/^const configurationAliases = (\{[^\n]*\});\n/);
    assert.ok(match, 'Unrecognized configuration inheritance block');
    aliases = JSON.parse(match[1]);
    source = source.slice(0, start) + source.slice(end + endMarker.length);
  }
  for (const [key, value] of Object.entries(aliases)) {
    assert.match(key, digestPattern); assert.match(value, digestPattern);
    assert.ok(!Object.hasOwn(aliases, value), 'Alias chains must be flattened');
  }
  assert.ok(!Object.hasOwn(aliases, candidate), 'Candidate already configured');
  const effectiveBaseline = aliases[baseline] ?? baseline;
  assert.notEqual(effectiveBaseline, candidate, 'Configuration alias cycle');
  aliases[candidate] = effectiveBaseline;
  const boundary = source.indexOf('const configurationManifest =');
  const boot = source.lastIndexOf('await import(`${release}/apps/server/dist/index.js`);');
  assert.ok(boundary > 0 && boot > boundary, 'Unsupported launcher shape');
  const prefix = source.slice(0, boundary);
  const body = source.slice(boundary, boot).replaceAll('selected.manifestSha256', 'configurationReleaseManifest');
  const block = marker + `const configurationAliases = ${JSON.stringify(aliases)};\n`
    + 'const configurationReleaseManifest = configurationAliases[selected.manifestSha256] ?? selected.manifestSha256;\n' + endMarker;
  return prefix + block + body + source.slice(boot);
}

// Only use on a reviewed, hash-pinned local launcher. This is a synthetic
// regression harness, NOT a security sandbox for untrusted JavaScript.
export async function evaluateLauncherConfiguration(source, selected) {
  const start = source.includes(marker) ? source.indexOf(marker) : source.indexOf('const configurationManifest =');
  const end = source.lastIndexOf('await import(`${release}/apps/server/dist/index.js`);');
  assert.ok(start >= 0 && end > start, 'Unsupported launcher shape');
  const synthetic = Object.fromEntries(['AOD_ACCESS_KEY', 'AOD_HUB_VAULT_SECRET',
    'AOD_CONNECTOR_BOOTSTRAP_TOKEN'].map(key => [key, '0'.repeat(64)]));
  const fakeProcess = { env: {}, chdir() {} };
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    selected, release: selected.directory, root: '/synthetic-agentopsdeck-root', process: fakeProcess,
    readFile: async () => JSON.stringify(synthetic),
  }, { timeout: 2000 });
  // Return only environment values, with synthetic credentials; never inspect
  // the real process environment or private credential file contents.
  return JSON.parse(JSON.stringify(fakeProcess.env));
}

export async function assertConfigurationInheritance(before, after, baseline, candidate) {
  const original = await evaluateLauncherConfiguration(before, baseline);
  const retained = await evaluateLauncherConfiguration(after, baseline);
  const inherited = await evaluateLauncherConfiguration(after, candidate);
  assert.deepEqual(retained, original, 'Baseline release configuration changed');
  for (const values of [original, inherited]) delete values.AOD_CONNECTOR_REVISION;
  assert.deepEqual(inherited, original, 'Candidate effective configuration differs from accepted baseline');
  // Verify reported identity was not aliased along with configuration.
  assert.equal((await evaluateLauncherConfiguration(after, candidate)).AOD_CONNECTOR_REVISION, candidate.revision);
  return { baselinePreserved: true, candidateEquivalent: true, actualRevisionPreserved: true,
    comparedKeys: Object.keys(original).length };
}

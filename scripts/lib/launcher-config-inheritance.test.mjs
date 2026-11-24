import test from 'node:test';
import assert from 'node:assert/strict';
import { inheritLauncherConfiguration as inherit, evaluateLauncherConfiguration as evaluate,
  assertConfigurationInheritance as equivalent } from './launcher-config-inheritance.mjs';
const old = { directory: '/old', revision: 'old-rev', manifestSha256: 'a'.repeat(64) };
const next = { directory: '/next', revision: 'new-rev', manifestSha256: 'b'.repeat(64) };
const unknown = { directory: '/unknown', revision: 'unknown-rev', manifestSha256: 'c'.repeat(64) };
const source = `const release = selected.directory;
const configurationManifest = selected.manifestSha256;
const secrets = JSON.parse(await readFile('/fake-secret', 'utf8'));
Object.assign(process.env, secrets, { AOD_CONNECTOR_REVISION: selected.revision });
if (configurationManifest === '${old.manifestSha256}') process.env.EARLY = 'true';
if (selected.manifestSha256 === '${old.manifestSha256}') process.env.LATE = 'true';
await import(\`\${release}/apps/server/dist/index.js\`);
`;
test('unchanged launcher fails effective-config equivalence', async () => {
  await assert.rejects(equivalent(source, source, old, next), /effective configuration differs/);
});
test('inherits early and late gates but retains actual runtime identity', async () => {
  const fixed = inherit(source, next.manifestSha256, old.manifestSha256);
  assert.equal((await equivalent(source, fixed, old, next)).candidateEquivalent, true);
  assert.deepEqual(await evaluate(fixed, unknown), await evaluate(source, unknown));
  assert.ok(fixed.endsWith('await import(`${release}/apps/server/dist/index.js`);\n'));
});
test('successive deployment flattens aliases and preserves previous releases', async () => {
  const first = inherit(source, next.manifestSha256, old.manifestSha256);
  const second = inherit(first, unknown.manifestSha256, next.manifestSha256);
  await equivalent(first, second, next, unknown);
  assert.deepEqual(await evaluate(first, old), await evaluate(second, old));
});
test('rejects duplicate approval and malformed hashes', () => {
  const fixed = inherit(source, next.manifestSha256, old.manifestSha256);
  assert.throws(() => inherit(fixed, next.manifestSha256, old.manifestSha256), /already configured/);
  assert.throws(() => inherit(source, 'bad', old.manifestSha256));
});
test('rejects unsupported launcher instead of silently dropping gates', () => {
  assert.throws(() => inherit('const release = selected.directory;', next.manifestSha256, old.manifestSha256));
});
test('detects independent config drift and baseline mutation', async () => {
  const fixed = inherit(source, next.manifestSha256, old.manifestSha256);
  await assert.rejects(equivalent(source, fixed.replace("process.env.LATE = 'true'", "process.env.LATE = 'false'"), old, next), /Baseline release configuration changed/);
});

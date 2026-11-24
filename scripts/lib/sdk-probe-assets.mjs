import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Includes fork()/--import entrypoints: static imports alone do not find them.
export const sdkProbeFiles = Object.freeze([
  'verify-sdk-litellm.mjs', 'stage-candidate-release.mjs',
  'lib/isolated-sdk-probe.mjs', 'lib/sdk-litellm-settings.mjs',
  'lib/sdk-attachment-fixture.mjs', 'lib/sdk-file-board-probe.mjs',
  'lib/all-card-linkage-probe.mjs', 'lib/sdk-probe-options.mjs',
  'lib/all-card-content-fixtures.mjs',
  'lib/sdk-probe-assets.mjs', 'lib/sdk-service-host.mjs',
  'lib/sdk-probe-stream-shapes.mjs',
]);

export function sdkProbeHttpModule(compiled) {
  // Resolve from the pinned application, not the maintenance bundle's location.
  return createRequire(join(compiled, 'application.js')).resolve('@hono/node-server');
}

export async function verifySdkProbeAssets(scriptRoot, compiled) {
  for (const file of sdkProbeFiles) {
    const info = await stat(join(scriptRoot, file)).catch(() => undefined);
    assert.ok(info?.isFile(), `Incomplete SDK probe bundle: ${file}`);
  }
  sdkProbeHttpModule(compiled);
}

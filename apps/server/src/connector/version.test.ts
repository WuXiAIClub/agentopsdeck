import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AGENTOPSDECK_VERSION, CONNECTOR_PROTOCOL, negotiateConnectorProtocol } from '@agentopsdeck/shared';

test('all workspace product versions match the advertised product version, independently of the wire protocol', () => {
  // The runner's cwd is inside the real workspace; emitted tests may live in
  // an external directory. Inspect real metadata, never the output tree.
  let root = resolve(process.cwd());
  while (!existsSync(resolve(root, 'pnpm-workspace.yaml'))) {
    const parent = dirname(root);
    assert.notEqual(parent, root, 'Run version verification from the AgentOpsDeck workspace');
    root = parent;
  }
  assert.equal(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name, 'agentopsdeck');
  for (const path of ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json']) {
    assert.equal(JSON.parse(readFileSync(resolve(root, path), 'utf8')).version, AGENTOPSDECK_VERSION, path);
  }
  assert.equal(negotiateConnectorProtocol(CONNECTOR_PROTOCOL), 1);
  assert.equal(negotiateConnectorProtocol(undefined), 1, 'legacy v1 contract remains supported');
  assert.equal(negotiateConnectorProtocol({ min: 2, max: 2 }), undefined, 'product version is not wire compatibility');
});

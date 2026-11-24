import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateWorkerScope, enterPrivateWorkerScope, verifyPrivateWorkerScope, WORKER_SCOPE_ENV } from './private-worker-scope.js';

test('Legacy tool policies never allocate a cgroup or accept a scope injection', () => {
  for (const mode of [undefined, 'none', 'workspace-read', 'workspace-edit']) {
    assert.equal(createPrivateWorkerScope({ toolPolicy: mode }), undefined);
    enterPrivateWorkerScope(mode, {}); verifyPrivateWorkerScope(mode, {});
    const injected = { [WORKER_SCOPE_ENV]: '/sys/fs/cgroup/other.service' };
    assert.throws(() => enterPrivateWorkerScope(mode, injected));
    assert.throws(() => verifyPrivateWorkerScope(mode, injected));
  }
});

test('Trusted workers reject missing, arbitrary and non-owned scope paths before SDK launch', () => {
  for (const path of [undefined, '', '/', '/tmp/agentopsdeck-exec-00000000-0000-0000-0000-000000000000', '/sys/fs/cgroup/other.service']) {
    const env = { [WORKER_SCOPE_ENV]: path };
    assert.throws(() => enterPrivateWorkerScope('trusted-exec', env));
    assert.throws(() => verifyPrivateWorkerScope('trusted-exec', env));
  }
});

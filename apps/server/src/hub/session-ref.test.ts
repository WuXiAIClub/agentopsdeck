import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { legacySessionKey, sessionRef } from './session-ref.js';
import { AGENT_RUNTIME_IDS, isAgentRuntimeId, sessionRuntimeId } from '@agentopsdeck/shared';

test('runtime identity uses exact namespaces without aliases or bare-name inference', () => {
  for (const runtime of AGENT_RUNTIME_IDS) {
    assert.equal(isAgentRuntimeId(runtime), true);
    assert.equal(sessionRuntimeId(`${runtime}:native`), runtime);
    assert.equal(sessionRuntimeId(runtime), 'openclaw');
    assert.equal(sessionRuntimeId(`${runtime}x`), 'openclaw');
  }
  for (const key of ['claude:native', 'copilot:native', 'gh:native', 'codexx:native', 'agent:claude-code:native']) {
    assert.equal(sessionRuntimeId(key), 'openclaw');
  }
  for (const value of [null, {}, 1, 'claude', 'copilot']) assert.equal(isAgentRuntimeId(value), false);
});

const nodeId = 'node_00000000-0000-4000-8000-000000000001';
test('SessionRef separates native runtime keys and rejects lossy legacy translations', () => {
  for (const key of ['agent:dev:session:a', 'codex:thread/中文?#%', 'codex:codex:nested', 'hermes:local-identity', 'hermes:中文?#%']) {
    const ref = sessionRef(nodeId, key)!;
    assert.equal(legacySessionKey(ref), key);
    assert.equal(ref.runtimeId, key.startsWith('hermes:') ? 'hermes' : key.startsWith('codex:') ? 'codex' : 'openclaw');
  }
  assert.notDeepEqual(sessionRef(nodeId, 'same'), sessionRef(nodeId, 'codex:same'));
  assert.equal(sessionRef(undefined, 'same'), undefined);
  assert.equal(sessionRef('not-a-node', 'same'), undefined);
  for (const key of ['', 'codex:', 'hermes:', 'bad\u0000key', 'bad\nkey', '\ud800', 'x'.repeat(4097)]) assert.throws(() => sessionRef(nodeId, key));
  assert.throws(() => legacySessionKey({ nodeId, runtimeId: 'openclaw', nativeSessionKey: 'codex:ambiguous' }));
  assert.throws(() => legacySessionKey({ nodeId, runtimeId: 'openclaw', nativeSessionKey: 'hermes:ambiguous' }));
  assert.throws(() => legacySessionKey({ nodeId, runtimeId: 'other' as any, nativeSessionKey: 'same' }));
  for (const runtimeId of ['claude-code', 'ghcp'] as const) {
    for (const nativeSessionKey of ['native', '中文?#%', `${runtimeId}:nested`]) {
      const key = `${runtimeId}:${nativeSessionKey}`;
      assert.deepEqual(sessionRef(nodeId, key), { nodeId, runtimeId, nativeSessionKey });
      assert.equal(legacySessionKey({ nodeId, runtimeId, nativeSessionKey }), key);
    }
    assert.throws(() => sessionRef(nodeId, `${runtimeId}:`));
    assert.throws(() => legacySessionKey({ nodeId, runtimeId: 'openclaw', nativeSessionKey: `${runtimeId}:ambiguous` }));
  }
});

test('pinned aliases resolve without per-session writes, survive restart and fail closed on ambiguous installs', context => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-ref-')), file = join(root, 'hub.sqlite');
  context.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  let store = new HubStore(file, 'synthetic');
  const input = { id: 'a', label: 'A', connectorUrl: 'http://synthetic.invalid' };
  const alias = encodeHubSessionId('a', 'codex:same');
  const ref = sessionRef(nodeId, 'codex:same')!;
  try {
    const member = store.createUser('Other');
    store.upsertConnection(input);
    assert.equal(store.sessionReference(alias), undefined);
    assert.equal(store.resolveSessionReference(ref), undefined);
    store.pinConnectionNode('a', 'default', store.connectionAuthority('a')!, nodeId);
    store.setSessionPreference(alias, 'pinned', true);
    assert.deepEqual(store.sessionReference(alias), ref);
    assert.deepEqual(store.resolveSessionReference(ref), { connectionId: 'a', remoteSessionKey: 'codex:same' });
    assert.equal(store.sessionReference(alias, member.id), undefined);
    assert.equal(store.resolveSessionReference(ref, member.id), undefined);
    store.close(); store = new HubStore(file, 'synthetic');
    store.upsertConnection({ ...input, connectorUrl: 'http://moved.invalid' });
    assert.deepEqual(store.sessionReference(alias), ref);
    assert.equal(store.sessionPreferences().get(alias)?.pinned, true);
    store.upsertConnection({ ...input, id: 'alternate' });
    store.pinConnectionNode('alternate', 'default', store.connectionAuthority('alternate')!, nodeId);
    assert.equal(store.resolveSessionReference(ref), undefined, 'no first-node fallback for clones or alternate transports');
    store.upsertConnection({ ...input, id: 'alternate', status: 'disabled' });
    assert.deepEqual(store.resolveSessionReference(ref), { connectionId: 'a', remoteSessionKey: 'codex:same' });
    store.deleteConnection('a');
    assert.equal(store.sessionReference(alias), undefined);
    assert.equal(store.resolveSessionReference(ref), undefined);
    store.upsertConnection(input);
    assert.deepEqual(store.sessionReference(alias), ref);
  } finally { try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); } }
});

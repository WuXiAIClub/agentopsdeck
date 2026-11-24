import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractScript = resolve(repository, 'scripts/verify-hermes-contract.py');
const wireScript = resolve(repository, 'scripts/verify-hermes-wire.mjs');
const tsxLoader = resolve(repository, 'apps/server/node_modules/tsx/dist/esm/index.mjs');

const SYNTHETIC_REPLAY_PY = `from collections import OrderedDict, deque
import json
import uuid

_EPOCH = uuid.uuid4().hex
_MAX_SESSIONS = 64
_MAX_RING = 512
_MAX_EVENT_BYTES = 4 * 1024 * 1024
_SESSIONS = OrderedDict()

def replay_epoch():
    return _EPOCH

def _session_state(session_id):
    state = _SESSIONS.get(session_id)
    if state is not None:
        _SESSIONS.move_to_end(session_id)
        return state
    while len(_SESSIONS) >= _MAX_SESSIONS:
        _SESSIONS.popitem(last=False)
    state = {"seq": 0, "ring": deque(), "min_kept_after": 0}
    _SESSIONS[session_id] = state
    return state

def _stamp_event(frame):
    params = frame["params"]
    session_id = params.get("session_id")
    if not session_id:
        return frame
    state = _session_state(session_id)
    state["seq"] += 1
    seq = state["seq"]
    params["seq"] = seq
    raw_len = len(json.dumps(params, ensure_ascii=False).encode("utf-8"))
    if raw_len > _MAX_EVENT_BYTES:
        state["ring"].clear()
        state["min_kept_after"] = seq
        return frame
    state["ring"].append(params)
    while len(state["ring"]) > _MAX_RING:
        evicted = state["ring"].popleft()
        if evicted["seq"] > state["min_kept_after"]:
            state["min_kept_after"] = evicted["seq"]
    return frame

def latest_seq(session_id):
    state = _SESSIONS.get(session_id)
    return 0 if state is None else state["seq"]

def is_truncated(session_id, after_seq):
    state = _SESSIONS.get(session_id)
    if state is None:
        return False
    return after_seq < state["min_kept_after"]

def events_since(session_id, after_seq):
    state = _SESSIONS.get(session_id)
    if state is None:
        return []
    return [item for item in state["ring"] if item["seq"] > after_seq]
`;

const SYNTHETIC_SERVER_PY = `def _event_frame(event_type, session_id=None, payload=None):
    _contracts.check_payload(event_type, payload)
    params = {"type": event_type}
    if session_id is not None:
        params["session_id"] = session_id
    if payload is not None:
        params["payload"] = payload
    return {"jsonrpc": "2.0", "method": "event", "params": params}
`;

const SYNTHETIC_ENTRY_PY = `STARTUP_FRAME = {
    "jsonrpc": "2.0",
    "method": "event",
    "params": {
        "type": "gateway.ready",
        "payload": {
            "replay_epoch": replay_epoch(),
            "change_events": True,
            "skin": resolve_skin(),
        },
    },
}
`;

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function createSyntheticHermesTree(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aod-hermes-contract-'));
  const gatewayDir = join(dir, 'tui_gateway');
  await mkdir(gatewayDir, { recursive: true, mode: 0o700 });
  const merged = {
    'tui_gateway/event_replay.py': SYNTHETIC_REPLAY_PY,
    'tui_gateway/server.py': SYNTHETIC_SERVER_PY,
    'tui_gateway/entry.py': SYNTHETIC_ENTRY_PY,
    ...files,
  };
  const digests = {};
  for (const [relPath, text] of Object.entries(merged)) {
    await writeFile(join(dir, relPath), text, { mode: 0o600 });
    digests[relPath] = sha256(text);
  }
  return { dir, digests };
}

test('verify-hermes-contract rejects missing or mismatched SHA-256 pins before executing upstream code', async (t) => {
  const markerDir = await mkdtemp(join(tmpdir(), 'aod-hermes-marker-'));
  t.after(async () => rm(markerDir, { recursive: true, force: true }));
  const markerFile = join(markerDir, 'executed.txt');
  const { dir, digests } = await createSyntheticHermesTree({
    'tui_gateway/event_replay.py': `import pathlib\npathlib.Path(${JSON.stringify(markerFile)}).write_text('ran')\n` + SYNTHETIC_REPLAY_PY,
  });
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const missingPin = spawnSync('python3', ['-B', contractScript, dir], { encoding: 'utf8' });
  assert.notEqual(missingPin.status, 0);

  const wrongDigests = {
    ...digests,
    'tui_gateway/event_replay.py': '0'.repeat(64),
  };
  const mismatch = spawnSync(
    'python3',
    ['-B', contractScript, dir, '--expected-sha256', JSON.stringify(wrongDigests)],
    { encoding: 'utf8' },
  );
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /SHA-256 mismatch/);
  await assert.rejects(() => stat(markerFile));

  const wireMissing = spawnSync(process.execPath, ['--import', tsxLoader, wireScript, dir], {
    cwd: repository,
    encoding: 'utf8',
  });
  assert.notEqual(wireMissing.status, 0);
  assert.match(wireMissing.stderr, /--expected-sha256/);
});

test('verify-hermes-contract rejects symlinks and non-stdlib imports even when SHA-256 matches', async (t) => {
  const { dir, digests } = await createSyntheticHermesTree({
    'tui_gateway/event_replay.py': `import third_party_secret_sdk\n` + SYNTHETIC_REPLAY_PY,
  });
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const nonStdlib = spawnSync(
    'python3',
    ['-B', contractScript, dir, '--expected-sha256', JSON.stringify(digests)],
    { encoding: 'utf8' },
  );
  assert.notEqual(nonStdlib.status, 0);
  assert.match(nonStdlib.stderr, /Non-stdlib import rejected/);

  const symlinkDir = await mkdtemp(join(tmpdir(), 'aod-hermes-symlink-'));
  t.after(async () => rm(symlinkDir, { recursive: true, force: true }));
  await mkdir(join(symlinkDir, 'tui_gateway'), { mode: 0o700 });
  const outside = join(symlinkDir, 'outside.py');
  await writeFile(outside, SYNTHETIC_SERVER_PY, { mode: 0o600 });
  await writeFile(join(symlinkDir, 'tui_gateway/event_replay.py'), SYNTHETIC_REPLAY_PY, { mode: 0o600 });
  await symlink(outside, join(symlinkDir, 'tui_gateway/server.py'));
  await writeFile(join(symlinkDir, 'tui_gateway/entry.py'), SYNTHETIC_ENTRY_PY, { mode: 0o600 });
  const symDigests = {
    'tui_gateway/event_replay.py': sha256(SYNTHETIC_REPLAY_PY),
    'tui_gateway/server.py': sha256(SYNTHETIC_SERVER_PY),
    'tui_gateway/entry.py': sha256(SYNTHETIC_ENTRY_PY),
  };
  const symlinkRes = spawnSync(
    'python3',
    ['-B', contractScript, symlinkDir, '--expected-sha256', JSON.stringify(symDigests)],
    { encoding: 'utf8' },
  );
  assert.notEqual(symlinkRes.status, 0);
  assert.match(symlinkRes.stderr, /Symlink source file rejected/);
});

test('verify-hermes-contract and verify-hermes-wire pass with pinned stdlib synthetic upstream', async (t) => {
  const { dir, digests } = await createSyntheticHermesTree();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, 'expected-sha256.json');
  await writeFile(manifestPath, JSON.stringify(digests, null, 2), { mode: 0o600 });

  const summaryRun = spawnSync(
    'python3',
    ['-B', contractScript, dir, '--expected-sha256', manifestPath],
    { encoding: 'utf8' },
  );
  assert.equal(summaryRun.status, 0, summaryRun.stderr);
  const summary = JSON.parse(summaryRun.stdout);
  assert.equal(summary.kind, 'isolated-upstream-contract-not-backend-e2e');
  assert.deepEqual(summary.source_sha256, digests);
  assert.equal(summary.checks.length, 8);

  const wireRun = spawnSync(
    process.execPath,
    ['--import', tsxLoader, wireScript, dir, '--expected-sha256', manifestPath],
    { cwd: repository, encoding: 'utf8' },
  );
  assert.equal(wireRun.status, 0, wireRun.stderr);
  const wireSummary = JSON.parse(wireRun.stdout);
  assert.equal(wireSummary.kind, 'upstream-frames-through-agentopsdeck-source');
  assert.equal(wireSummary.frames, 4);
  assert.equal(wireSummary.replay, true);
});

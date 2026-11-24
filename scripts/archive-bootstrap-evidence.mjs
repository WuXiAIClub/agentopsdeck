// Pure, read-only evidence helpers. Caller MUST prove the service/cgroup stopped
// before opening a database. No immutable=1/nolock workaround for live SQLite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const terminal = `coalesce(json_extract(fact, '$.fenced'), 0) = 0
  AND json_extract(fact, '$.preparation') IS NULL
  AND coalesce(length(json_extract(fact, '$.runId')), 0) > 0
  AND coalesce(json_extract(fact, '$.phase'), '') IN ('completed', 'failed', 'interrupted')`;

export async function archiveDatabaseEvidence(file, sessions) {
  assert.equal(await realpath(file), file);
  const stat = await lstat(file);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid());
  assert.ok(Array.isArray(sessions) && sessions.length > 0 && sessions.length <= 64);
  assert.deepEqual(sessions, [...new Set(sessions)].sort());
  for (const key of sessions) assert.match(key, /^codex:[a-f0-9-]{36}$/);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const pending = db.prepare(`SELECT session_key, fact FROM connector_codex_executions
      WHERE NOT (${terminal} AND coalesce(json_extract(fact, '$.sync'), '') = 'current') ORDER BY session_key`).all();
    assert.deepEqual(pending.map(row => row.session_key), sessions, 'stopped pending identities do not match the grant');
    const acknowledgments = new Set();
    for (const row of db.prepare("SELECT scope FROM command_receipts WHERE state = 'accepted'").all()) {
      try {
        const scope = JSON.parse(row.scope);
        if (!Array.isArray(scope) || scope.length !== 2 || scope[0] !== 'delete' || typeof scope[1] !== 'string') continue;
        const target = JSON.parse(scope[1]);
        if (Array.isArray(target) && target.length === 2 && target.every(item => typeof item === 'string')) acknowledgments.add(target[1]);
      } catch { /* legacy, unrelated scope */ }
    }
    for (const row of pending) {
      const fact = JSON.parse(row.fact);
      assert.ok(acknowledgments.has(row.session_key), 'missing durable deletion ACK');
      assert.equal(fact.sessionKey, row.session_key);
      assert.ok(['completed', 'failed', 'interrupted'].includes(fact.phase)
        && typeof fact.runId === 'string' && fact.runId.length > 0 && !fact.fenced
        && fact.preparation == null && fact.reason == null && ['syncing', 'error'].includes(fact.sync));
      assert.ok(Array.isArray(fact.pending) && fact.pending.length === 0, 'unresolved native observation');
      assert.ok(!fact.pendingCommandTools?.length, 'unresolved command tools');
    }
    const count = sql => db.prepare(`SELECT count(*) AS count FROM ${sql}`).get().count;
    assert.equal(count('connector_turns'), 0, 'queued messages');
    assert.equal(count(`connector_mirror_outbox WHERE json_extract(job, '$.legacy') = 1
      OR json_extract(job, '$.deliveryState') IS NULL OR json_extract(job, '$.deliveryState') NOT IN ('sent','no_output','blocked')`), 0);
    assert.equal(count(`connector_openclaw_executions WHERE NOT (coalesce(json_extract(fact, '$.fenced'),0) = 0
      AND coalesce(json_extract(fact, '$.phase'),'') IN ('completed','failed')
      AND (json_extract(fact, '$.historySync') IS NULL OR coalesce(json_extract(fact, '$.historySync.state'),'') = 'current'))`), 0);
    assert.equal(count("hermes_executions WHERE phase NOT IN ('completed','failed','interrupted')"), 0);
    assert.equal(count("hermes_deletions WHERE state <> 'accepted'"), 0);
    return { sessions: pending.map(row => ({ sessionKey: row.session_key, factSha256: hash(row.fact), deletionAccepted: true })),
      otherPending: 0, queuedMessages: 0, integrity: 'ok' };
  } finally { db.close(); }
}

export async function nativeHistoryFile(root, sessionKey) {
  assert.match(sessionKey, /^codex:[a-f0-9-]{36}$/);
  assert.equal(await realpath(root), root);
  const matches = []; let visited = 0;
  const visit = async (directory, depth = 0) => {
    assert.ok(depth <= 6);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert.ok(++visited <= 50_000 && !item.isSymbolicLink());
      const file = join(directory, item.name);
      if (item.isDirectory()) await visit(file, depth + 1);
      else if (item.isFile() && item.name.endsWith(`-${sessionKey.slice(6)}.jsonl`)) matches.push(file);
    }
  };
  await visit(root); assert.equal(matches.length, 1, 'native history must have exactly one file');
  return matches[0];
}

export async function fileEvidence(file, prefixBytes) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size > 0);
    const bytes = prefixBytes ?? stat.size;
    assert.ok(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= stat.size);
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: bytes - 1 })) digest.update(chunk);
    return { bytes, sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}

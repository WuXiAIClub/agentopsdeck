import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { archiveDatabaseEvidence, fileEvidence, nativeHistoryFile } from './archive-bootstrap-evidence.mjs';
const session = 'codex:01a0adde-49f0-7382-8068-c87f9b68d3fa';
async function fixture(t) {
  const root = await mkdtemp('/tmp/agentopsdeck-archive-evidence-'), file = join(root, 'fixture.sqlite');
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE connector_codex_executions(session_key TEXT, fact TEXT);
    CREATE TABLE command_receipts(scope TEXT, state TEXT);
    CREATE TABLE connector_turns(id TEXT);
    CREATE TABLE connector_mirror_outbox(job TEXT);
    CREATE TABLE connector_openclaw_executions(fact TEXT);
    CREATE TABLE hermes_executions(phase TEXT);
    CREATE TABLE hermes_deletions(state TEXT);`);
  const fact = { sessionKey: session, phase: 'completed', sync: 'syncing', runId: 'native-run', pending: [] };
  db.prepare('INSERT INTO connector_codex_executions VALUES (?,?)').run(session, JSON.stringify(fact));
  db.prepare('INSERT INTO command_receipts VALUES (?,?)').run(JSON.stringify(['delete', JSON.stringify(['actor',session])]), 'accepted');
  db.close();
  const change = callback => { const handle = new DatabaseSync(file); try { callback(handle); } finally { handle.close(); } };
  return { root, file, fact, change };
}
test('stopped archive verification is read-only and requires the exact acknowledged terminal set', async t => {
  const f = await fixture(t), before = await fileEvidence(f.file);
  const proof = await archiveDatabaseEvidence(f.file, [session]);
  assert.equal(proof.sessions[0].deletionAccepted, true);
  assert.deepEqual(await fileEvidence(f.file), before);
  await assert.rejects(archiveDatabaseEvidence(f.file, []));
  await assert.rejects(archiveDatabaseEvidence(f.file, ['codex:01a0adde-49f0-7382-8068-c87f9b68d3fb']));
});
for (const patch of [{ phase: 'running' }, { reason: 'restarted' }, { fenced: true }, { preparation: 'ready' },
  { runId: null }, { pending: [{ phase: 'running' }] }, { pendingCommandTools: ['unconfirmed'] }, { sync: 'current' }]) {
  test(`stopped verification rejects ${JSON.stringify(patch)}`, async t => {
    const f = await fixture(t);
    f.change(db => db.prepare('UPDATE connector_codex_executions SET fact=?').run(JSON.stringify({ ...f.fact, ...patch })));
    await assert.rejects(archiveDatabaseEvidence(f.file, [session]));
  });
}
for (const mutation of ["UPDATE command_receipts SET state='outcome_unknown'", 'DELETE FROM command_receipts',
  "INSERT INTO connector_turns VALUES('waiting')", "INSERT INTO hermes_executions VALUES('running')",
  "INSERT INTO hermes_deletions VALUES('outcome_unknown')", "INSERT INTO connector_mirror_outbox VALUES('{}')",
  "INSERT INTO connector_openclaw_executions VALUES('{}')"]) {
  test(`stopped verification rejects unresolved state: ${mutation.split(' ')[2]}`, async t => {
    const f = await fixture(t); f.change(db => db.exec(mutation));
    await assert.rejects(archiveDatabaseEvidence(f.file, [session]));
  });
}
test('native history lookup rejects ambiguity/links and prefix hash detects rewritten history', async t => {
  const f = await fixture(t), file = join(f.root, `rollout-${session.slice(6)}.jsonl`);
  await writeFile(file, 'before\n');
  assert.equal(await nativeHistoryFile(f.root, session), file);
  const before = await fileEvidence(file); await writeFile(file, 'before\nafter\n');
  assert.deepEqual(await fileEvidence(file, before.bytes), before);
  assert.notDeepEqual(await fileEvidence(file), before);
  await symlink(file, join(f.root, 'unsafe-link'));
  await assert.rejects(nativeHistoryFile(f.root, session));
});

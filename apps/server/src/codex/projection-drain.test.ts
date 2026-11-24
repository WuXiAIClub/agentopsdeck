import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { createConnectorRuntime } from '../connector/runtime.js';

function barrier() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

for (const failure of [false, true]) test(`Connector drains every admitted artifact projection including finally, failure=${failure}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-projection-drain-'));
  const file = join(directory, 'connector.sqlite');
  const runtime = createConnectorRuntime(loadConfig({
    AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_USERS_DATABASE_FILE: file, AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`,
    AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_QUEUE_FILE: `${file}.queue`,
    AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
    AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`,
  }), () => false);
  const jobs = [0, 1, 2].map(() => ({ work: barrier(), finish: barrier() }));
  const publish = t.mock.method(runtime.store, 'addMessage');
  let entered = 0, finished = 0;
  (runtime.codex as any).options.projectAssistant = async (text: string) => {
    const job = jobs[entered++]!;
    await job.work.pending;
    try {
      // Models artifact-index writes that occur before recordAssistantMessage's
      // closed guard, without reading a real artifact or running an Agent.
      writeFileSync(join(directory, `${text}.artifact`), 'synthetic index');
      if (failure) throw new Error('synthetic projection failure');
      return { text, media: [] };
    } finally { await job.finish.pending; finished++; }
  };
  t.after(async () => {
    for (const job of jobs) { job.work.release(); job.finish.release(); }
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const receive = (threadId: string, id: string) => (runtime.codex as any).receive(JSON.stringify({
    method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id, text: id } },
  }));
  for (const threadId of ['thread-one', 'thread-two']) runtime.store.upsertSession({
    sessionKey: `codex:${threadId}`, agentId: 'codex', title: 'Synthetic projection', status: 'running',
  });
  receive('thread-one', 'first'); receive('thread-one', 'second'); receive('thread-two', 'third');
  assert.equal(entered, 3);
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'child/worker absence does not prove artifact callbacks drained');
  receive('thread-two', 'late');
  assert.equal(entered, 3, 'closed receive cannot admit another projection');
  for (const job of jobs.slice(0, 2)) { job.work.release(); job.finish.release(); }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, 2);
  assert.equal(closed, false, 'all sessions and all tasks must drain');
  jobs[2]!.work.release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(existsSync(join(directory, 'third.artifact')), true);
  assert.equal(closed, false, 'callback finally is part of its lifetime');
  assert.throws(() => new ConnectorUserStore(file, undefined, { runtimeOwner: true }), /locked|busy/i);
  jobs[2]!.finish.release(); await closing;
  assert.equal(finished, 3);
  assert.equal(closed, true);
  assert.equal(publish.mock.callCount(), 0, 'shutdown must not publish a stale callback');
  for (const pending of (runtime.codex as any).assistantProjections.values()) assert.equal(pending.size, 0);
  const next = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  try { assert.equal(next.nodeId, runtime.connectorUsers.nodeId); } finally { next.close(); }
});

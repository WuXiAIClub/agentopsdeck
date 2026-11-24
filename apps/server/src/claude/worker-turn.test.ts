import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeWorkerTurn } from './worker-turn.js';
import type { ClaudeWorkerStart } from './worker-protocol.js';
import type { SdkMetricSample } from '../connector/sdk-metrics.js';

async function fixture(mode = 'normal', busyParent = false) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-claude-worker-'));
  const homeDirectory = join(root, 'home'), workspace = join(root, 'workspace');
  await mkdir(homeDirectory, { mode: 0o700 }); await mkdir(workspace);
  const entry = join(root, 'fixture.mjs');
  const ackFile = join(root, 'completion-ack.json');
  await writeFile(entry, `
    let active;
    process.on('message', message => {
      if (message.kind === 'finished-ack') {
        if (!active || Object.keys(message).length !== 3 || message.id !== active.id || message.nativeSessionId !== active.nativeSessionId) process.exit(1);
        import('node:fs').then(fs => {
          fs.writeFileSync(${JSON.stringify(ackFile)},JSON.stringify(message));
          setTimeout(() => process.disconnect(), active.model === 'slow-exit' ? 120 : 0);
        });
        return;
      }
      if (message.kind === 'interrupt') { process.send({kind:'interrupted'}); return; }
      const {execution:e, config} = message;
      active={id:e.id,nativeSessionId:e.nativeSessionId,model:config.model};
      if (process.env.ANTHROPIC_API_KEY || process.env.NODE_OPTIONS) throw new Error('inherited');
      if (config.model === 'noack') return;
      if (config.model === 'failed') { process.send({kind:'failed', error:'PRIVATE'}); process.disconnect(); return; }
      process.send({kind:'event', event:{type:'system', subtype:'init', session_id:e.nativeSessionId, claude_code_version:'2.1.280'}});
      process.send({kind:'event', event:{type:'assistant', session_id:e.nativeSessionId, uuid:'reply', user_message_uuid:e.id,
        parent_tool_use_id:null, message:{role:'assistant', content:'PRIVATE'}}});
      if (config.model === 'interrupt') return;
      if (config.model.startsWith('reconciled-')) {
        if (config.model !== 'reconciled-wrong-kind') process.send({kind:'event', event:{type:'result', session_id:e.nativeSessionId, uuid:'reply', parent_tool_use_id:config.model === 'reconciled-child' ? 'tool' : null}});
        process.send({kind:'metrics', nativeSessionId:e.nativeSessionId, sample:{eventId:'reply', sequence:1,
          usage:{scope:'last-turn',inputTokens:10,outputTokens:2},
          reconciledCalls:[{id:'call',model:'native-model',inputTokens:config.model === 'reconciled-forged' ? 11 : 10,outputTokens:2}]}});
      }
      if (config.model.startsWith('metric-')) {
        process.send({kind:'metrics', nativeSessionId:config.model === 'metric-foreign' ? 'foreign' : e.nativeSessionId,
          sample:{eventId:config.model === 'metric-mismatch' ? 'foreign' : 'reply', sequence:1,
            context:{used:12,basis:'last-request-input'},
            ...(config.model === 'metric-private' ? {private:'PRIVATE'} : {}),
            ...(config.model === 'metric-wrong-kind' ? {compacted:true} : {})}});
      }
      process.send({kind:'finished', streamError:config.model === 'history-invalid-stream' ? 'invalid' : config.model === 'stream-error', history:[
        {type:'user', uuid:e.id, session_id:config.model === 'history-foreign' ? 'foreign' : e.nativeSessionId, parent_tool_use_id:null}]});
    });
  `);
  const request: ClaudeWorkerStart = { kind: 'start', text: 'fixture',
    config: { homeDirectory, workspace, sdkDirectory: join(root, 'unused-sdk'), apiKeyFile: join(root, 'unused-key'),
      model: mode, baseUrl: 'https://fixture.invalid', startupTimeoutMs: 500 },
    execution: { id: randomUUID(), key: `claude-code:${randomUUID()}`, epoch: randomUUID(), nativeSessionId: randomUUID(),
      nativeMode: 'create', members: ['message'], phase: 'dispatching', stopRequested: false, createdAt: 0, updatedAt: 0 } };
  const metrics: SdkMetricSample[] = [];
  const turn = new ClaudeWorkerTurn(request, { entry, execArgv: [] }, undefined, undefined, sample => {
    metrics.push(sample);
    if (busyParent) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  });
  return { turn, request, metrics, ackFile, close: async () => { turn.close(); await turn.finished; await rm(root, { recursive: true, force: true }); } };
}

for (const mode of ['good', 'wrong-kind', 'forged', 'child']) test(`Claude reconciled result IPC ${mode}`, async () => {
  const f = await fixture(`reconciled-${mode}`);
  try {
    const drain = async () => { for await (const _ of f.turn) { /* consume */ } };
    if (mode === 'good') { await drain(); assert.equal(f.metrics[0]?.reconciledCalls?.[0]?.model, 'native-model'); }
    else { await assert.rejects(drain()); assert.equal(f.metrics.length, 0); }
  } finally { await f.close(); }
});

for (const mode of ['good', 'foreign', 'mismatch', 'private', 'wrong-kind']) test(`Claude metric IPC ${mode}: exact session/event/numeric payload`, async () => {
  const f = await fixture(`metric-${mode}`);
  try {
    const drain = async () => { for await (const _ of f.turn) { /* consume */ } };
    if (mode === 'good') { await drain(); assert.equal(f.metrics.length, 1); assert.equal(await f.turn.inspectQuiescence(), true); }
    else { await assert.rejects(drain()); assert.equal(f.metrics.length, 0); assert.equal(await f.turn.inspectQuiescence(), false); }
  } finally { await f.close(); }
});

test('Claude private process forwards bounded identities and requires actual process-group exit', async () => {
  const f = await fixture('slow-exit');
  try {
    const iterator = f.turn[Symbol.asyncIterator]();
    await iterator.next();
    assert.equal(await f.turn.inspectQuiescence(), false);
    const reply = (await iterator.next()).value;
    assert.deepEqual(reply?.message, { role: 'assistant' });
    assert.equal((await iterator.next()).done, true);
    assert.equal(await f.turn.inspectQuiescence(), true);
    assert.equal((await f.turn.historyIdentities())[0]?.uuid, f.request.execution.id);
    assert.deepEqual(JSON.parse(await readFile(f.ackFile, 'utf8')), {
      kind: 'finished-ack', id: f.request.execution.id, nativeSessionId: f.request.execution.nativeSessionId,
    });
    await assert.rejects(f.turn[Symbol.asyncIterator]().next());
  } finally { await f.close(); }
});

test('Claude worker startup deadline reports unknown without replaying or terminating the possibly running worker', async () => {
  const f = await fixture('noack');
  try {
    await assert.rejects(f.turn[Symbol.asyncIterator]().next(), /unconfirmed/);
    assert.equal(await f.turn.inspectQuiescence(), false);
    assert.deepEqual(await f.turn.historyIdentities(), []);
  } finally { await f.close(); }
});

test('Claude worker failure never forwards private error text or produces quiescence proof', async () => {
  const f = await fixture('failed');
  try {
    await assert.rejects(f.turn[Symbol.asyncIterator]().next(), error => /unconfirmed/.test(String(error)) && !String(error).includes('PRIVATE'));
    await f.turn.finished;
    assert.equal(await f.turn.inspectQuiescence(), false);
  } finally { await f.close(); }
});

test('Claude native interrupted iterator can fail while durable identities and process exit remain available', async () => {
  const f = await fixture('stream-error');
  try {
    const events = [];
    await assert.rejects(async () => { for await (const event of f.turn) events.push(event); });
    assert.equal(events.length, 2);
    assert.equal(await f.turn.inspectQuiescence(), true);
    assert.equal((await f.turn.historyIdentities()).length, 1);
  } finally { await f.close(); }
});

test('Claude interrupt acknowledgment does not report worker completion', async () => {
  const f = await fixture('interrupt');
  try {
    await f.turn[Symbol.asyncIterator]().next();
    await f.turn.interrupt();
    assert.equal(await f.turn.inspectQuiescence(), false);
  } finally { await f.close(); }
});

test('Claude completion is acknowledged only after a busy parent drains and validates its terminal IPC', async () => {
  const f = await fixture('metric-good', true);
  try {
    for await (const event of f.turn) { void event; }
    assert.equal(f.metrics.length, 1);
    assert.equal(await f.turn.inspectQuiescence(), true);
    assert.deepEqual(JSON.parse(await readFile(f.ackFile, 'utf8')), {
      kind: 'finished-ack', id: f.request.execution.id, nativeSessionId: f.request.execution.nativeSessionId,
    });
  } finally { await f.close(); }
});

for (const mode of ['history-foreign', 'history-invalid-stream']) test(`Claude completion never acknowledges ${mode}`, async () => {
  const f = await fixture(mode);
  try {
    await assert.rejects(async () => { for await (const event of f.turn) { void event; } });
    await assert.rejects(readFile(f.ackFile), { code: 'ENOENT' });
    assert.equal(await f.turn.inspectQuiescence(), false);
  } finally { await f.close(); }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CopilotWorkerTurn } from './worker-turn.js';
import { CopilotWorkerPreflight } from './worker-preflight.js';
import type { CopilotWorkerStart } from './worker-protocol.js';
import type { SdkMetricSample } from '../connector/sdk-metrics.js';

async function fixture(mode = 'normal', preflight = false) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-copilot-worker-'));
  const homeDirectory = join(root, 'home'), workspace = join(root, 'workspace'), entry = join(root, 'fixture.mjs');
  await mkdir(homeDirectory, { mode: 0o700 }); await mkdir(workspace);
  await writeFile(entry, `
    process.on('message', message => {
      if (message.kind === 'interrupt') { process.send({kind:'interrupted'}); return; }
      const {execution:e, config:c} = message;
      if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.NODE_OPTIONS) process.exit(1);
      if (c.model === 'noack') return;
      if (c.model === 'failed') { process.send({kind:'failed', error:'PRIVATE'}); process.disconnect(); return; }
      if (message.kind === 'preflight') {
        process.send(c.model === 'extra' ? {kind:'preflight-complete', account:'PRIVATE'} : {kind:'preflight-complete'});
        setTimeout(() => process.disconnect(), 70); return;
      }
      process.send({kind:'verified', sessionId:c.model === 'wrong-session' ? 'foreign' : e.nativeSessionId,
        version:'1.0.85', protocolVersion:3});
      if (c.model === 'no-admission') return;
      process.send({kind:'event', event:{id:'u',type:'user.message',data:{messageId:'msg', content:'PRIVATE'}}});
      process.send({kind:'admitted',messageId:'msg'});
      if (c.model === 'interrupt') return;
      process.send({kind:'event',event:{id:'a',type:'assistant.message',data:{messageId:'reply',originatingMessageId:'msg',content:'PRIVATE'}}});
      if (c.model.startsWith('metric-')) {
        process.send({kind:'event',event:{id:'usage',type:'session.usage_info',data:{},
          ...(c.model === 'metric-child' ? {agentId:'child'} : {})}});
        process.send({kind:'metrics',nativeSessionId:c.model === 'metric-foreign' ? 'foreign' : e.nativeSessionId,
          sample:{eventId:c.model === 'metric-mismatch' ? 'foreign' : 'usage',sequence:1,
            context:{used:12,limit:100,basis:'native-context'},
            ...(c.model === 'metric-private' ? {private:'PRIVATE'} : {}),
            ...(c.model === 'metric-wrong-kind' ? {compacted:true} : {})}});
      }
      process.send({kind:'event',event:{id:'idle',type:'session.idle',data:{}}});
      process.send({kind:'finished',sessionId:e.nativeSessionId,history:[
        {id:'u',type:'user.message',messageId:'msg'}, {id:'a',type:'assistant.message',messageId:'reply',originatingMessageId:'msg'}]});
      setTimeout(() => { if(c.model === 'bad-exit') process.exitCode=1; process.disconnect(); }, 70);
    });
  `);
  const nativeSessionId = randomUUID();
  const request: CopilotWorkerStart = { kind: 'start', text: 'fixture',
    config: { homeDirectory, workspace, sdkDirectory: join(root, 'unused-sdk'), startupTimeoutMs: 200, model: mode,
      auth: { mode: 'github', credentialFile: join(root, 'unused-key') } },
    execution: { id: randomUUID(), key: `ghcp:${nativeSessionId}`, nativeSessionId, epoch: randomUUID(), nativeMode: 'create',
      members: ['message'], phase: 'dispatching', stopRequested: false, createdAt: 0, updatedAt: 0 } };
  const launch = { entry, execArgv: [] };
  const metrics: SdkMetricSample[] = [];
  const worker = preflight ? new CopilotWorkerPreflight(request.config, launch) : new CopilotWorkerTurn(request, launch, { metrics: sample => metrics.push(sample) });
  return { worker, request, metrics, close: async () => { worker.close(); await worker.finished; await rm(root, { recursive: true, force: true }); } };
}

for (const mode of ['good', 'foreign', 'mismatch', 'private', 'child', 'wrong-kind']) test(`Copilot metric IPC ${mode}: exact session/event/root scope`, async () => {
  const f = await fixture(`metric-${mode}`), worker = f.worker as CopilotWorkerTurn;
  try {
    const drain = async () => { for await (const _ of worker) { /* consume */ } };
    if (mode === 'good') { await drain(); assert.equal(f.metrics.length, 1); assert.equal(await worker.inspectQuiescence(), true); }
    else { await assert.rejects(drain()); assert.equal(f.metrics.length, 0); assert.equal(await worker.inspectQuiescence(), false); }
  } finally { await f.close(); }
});

test('Copilot worker validates handshake/ACK and sanitizes lifecycle, settling only after real exit', async () => {
  const f = await fixture(), worker = f.worker as CopilotWorkerTurn;
  try {
    assert.equal((await worker.verified).sessionId, f.request.execution.nativeSessionId);
    assert.equal((await worker.admitted).messageId, 'msg');
    assert.equal(await worker.inspectQuiescence(), false);
    const events = []; for await (const event of worker) events.push(event);
    assert.equal(events.length, 3); assert.equal(JSON.stringify(events).includes('PRIVATE'), false);
    assert.equal(await worker.inspectQuiescence(), true);
    assert.equal((await worker.historyIdentities()).entries.length, 2);
    await assert.rejects(worker[Symbol.asyncIterator]().next());
  } finally { await f.close(); }
});

for (const mode of ['failed', 'wrong-session', 'noack', 'no-admission', 'bad-exit']) {
  test(`Copilot worker ${mode} never confirms delivery/cleanup or echoes private diagnostics`, async () => {
    const f = await fixture(mode), worker = f.worker as CopilotWorkerTurn;
    try {
      await assert.rejects(async () => { for await (const _ of worker) { /* drain lifecycle */ } },
        error => /unconfirmed/.test(String(error)) && !String(error).includes('PRIVATE'));
      assert.equal(await worker.inspectQuiescence(), false);
    } finally { await f.close(); }
  });
}

test('Copilot interrupt ACK cannot be mistaken for native process cleanup', async () => {
  const f = await fixture('interrupt'), worker = f.worker as CopilotWorkerTurn;
  try {
    await worker.admitted; await worker.interrupt();
    assert.equal(await worker.inspectQuiescence(), false);
    assert.deepEqual((await worker.historyIdentities()).entries, []);
  } finally { await f.close(); }
});

for (const mode of ['normal', 'extra', 'failed', 'noack']) {
  test(`Copilot preflight ${mode} is control-only and requires exact ACK plus process exit`, async () => {
    const f = await fixture(mode, true), worker = f.worker as CopilotWorkerPreflight;
    try {
      assert.equal(await worker.ready, mode === 'normal');
      assert.equal(worker.inspectQuiescence(), true);
    } finally { await f.close(); }
  });
}

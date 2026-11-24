import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { newMaintenanceJob } from './connector-maintenance.js';
import { MaintenanceConnectorClient } from './maintenance-connector-client.js';
import { MaintenanceObservationUnavailable } from './maintenance-observation-error.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const job = newMaintenanceJob({ id: 'job:1', nodeId: 'node:1', actorId: 'actor:1', operation: 'restart', createdAt: 1000, deadline: 60_000 });
const observation = { nodeId: job.nodeId, observedAt: 2000, nativeVerified: true, activeRuns: 0,
  backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0 };
const headers = { [NODE_ID_HEADER]: job.nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1' };
const options = { connectorUrl: 'http://127.0.0.1:8792', nodeId: job.nodeId, credential: () => 'synthetic-private-token',
  authorize: () => {}, now: () => 2000 };

for (const phase of ['initial', 'after-fetch', 'failed-read', 'bound-503', 'body', 'final'] as const) {
  test(`asynchronous maintenance authority is refused without replay (${phase})`, async () => {
    let calls = 0, credentials = 0, checks = 0;
    const client = new MaintenanceConnectorClient({ ...options,
      credential: () => { credentials++; return 'synthetic-private-token'; },
      authorize: () => {
        checks++;
        if (phase === 'initial' || checks > (phase === 'final' ? 3 : 1)) return Promise.reject(Error('synthetic private denial'));
      },
      fetch: async () => {
        calls++;
        if (phase === 'failed-read') throw Error('synthetic private network error');
        if (phase === 'bound-503') return Response.json({}, { status: 503, headers });
        return Response.json(observation, { headers });
      },
    });
    await assert.rejects(phase === 'after-fetch' ? client.fence(job) : client.inspect(job), error => {
      assert.equal(error instanceof MaintenanceObservationUnavailable, false);
      assert.equal((error as Error).message, 'Connector maintenance response unavailable or unverified');
      return true;
    });
    assert.equal(calls, phase === 'initial' ? 0 : 1);
    assert.equal(credentials, phase === 'initial' ? 0 : 1);
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

for (const result of ['async', 'hidden-promise', 'thenable', 'getter', 'false', 'true'] as const) {
  test(`maintenance authority contract is fail-closed with safe logs (${result})`, async () => {
    let calls = 0, checks = 0, arbitraryCalls = 0;
    const lines: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
    const authorize = result === 'async' ? async () => { checks++; throw Error('synthetic private denial'); }
      : () => {
        checks++;
        if (result === 'hidden-promise') {
          const promise = Promise.reject(Error('synthetic private denial'));
          Object.defineProperty(promise, 'then', { get() { arbitraryCalls++; throw Error('synthetic private getter'); } });
          return promise;
        }
        if (result === 'thenable') return { then: () => { arbitraryCalls++; } };
        if (result === 'getter') return { get then() { arbitraryCalls++; throw Error('synthetic private getter'); } };
        return result === 'true';
      };
    const client = new MaintenanceConnectorClient({ ...options, authorize, diagnostics,
      fetch: async () => { calls++; return Response.json(observation, { headers }); } });
    await assert.rejects(client.inspect(job), /unavailable or unverified/);
    assert.equal(checks, result === 'async' ? 0 : 1);
    assert.equal(calls, 0); assert.equal(arbitraryCalls, 0);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]!);
    assert.equal(event.operation, 'maintenance-authority-check'); assert.equal(event.step, 1);
    assert.equal(event.category, 'failed'); assert.equal(event[result === 'async' ? 'deferred' : 'unknown'], 1);
    assert.ok(!lines[0]!.includes('synthetic')); assert.ok(!lines[0]!.includes(job.actorId));
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

for (const field of ['credential', 'now'] as const) {
  for (const result of ['async', 'promise', 'malformed'] as const) {
    test(`maintenance ${field} refuses async/malformed results without coercion (${result})`, async () => {
      let reads = 0, calls = 0, coercions = 0;
      const read = result === 'async' ? async () => { reads++; throw Error('synthetic private denial'); }
        : () => { reads++; return result === 'promise' ? Promise.reject(Error('synthetic private denial'))
          : { toString() { coercions++; return 'synthetic'; }, valueOf() { coercions++; return 2000; } }; };
      const client = new MaintenanceConnectorClient({ ...options,
        ...(field === 'credential' ? { credential: read as unknown as () => string } : { now: read as unknown as () => number }),
        fetch: async () => { calls++; return Response.json(observation, { headers }); },
      });
      await assert.rejects(client.inspect(job), /unavailable or unverified/);
      assert.equal(reads, result === 'async' ? 0 : 1); assert.equal(calls, 0); assert.equal(coercions, 0);
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

for (const kind of ['fetch', 'read', 'cancel', 'mutation'] as const) test(`noncooperative ${kind} settles at the deadline without retries`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const client = new MaintenanceConnectorClient({ ...options, fetch: async () => {
    calls++;
    if (kind === 'fetch' || kind === 'mutation') return new Promise<Response>(() => {});
    return new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}), cancel: () => new Promise<void>(() => {}),
    }), { status: kind === 'cancel' ? 503 : 200, headers });
  } });
  const shortJob = { ...job, deadline: 3000 };
  const pending = kind === 'mutation' ? client.fence(shortJob) : client.inspect(shortJob);
  const rejected = assert.rejects(pending, error => {
    assert.equal(error instanceof Error, true);
    assert.equal(error instanceof MaintenanceObservationUnavailable, kind === 'fetch' || kind === 'cancel');
    return true;
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000); await rejected;
  assert.equal(calls, 1);
});

test('inspection preserves bounded exact recovery identities, never arbitrary payloads', async () => {
  const run = { sessionKey: 'codex:interrupted', commandId: 'original', connectionId: 'connection', runId: 'run', revision: 7 };
  for (const recoveryRuns of [[run], [], [run, run], [{ ...run, revision: 0 }],
    [{ ...run, input: 'must not enter journal' }], [{ ...run, sessionKey: 'hermes:foreign' }]]) {
    const client = new MaintenanceConnectorClient({ ...options, fetch: async () => Response.json({
      ...observation, pendingExecutions: 1, recoveryRuns, privateExtra: 'not persisted',
    }, { headers }) });
    if (recoveryRuns.length === 1 && recoveryRuns[0] === run) {
      assert.deepEqual(await client.inspect(job), { ...observation, pendingExecutions: 1, recoveryRuns: [run] });
    } else await assert.rejects(client.inspect(job), /unverified/);
  }
});

test('recovered history may lack a reply only with the exact interrupted run proof', async () => {
  const run = { sessionKey: 'codex:early-stop', commandId: 'original', connectionId: 'connection', runId: 'run', revision: 7 };
  const recovering = { ...job, operation: 'recover' as const, recoveryRuns: [run], fenceId: 'a'.repeat(36),
    release: { revision: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) } };
  const proof = { nodeId: job.nodeId, observedAt: 2000, fenceId: recovering.fenceId, sessionKey: run.sessionKey,
    revision: recovering.release.revision, messageCount: 1, projectionVerified: true, businessReadVerified: true, recoveredRunId: run.runId };
  for (const patch of [{}, { recoveredRunId: undefined }, { recoveredRunId: 'another-run' }, { messageCount: 0 }]) {
    const client = new MaintenanceConnectorClient({ ...options, fetch: async () => Response.json({ ...proof, ...patch }, { headers }) });
    if (!Object.keys(patch).length) {
      assert.equal((await client.readiness(recovering, run.sessionKey)).recoveredRunId, run.runId);
      await assert.rejects(client.readiness({ ...recovering, operation: 'restart' }, run.sessionKey));
      await assert.rejects(client.readiness({ ...recovering, recoveryRuns: [] }, run.sessionKey));
    } else await assert.rejects(client.readiness(recovering, run.sessionKey));
  }
});

test('only correctly bound inspection 503 or failed read transport are classified for retry', async () => {
  for (const kind of ['503', 'network', 'foreign', 'protocol', '403', '501', 'invalid', 'revoked'] as const) {
    let authorized = true, calls = 0;
    const client = new MaintenanceConnectorClient({ ...options,
      authorize() { if (!authorized) throw new Error('private revoked credential'); },
      fetch: async () => {
        calls++;
        if (kind === 'network') throw new Error('private transport details');
        if (kind === 'revoked') authorized = false;
        return Response.json({ privateError: 'must not escape' }, {
          status: kind === '403' ? 403 : kind === '501' ? 501 : kind === 'invalid' ? 200 : 503,
          headers: { ...headers, ...(kind === 'foreign' ? { [NODE_ID_HEADER]: 'other' } : {}),
            ...(kind === 'protocol' ? { [CONNECTOR_PROTOCOL_HEADER]: '2' } : {}) },
        });
      } });
    await assert.rejects(client.inspect(job), error => {
      assert.equal(error instanceof MaintenanceObservationUnavailable, ['503', 'network'].includes(kind));
      assert.equal(String(error).includes('private'), false);
      return true;
    });
    assert.equal(calls, 1, 'transport never loops or retries on its own');
  }
});

test('even a correctly bound 503 mutation response is never retryable', async () => {
  const client = new MaintenanceConnectorClient({ ...options,
    fetch: async () => Response.json({}, { status: 503, headers }) });
  await assert.rejects(client.fence(job), error => error instanceof Error && !(error instanceof MaintenanceObservationUnavailable));
});

test('transport validates loopback-only operator configuration before any fetch', () => {
  for (const connectorUrl of ['https://example.test', 'http://localhost:8792', 'http://127.0.0.1:8792/path',
    'http://user:secret@127.0.0.1:8792', 'http://127.0.0.1:8792/?query', 'http://127.0.0.1:8792/#hash']) {
    assert.throws(() => new MaintenanceConnectorClient({ ...options, connectorUrl }), /loopback/);
  }
});

test('inspection binds protocol/node, rejects incomplete/stale proofs and never trusts HTTP success alone', async () => {
  const response = (data: unknown, extra: ResponseInit = {}) => Response.json(data, { headers, ...extra });
  for (const [data, init] of [
    [{ ...observation, backgroundTerminals: undefined }, {}], [{ ...observation, pendingExecutions: -1 }, {}],
    [{ ...observation, observedAt: 2001 }, {}], [{ ...observation, observedAt: -4000 }, {}],
    [{ ...observation, nativeVerified: false }, {}], [observation, { headers: {} }],
    [observation, { headers: { ...headers, [NODE_ID_HEADER]: 'other' } }],
    [observation, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '2' } }],
    [observation, { status: 202 }], ['secret upstream error', { status: 503 }],
  ] as [unknown, ResponseInit][]) {
    let calls = 0;
    const client = new MaintenanceConnectorClient({ ...options, fetch: async input => {
      const request = input as Request;
      calls++; assert.equal(request?.redirect, 'error');
      const sent = new Headers(request?.headers);
      assert.equal(sent.get(EXPECTED_NODE_HEADER), job.nodeId); assert.equal(sent.get(CONNECTOR_PROTOCOL_HEADER), '1');
      return response(data, init);
    } });
    await assert.rejects(client.inspect(job), error => error instanceof Error && error.message === 'Connector maintenance response unavailable or unverified');
    assert.equal(calls, 1);
  }
});

test('a lost mutation response, unknown receipt, wrong command identity or changed authority never retries', async () => {
  for (const kind of ['lost', 'unknown', 'identity', 'revoked'] as const) {
    let calls = 0, authorized = true;
    const client = new MaintenanceConnectorClient({ ...options, authorize() { if (!authorized) throw new Error('private authority data'); },
      fetch: async input => {
        const request = input as Request;
        calls++;
        if (kind === 'lost') throw new Error('secret upstream network error');
        if (kind === 'revoked') authorized = false;
        const { idempotencyKey } = await request.json();
        const fenceId = 'a'.repeat(36);
        return Response.json({ state: 'paused', boundary: 'admission_only', nativeQuiescent: false, fenceId,
          command: { state: kind === 'unknown' ? 'outcome_unknown' : 'accepted',
            id: kind === 'identity' ? 'b'.repeat(36) : fenceId, key: idempotencyKey } }, { headers });
      } });
    await assert.rejects(client.fence(job), /unavailable or unverified/);
    assert.equal(calls, 1);
  }
});

test('body size and late revocation are enforced while reading; original fence must match', async () => {
  const oversized = new MaintenanceConnectorClient({ ...options, fetch: async () => new Response('x'.repeat(32769), { headers }) });
  await assert.rejects(oversized.inspect(job), /unverified/);
  let authorized = true;
  const revoked = new MaintenanceConnectorClient({ ...options, authorize() { if (!authorized) throw new Error('revoked'); },
    fetch: async () => new Response(new ReadableStream({ pull(controller) {
      authorized = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(observation))); controller.close();
    } }), { headers }) });
  await assert.rejects(revoked.inspect(job), /unverified/);
  const otherFence = new MaintenanceConnectorClient({ ...options, fetch: async () => Response.json({ ...observation, fenceId: 'a'.repeat(36) }, { headers }) });
  await assert.rejects(otherFence.inspect({ ...job, fenceId: 'b'.repeat(36) }), /unverified/);
});

test('fresh native evidence is whitelisted and foreign or expired jobs never use the credential', async () => {
  let credentials = 0;
  const client = new MaintenanceConnectorClient({ ...options, credential: () => { credentials++; return 'synthetic-private-token'; },
    fetch: async () => Response.json({ ...observation, privateExtra: 'must not be persisted' }, { headers }) });
  assert.deepEqual(await client.inspect(job), observation);
  assert.equal(credentials, 1);
  await assert.rejects(client.inspect({ ...job, nodeId: 'other' }), /unverified/);
  await assert.rejects(client.inspect({ ...job, deadline: 2000 }), /unverified/);
  assert.equal(credentials, 1);
});

for (const runtime of ['codex', 'claude-code']) test(`${runtime} business readiness binds original history, fence and pinned revision`, async () => {
  const fenced = { ...job, fenceId: 'a'.repeat(36), release: { revision: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) } };
  const proof = { nodeId: job.nodeId, observedAt: 2000, fenceId: fenced.fenceId, sessionKey: `${runtime}:history`,
    revision: fenced.release.revision, messageCount: 2, projectionVerified: true, businessReadVerified: true };
  for (const change of [{}, { nodeId: 'other' }, { fenceId: 'b'.repeat(36) }, { sessionKey: 'codex:other' },
    { revision: 'd'.repeat(40) }, { observedAt: 2001 }, { observedAt: -4000 }, { messageCount: 0 },
    { messageCount: 1.5 }, { projectionVerified: false }, { businessReadVerified: undefined }]) {
    let calls = 0;
    const client = new MaintenanceConnectorClient({ ...options, fetch: async input => {
      const request = input as Request;
      calls++;
      assert.equal(request.url.endsWith('/maintenance/readiness'), true);
      assert.equal(request?.method, 'POST'); assert.equal(request?.redirect, 'error');
      assert.deepEqual(await request.json(), { fenceId: fenced.fenceId, sessionKey: proof.sessionKey });
      return Response.json({ ...proof, ...change, transcript: 'private contents' }, { headers });
    } });
    if (Object.keys(change).length) await assert.rejects(client.readiness(fenced, proof.sessionKey), /unverified/);
    else assert.deepEqual(await client.readiness(fenced, proof.sessionKey), proof);
    assert.equal(calls, 1);
  }
});

test('readiness rejects unfenced or invalid requests before reading credentials and snapshots local policy', async () => {
  let credentials = 0;
  const configuration = { ...options, credential: () => { credentials++; return 'synthetic'; },
    fetch: async () => Response.json(observation, { headers }) };
  const client = new MaintenanceConnectorClient(configuration);
  configuration.nodeId = 'other'; configuration.credential = () => { throw new Error('changed'); };
  assert.deepEqual(await client.inspect(job), observation);
  assert.equal(credentials, 1);
  for (const key of ['codex:history', '../secret', 'hermes:history']) {
    await assert.rejects(client.readiness(job, key), /unverified/);
  }
  assert.equal(credentials, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { AutomationConfiguration } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import type { CodexAutomationCompletion } from '../codex/automation-completions.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncAutomationBackground } from './async-automation-background.js';
import { validConnectorAutomationBackgroundInput, validConnectorAutomationBackgroundOutput } from './connector-automation-background-domain.js';

const key = 'codex:background', connection = 'original-native-connection';
const silence = new PerformanceDiagnostics(() => {});
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function fixture(t: test.TestContext, rollback = false) {
  const directory = mkdtempSync(join(tmpdir(), 'automation-background-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: 'isolated-background' };
  const tokens = new ConnectorTokenStore(config.tokenFile, config.bootstrapToken);
  const credential = tokens.create({ label: 'original', scopes: ['automation:manage', 'messages:send'] });
  const actor = credential.record.id, authorization = `Bearer ${credential.token}`;
  const seed = new ConnectorUserStore(config.file, undefined, { runtimeOwner: true });
  const nodeId = seed.nodeId;
  seed.codexExecutions.begin(key, 'original-command', connection);
  seed.codexExecutions.acknowledge(key, 'original-command', connection, 'original-run', () => {});
  // Schema and rollback injection are isolated setup, never live main-thread SQL.
  const service = seed.createCodexAutomation({ owns: () => true, automationObservation: () => { throw Error('setup only'); },
    takeAutomationCompletions: () => [], send: async () => { throw Error('setup only'); } }, actor, nodeId, () => true);
  service.scheduler.stop(); seed.close();
  if (rollback) {
    const db = new DatabaseSync(config.file);
    try { db.exec("CREATE TRIGGER refuse_automation_receipt BEFORE INSERT ON automation_queue_receipts BEGIN SELECT RAISE(ABORT, 'isolated rollback'); END"); }
    finally { db.close(); }
  }
  let owner = new AsyncConnectorOwner(config, silence); await owner.open();
  const hosts: AsyncAutomationBackground[] = [];
  t.after(async () => { try { for (const host of hosts) await host.close(); await owner.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); } });
  const now = Date.now();
  const rule: AutomationConfiguration = { kind: 'save', rule: { id: 'rule', revision: 1, authorityEpoch: 1,
    target: { ownerId: actor, connectionId: nodeId, runtime: 'codex', sessionId: key }, enabled: true,
    startsAt: now - 10000, expiresAt: now + 3600000, maxSends: 3, maxPerHour: 3, minIntervalMs: 60000,
    mode: { kind: 'completion', allowOwnTurns: false } }, template: 'PRIVATE background template', expectedRevision: 0, confirmEnable: true };
  assert.equal((await owner.command('automationConfigure', { authorization, requestId: 'configure', configuration: rule })).ok, true);
  const observe = () => ({ sessionKey: key, connectionId: connection, now: Date.now(), connectedSince: now - 1000, online: true, idle: true });
  const plan = async () => {
    const p = await owner.command('automationBackgroundPlan', { after: '' }); assert.ok(p); assert.equal(p.ownerId, actor);
    assert.deepEqual(p.targets, [key]); return p;
  };
  const terminal = async () => {
    await delay(2); const completedAt = Date.now();
    await owner.command('codexExecutionObserve', { sessionKey: key, connectionId: connection, runId: 'original-run', phase: 'completed', expected: null });
    const expected = await owner.command('codexExecutionRead', { sessionKey: key }); assert.ok(expected);
    assert.equal(await owner.command('codexNativeHistorySettle', { expected, checkpoint: { turnId: 'original-run',
      connectionId: connection, fingerprint: 'a'.repeat(64), state: 'verified', reason: 'settled' } }), true);
    return { actorId: actor, sessionKey: key, commandId: 'original-command', connectionId: connection,
      turnId: 'original-run', startedAt: now - 500, completedAt } satisfies CodexAutomationCompletion;
  };
  const poll = (id: string, event: CodexAutomationCompletion, changes: Partial<ReturnType<typeof observe>> = {}) =>
    owner.command('automationBackgroundPoll', { planId: id, observations: [{ ...observe(), ...changes }], completions: [event] });
  const inspect = async () => {
    await owner.close(); const db = new DatabaseSync(config.file, { readOnly: true });
    try { return { queue: db.prepare('SELECT * FROM connector_turns').all(),
      proofs: db.prepare('SELECT * FROM automation_queue_receipts').all(),
      reservations: db.prepare('SELECT * FROM automation_reservations').all() }; } finally { db.close(); }
  };
  return { actor, authorization, observe, plan, terminal, poll, hosts, inspect, config, rule,
    get owner() { return owner; }, async reopen() { await owner.close(); owner = new AsyncConnectorOwner(config, silence); await owner.open(); } };
}

test('real worker completion uses the original atomic FIFO/immutable receipt, not a second native sender', async t => {
  const f = await fixture(t), p = await f.plan(), e = await f.terminal();
  const result = await f.poll(p.id, e); assert.equal(result.queued.length, 1);
  const h = result.queued[0]!; assert.equal(h.sessionKey, key); assert.equal(h.text, 'PRIVATE background template'); assert.ok(h.queueVersion);
  await assert.rejects(f.poll(p.id, e), /unavailable/);
  assert.deepEqual(await f.poll((await f.plan()).id, e), { queued: [] });
  const rows = await f.inspect(); assert.equal(rows.queue.length, 1); assert.equal(rows.proofs.length, 1); assert.equal(rows.reservations.length, 1);
  assert.equal(rows.proofs[0]!.native_id, h.id); assert.equal(rows.reservations[0]!.state, 'queued');
  assert.equal(JSON.parse(String(rows.queue[0]!.payload)).actorId, f.actor);
});

for (const fault of ['revoked', 'offline', 'goal', 'stale', 'connection', 'history', 'command', 'foreign-owner', 'maintenance'] as const) {
  test(`worker original authority and native history veto ${fault} before FIFO admission`, async t => {
    const f = await fixture(t), p = await f.plan(), e = await f.terminal();
    const change: Partial<ReturnType<typeof f.observe>> = {};
    if (fault === 'revoked') await f.owner.command('tokenRevoke', { tokenId: f.actor });
    if (fault === 'offline') change.online = false;
    if (fault === 'goal') change.idle = false;
    if (fault === 'stale') change.now = Date.now() - 10000;
    if (fault === 'connection') change.connectionId = 'replacement';
    if (fault === 'history') await f.owner.command('codexNativeHistoryInvalidate', { sessionKey: key, reason: 'changed', readableSuccessorTurnId: null });
    if (fault === 'command') e.commandId = 'foreign-command';
    if (fault === 'foreign-owner') e.actorId = 'foreign-owner';
    if (fault === 'maintenance') await f.owner.command('maintenancePause', {});
    if (fault === 'foreign-owner') await assert.rejects(f.poll(p.id, e), /unavailable/);
    else assert.deepEqual(await f.poll(p.id, e, change), { queued: [] });
    const rows = await f.inspect(); assert.equal(rows.queue.length, 0); assert.equal(rows.proofs.length, 0);
  });
}

test('same transaction receipt failure rolls back FIFO and never replays the consumed completion', async t => {
  const f = await fixture(t, true), p = await f.plan(), e = await f.terminal();
  assert.deepEqual(await f.poll(p.id, e), { queued: [] });
  await assert.rejects(f.poll(p.id, e), /unavailable/);
  assert.deepEqual(await f.poll((await f.plan()).id, e), { queued: [] });
  const rows = await f.inspect(); assert.equal(rows.queue.length, 0); assert.equal(rows.proofs.length, 0);
  assert.equal(rows.reservations.length, 1); assert.equal(rows.reservations[0]!.state, 'unknown');
});

test('restart does not catch up old completion or requeue an original committed receipt', async t => {
  const f = await fixture(t), p = await f.plan(), e = await f.terminal();
  assert.equal((await f.poll(p.id, e)).queued.length, 1);
  await f.reopen();
  assert.deepEqual(await f.poll((await f.plan()).id, e), { queued: [] });
  const rows = await f.inspect(); assert.equal(rows.queue.length, 1); assert.equal(rows.proofs.length, 1);
});

test('plan binding is one-use, exact-target and cannot be replaced by caller authority', async t => {
  const f = await fixture(t), p = await f.plan(), e = await f.terminal();
  assert.equal(validConnectorAutomationBackgroundInput('automationBackgroundPoll', { planId: p.id, observations: [f.observe()],
    completions: [{ ...e, authoritative: true }] }), false);
  await assert.rejects(f.owner.command('automationBackgroundPoll', { planId: p.id, observations: [], completions: [e] }), /unavailable/);
  await assert.rejects(f.poll(p.id, e), /unavailable/);
  await f.owner.command('automationBackgroundStop', {});
  await assert.rejects(f.plan(), /unavailable/);
});

test('SQL-free host projects original queued wire shape and wakes the original scheduler', async t => {
  const f = await fixture(t), messages: unknown[] = []; let wake = 0, completions: CodexAutomationCompletion[] = [];
  const logs: string[] = [];
  const host = new AsyncAutomationBackground({ owner: { command: (async (kind: any, input: any) => {
    const result = await f.owner.command(kind, input);
    if (kind === 'automationBackgroundPlan' && result && !completions.length && !messages.length) completions = [await f.terminal()];
    return result;
  }) as AsyncConnectorOwner['command'] }, runtime: { stopConnectionId: connection,
    ownedAutomationObservation: () => { const { sessionKey: _, connectionId: __, ...v } = f.observe(); return v; },
    takeOwnedAutomationCompletions: () => { const events = completions; completions = []; return events; } },
    deck: { addMessage: m => { messages.push(m); } }, scheduling: { notifyAdmission: () => { wake++; } },
    diagnostics: new PerformanceDiagnostics(row => logs.push(row)) });
  f.hosts.push(host); host.start(false); await host.tick();
  assert.equal(messages.length, 1); assert.equal(wake, 1);
  assert.equal((messages[0] as any).queueDisposition, 'preparing'); assert.equal((messages[0] as any).status, 'queued');
  assert.doesNotMatch(logs.join('\n'), /PRIVATE|original-native|codex:background|original-command/);
});

for (const fault of ['close', 'reconnect', 'lost-reply', 'view-failure'] as const) test(`host ${fault} drains physical admission without resend or stale publication`, async t => {
  const f = await fixture(t), entered = gate(), release = gate(); let held = true, wakes = 0, messages = 0;
  let completions: CodexAutomationCompletion[] = [], current: string | null = connection;
  const port = { command: (async (kind: any, input: any) => {
    const result = await f.owner.command(kind, input);
    if (kind === 'automationBackgroundPlan' && result && held) completions = [await f.terminal()];
    if (kind === 'automationBackgroundPoll' && held) { held = false; entered.release(); await release.promise;
      if (fault === 'lost-reply') throw Error('lost physical reply'); }
    return result;
  }) as AsyncConnectorOwner['command'] };
  const host = new AsyncAutomationBackground({ owner: port, runtime: { get stopConnectionId() { return current; },
    ownedAutomationObservation: () => { const { sessionKey: _, connectionId: __, ...v } = f.observe(); return v; },
    takeOwnedAutomationCompletions: () => { const events = completions; completions = []; return events; } },
    deck: { addMessage: () => { if (fault === 'view-failure') throw Error('failed view subscriber'); messages++; } },
    scheduling: { notifyAdmission: () => { wakes++; } }, diagnostics: silence });
  f.hosts.push(host); host.start(false);
  const work = host.tick(); assert.equal(host.tick(), work); await entered.promise;
  // Public waiter mutation cannot substitute for physical completion.
  if (fault === 'close') work.catch = (() => Promise.resolve()) as typeof work.catch;
  if (fault === 'reconnect') current = 'replacement';
  let closed = false; const closing = fault === 'close' ? host.close().then(() => { closed = true; }) : undefined;
  try { await delay(5); assert.equal(closed, false); } finally { release.release(); }
  if (fault === 'lost-reply' || fault === 'view-failure') await assert.rejects(work, /unavailable/); else await work;
  await closing; assert.equal(messages, 0); assert.equal(wakes, fault === 'lost-reply' ? 0 : 1);
  await host.tick(); await host.close(); assert.throws(() => host.start(false), /unavailable/);
  const rows = await f.inspect(); assert.equal(rows.queue.length, 1); assert.equal(rows.proofs.length, 1);
});

test('worker drives original future timer cursor once and skips old slots on reopen', async t => {
  const f = await fixture(t), due = Date.now() + 2000;
  assert.equal(f.rule.kind, 'save'); if (f.rule.kind !== 'save') return;
  const configuration: AutomationConfiguration = { ...f.rule, expectedRevision: 1,
    rule: { ...f.rule.rule, revision: 2, authorityEpoch: 2, mode: { kind: 'once', at: due } } };
  assert.equal((await f.owner.command('automationConfigure', { authorization: f.authorization, requestId: 'timer', configuration })).ok, true);
  const p = await f.plan(), e = await f.terminal();
  // A once timer configured before start is not a completion rule.
  assert.deepEqual(await f.poll(p.id, e), { queued: [] });
  await delay(Math.max(0, due - Date.now() + 5));
  assert.equal((await f.owner.command('automationBackgroundPoll', { planId: (await f.plan()).id,
    observations: [f.observe()], completions: [] })).queued.length, 1);
  assert.deepEqual(await f.poll((await f.plan()).id, e), { queued: [] });
  await f.reopen();
  assert.deepEqual(await f.poll((await f.plan()).id, e), { queued: [] });
  const rows = await f.inspect(); assert.equal(rows.queue.length, 1); assert.equal(rows.proofs.length, 1);
});

test('host validates the entire queued result before publishing any mismatched target', async () => {
  let messages = 0, wakes = 0;
  const hint = (sessionKey: string) => ({ sessionKey, id: `${sessionKey}:codex-queued-id`, text: 'template', createdAt: 1, queueVersion: '1:1' });
  const host = new AsyncAutomationBackground({ owner: { command: (async (kind: string) => {
    if (kind === 'automationBackgroundPlan') return { id: 'plan', ownerId: 'owner', targets: [key] };
    if (kind === 'automationBackgroundPoll') return { queued: [hint(key), hint('codex:foreign')] };
    return null;
  }) as AsyncConnectorOwner['command'] }, runtime: { stopConnectionId: connection,
    ownedAutomationObservation: () => ({ now: Date.now(), connectedSince: 1, online: true, idle: true }), takeOwnedAutomationCompletions: () => [] },
    deck: { addMessage: () => { messages++; } }, scheduling: { notifyAdmission: () => { wakes++; } }, diagnostics: silence });
  host.start(false); await assert.rejects(host.tick(), /unavailable/); await host.close();
  assert.equal(messages, 0); assert.equal(wakes, 0);
});

for (const boundary of ['automationBackgroundPlan', 'automationBackgroundPoll'] as const) {
  test(`maintenance drains physical ${boundary} without consuming or replaying original completion`, async t => {
    const f = await fixture(t), entered = gate(), release = gate();
    let events: CodexAutomationCompletion[] = [], seeded = false, consumed = 0, held = true, polls = 0, wake = 0;
    const messages: unknown[] = [];
    const host = new AsyncAutomationBackground({ owner: { command: (async (kind: any, input: any) => {
      const result = await f.owner.command(kind, input);
      // Production ignores completions older than scheduler startup. Seed the
      // terminal after the original first plan, not before its activation.
      if (kind === 'automationBackgroundPlan' && result && !seeded) { seeded = true; events = [await f.terminal()]; }
      if (kind === 'automationBackgroundPoll') polls++;
      if (kind === boundary && held) { held = false; entered.release(); await release.promise; }
      return result;
    }) as AsyncConnectorOwner['command'] }, runtime: { stopConnectionId: connection,
      ownedAutomationObservation: () => { const { sessionKey: _, connectionId: __, ...v } = f.observe(); return v; },
      takeOwnedAutomationCompletions: () => { consumed++; const original = events; events = []; return original; } },
      deck: { addMessage: value => { messages.push(value); return value; } }, scheduling: { notifyAdmission: () => { wake++; } }, diagnostics: silence });
    f.hosts.push(host); host.start(false);
    const visible = host.tick(), physical = Promise.prototype.then.call(visible, () => {});
    await entered.promise;
    try {
      Object.defineProperty(visible, 'then', { value: () => Promise.resolve() });
      const pause = host.pause(); assert.equal(host.pause(), pause); assert.equal(pause.resume(), false);
      let drained = false; void pause.drained.then(() => { drained = true; });
      await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
      await host.tick(); assert.equal(polls, boundary === 'automationBackgroundPoll' ? 1 : 0);
      release.release(); await physical; await pause.drained;
      if (boundary === 'automationBackgroundPlan') {
        assert.equal(consumed, 0); assert.equal(messages.length, 0);
      } else { assert.equal(consumed, 1); assert.equal(messages.length, 1); }
      assert.equal(pause.resume(), true); assert.equal(pause.resume(), false);
      await host.tick(); assert.equal(messages.length, 1); assert.equal(wake, 1);
      const stale = host.pause(); await stale.drained; await host.close(); assert.equal(stale.resume(), false);
      assert.throws(() => host.pause());
    } finally { release.release(); }
  });
}

test('local readiness veto prevents background plans before runtime startup and during maintenance', async () => {
  let available = false, plans = 0;
  const host = new AsyncAutomationBackground({ owner: { command: (async (kind: string) => {
    if (kind === 'automationBackgroundPlan') plans++;
    return null;
  }) as AsyncConnectorOwner['command'] }, runtime: { stopConnectionId: null,
    ownedAutomationObservation: () => { throw Error('not ready'); }, takeOwnedAutomationCompletions: () => [] },
    deck: { addMessage: value => value }, scheduling: { notifyAdmission() {} }, available: () => available, diagnostics: silence });
  try {
    host.start(false); await host.tick(); assert.equal(plans, 0);
    available = true; await host.tick(); assert.equal(plans, 1);
    available = false; await host.tick(); assert.equal(plans, 1);
  } finally { await host.close(); }
});

test('private background validators reject extra authority, malformed observations and oversize hints', () => {
  assert.equal(validConnectorAutomationBackgroundInput('automationBackgroundPlan', { after: '', ownerId: 'forged' }), false);
  assert.equal(validConnectorAutomationBackgroundInput('automationBackgroundStop', { force: true }), false);
  assert.equal(validConnectorAutomationBackgroundOutput('automationBackgroundPoll', { queued: [{ sessionKey: key,
    id: 'id', text: 'x'.repeat(8193), createdAt: 1, queueVersion: 'v' }] }), false);
});

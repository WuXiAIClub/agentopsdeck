import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from '@agentopsdeck/shared';
import { ConnectorUserStore } from './connector-user-store.js';
import { executeConnectorCodexFileIndex, validConnectorCodexFileIndexInput, CODEX_FILE_INDEX_COMMAND_BYTES,
  type CodexFileIndexInput } from './connector-codex-file-index-domain.js';
import { connectorOwnerCommandBytes, connectorOwnerLargeInput, validConnectorOwnerInput,
  encodeConnectorOwnerJson, encodeConnectorOwnerInput } from './connector-owner-domain.js';
import { projectionFileEvidence, FILE_INDEX_ROWS, FILE_INDEX_BYTES, FILE_PROJECTION_BYTES } from '../messages/session-file-evidence.js';

const key = 'codex:index', kind = 'codexFileIndexProjection';
const message = (i: number): ChatMessage => ({ id: `file:${i}`, sessionKey: key, role: 'tool', toolPhase: 'result', status: 'sent',
  text: 'PRIVATE_BODY', createdAt: i, sourceFiles: [{ path: `/workspace/${i}.ts`, kind: 'modified' }] });
const input = (owner: ConnectorUserStore, messages = [message(1)]): CodexFileIndexInput => ({ sessionKey: key,
  expected: owner.codexExecutions.get(key) ?? null, evidence: projectionFileEvidence(key, messages) });
const execute = (owner: ConnectorUserStore, value = input(owner)) => executeConnectorCodexFileIndex(kind, value, owner);

test('file-index fixed DTO rejects raw payload, authority, arbitrary rows and mismatched snapshots before SQL', () => {
  const base: CodexFileIndexInput = { sessionKey: key, expected: null, evidence: projectionFileEvidence(key, [message(1)]) };
  const row = { path: '/workspace/a', kind: 'modified', messageId: 'm', createdAt: 1 };
  const evidence = (rows: unknown[]) => ({ index: { rows, limited: false }, snapshot: { rows, limited: false } });
  const forbidden = new Proxy({}, { get() { assert.fail('invalid evidence touched SQL'); } }) as ConnectorUserStore;
  assert.equal(validConnectorCodexFileIndexInput(kind, base), true);
  for (const forged of [
    { ...base, authorized: true }, { ...base, expected: {} }, { ...base, sessionKey: 'codex:' },
    { ...base, evidence: { ...base.evidence, text: 'private' } },
    ...[ { ...row, text: 'private' }, { ...row, path: '/repo/../secret' }, { ...row, kind: 'unknown' },
      { ...row, createdAt: -1 }, { ...row, createdAt: 1.5 }, { ...row, messageId: '' } ].map(row => ({ ...base, evidence: evidence([row]) })),
    { ...base, evidence: evidence([row, row]) }, { ...base, evidence: { invalid: true, rows: [] } },
    { ...base, evidence: { index: { rows: [row], limited: false }, snapshot: { rows: [], limited: false } } },
    { ...base, evidence: { index: { rows: [], limited: true }, snapshot: { rows: [], limited: false } } },
  ]) {
    assert.equal(validConnectorCodexFileIndexInput(kind, forged), false, JSON.stringify(forged));
    assert.throws(() => execute(forbidden, forged as any), /unavailable/);
  }
});

test('pure extraction preserves independent original row budgets without accessing tool bodies', () => {
  const messages = Array.from({ length: 10_001 }, (_, i) => message(i));
  Object.defineProperty(messages[0], 'text', { get() { assert.fail('metadata extraction read body'); } });
  const evidence = projectionFileEvidence(key, messages);
  assert.ok(!('invalid' in evidence));
  assert.equal(evidence.index.rows.length, FILE_INDEX_ROWS);
  assert.equal(evidence.snapshot.rows.length, 10_000);
  assert.equal(evidence.index.rows[0]!.messageId, 'file:6001');
  assert.equal(evidence.snapshot.rows[0]!.messageId, 'file:1');
  assert.ok(evidence.index.limited && evidence.snapshot.limited);
  assert.equal(validConnectorCodexFileIndexInput(kind, { sessionKey: key, expected: null, evidence }), true);
  const request = { sessionKey: key, expected: null, evidence };
  assert.throws(() => encodeConnectorOwnerJson(request, CODEX_FILE_INDEX_COMMAND_BYTES), /unavailable/);
  assert.deepEqual(JSON.parse(encodeConnectorOwnerInput(kind, request)), request);
  assert.throws(() => encodeConnectorOwnerInput('eventProjectionAppend', request), /unavailable/);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_BODY/);
  assert.equal(connectorOwnerCommandBytes(kind), CODEX_FILE_INDEX_COMMAND_BYTES);
  assert.equal(connectorOwnerLargeInput(kind, Buffer.byteLength(JSON.stringify(evidence))), true);
});

test('metadata encoder retains strict descriptors, cycles, byte and structural limits', () => {
  const base = { sessionKey: key, expected: null, evidence: { invalid: true } };
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { getterCalls++; return 1; } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [accessor, cyclic, { ...base, [Symbol('authority')]: true },
    { ...base, value: 'x'.repeat(CODEX_FILE_INDEX_COMMAND_BYTES) },
    { value: Array.from({ length: 16_384 }, () => Array(16).fill(null)) }]) {
    assert.throws(() => encodeConnectorOwnerInput(kind, value), /unavailable/);
  }
  assert.equal(getterCalls, 0);
  const oversized = { sessionKey: key, expected: null, evidence: projectionFileEvidence(key, [message(1)]) };
  assert.ok(!('invalid' in oversized.evidence));
  oversized.evidence.snapshot.rows = Array.from({ length: 10_001 }, (_, index) => ({
    path: `/workspace/${index}.ts`, kind: 'modified' as const, messageId: `file:${index}`, createdAt: index,
  }));
  assert.equal(validConnectorOwnerInput(kind, JSON.parse(encodeConnectorOwnerInput(kind, oversized))), false);
});

test('UTF-8 byte budgets, scan limit, many files per message and duplicate conflicts retain original semantics', () => {
  const messages = Array.from({ length: 1100 }, (_, i) => ({ ...message(i), id: `${i}:${'用'.repeat(1300)}` }));
  const e = projectionFileEvidence(key, messages);
  assert.ok(!('invalid' in e));
  assert.ok(e.index.limited && e.snapshot.limited);
  const bytes = (rows: typeof e.index.rows) => rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row)), 0);
  assert.ok(bytes(e.index.rows) <= FILE_INDEX_BYTES && bytes(e.snapshot.rows) <= FILE_PROJECTION_BYTES);
  assert.ok(validConnectorOwnerInput(kind, { sessionKey: key, expected: null, evidence: e }));
  const manyFiles = { ...message(0), sourceFiles: Array.from({ length: 16 }, (_, i) => ({ path: `/workspace/${i}.ts`, kind: 'added' as const })) };
  const batch = projectionFileEvidence(key, [manyFiles]);
  assert.ok(!('invalid' in batch)); assert.equal(batch.index.rows.length, 16);
  assert.equal(validConnectorCodexFileIndexInput(kind, { sessionKey: key, expected: null, evidence: batch }), true);
  assert.deepEqual(projectionFileEvidence(key, [message(1), { ...message(1), createdAt: 2 }]), { invalid: true });
  const scan = projectionFileEvidence(key, [message(1), ...Array.from({ length: 100_000 }, () => ({ ...message(2), role: 'assistant' as const }))]);
  assert.ok(!('invalid' in scan)); assert.deepEqual(scan.index, { rows: [], limited: true });
});

test('sole owner exact execution CAS/deletion protects metadata, never transitions journal', () => {
  const owner = new ConnectorUserStore(':memory:');
  try {
    const external = input(owner);
    assert.equal(execute(owner, external), true);
    owner.codexExecutions.begin(key, 'command', 'connection');
    assert.equal(execute(owner, external), false);
    owner.codexExecutions.acknowledge(key, 'command', 'connection', 'run', () => {});
    const observed = input(owner, [message(2)]), fact = structuredClone(observed.expected);
    assert.equal(execute(owner, observed), true);
    assert.deepEqual(owner.codexExecutions.get(key), fact);
    owner.codexExecutions.observeCommandTool(key, 'connection', 'run', 'tool', false);
    assert.equal(execute(owner, { ...observed, evidence: projectionFileEvidence(key, [message(3)]) }), false);
    assert.deepEqual(owner.fileIndex.page(key).entries.map(e => e.messageId), ['file:2']);
    owner.commands.sessionDeletion = () => 'accepted';
    assert.equal(execute(owner), false);
  } finally { owner.close(); }
});

test('owned and original sync projections have identical content, idempotence and optional rollback/stale behavior', () => {
  const owner = new ConnectorUserStore(':memory:'), original = new ConnectorUserStore(':memory:');
  try {
    const messages = [message(1), message(2)];
    original.fileIndex.replaceProjection(key, messages);
    execute(owner, input(owner, messages));
    const first = owner.fileIndex.page(key), binding = owner.fileIndex.projectionBinding(key)!;
    assert.deepEqual(first.entries, original.fileIndex.page(key).entries);
    assert.deepEqual(owner.fileIndex.projectionEvidencePage(key), original.fileIndex.projectionEvidencePage(key));
    execute(owner, input(owner, messages)); assert.deepEqual(owner.fileIndex.page(key), first);
    const db: DatabaseSync = (owner as any).db;
    db.exec("CREATE TRIGGER reject_files BEFORE INSERT ON session_file_evidence BEGIN SELECT RAISE(ABORT, 'file failed'); END");
    assert.equal(execute(owner, input(owner, [message(3)])), true, 'optional failure is not an execution failure');
    assert.equal(owner.fileIndex.page(key).coverage, 'stale');
    assert.deepEqual(owner.fileIndex.page(key).entries, first.entries);
    db.exec('DROP TRIGGER reject_files');
    execute(owner, input(owner, messages));
    assert.equal(owner.fileIndex.projectionBinding(key), binding, 'failed replacement rolled snapshot back too');
    assert.equal(execute(owner, { ...input(owner), evidence: { invalid: true } }), true);
    assert.equal(owner.fileIndex.page(key).coverage, 'stale');
  } finally { owner.close(); original.close(); }
});

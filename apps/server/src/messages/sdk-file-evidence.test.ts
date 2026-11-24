import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal } from '../connector/sdk-execution-journal.js';
import { ClaudeStreamDelivery } from '../claude/stream-delivery.js';
import { ClaudeTranscriptStore } from '../claude/transcript-store.js';
import { claudeChatMessages } from '../claude/session-view.js';
import { validateClaudeProjection } from '../claude/message-projection.js';
import { CopilotStreamDelivery } from '../copilot/stream-delivery.js';
import { CopilotTranscriptStore } from '../copilot/transcript-store.js';
import { validateCopilotProjection } from '../copilot/message-projection.js';
import type { CopilotLifecycleFrame } from '../copilot/worker-protocol.js';
import { sourceReferenceMedia } from './source-preview.js';
import { SessionFileIndex } from './session-file-index.js';
import { SessionFileRebuilds } from './session-file-rebuild.js';

const files = [{ path: '/project/example.ts', kind: 'modified' as const }];

function database(file: string, runtime: 'claude-code' | 'ghcp') {
  const db = new DatabaseSync(file), journal = new SdkExecutionJournal(db, runtime), queue = new TurnQueue(db);
  const key = `${runtime}:files`, ref = { key, id: 'execution', epoch: 'epoch' };
  if (!journal.session(key)) {
    journal.create({ key, nativeSessionId: 'native', title: 'Files', createdAt: 0 });
    queue.enqueue(runtime, { id: 'input', sessionKey: key, createdAt: 0, payload: {} });
    journal.begin(ref, ['input'], queue);
  }
  return { db, key, ref };
}

test('Claude native stream -> validated IPC -> durable history -> preview membership survives reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-claude-files-')), file = join(dir, 'test.sqlite');
  let f = database(file, 'claude-code'), store = new ClaudeTranscriptStore(f.db, () => 10);
  let parent: unknown, nativeId = '';
  const delivery = new ClaudeStreamDelivery('native', async reply => {
    if (reply.kind === 'event') { parent = reply.event.parent_tool_use_id; nativeId = String(reply.event.uuid); }
    if (reply.kind === 'projection') {
      const rows = validateClaudeProjection(reply.rows, nativeId, parent);
      store.append(f.ref, rows, reply.stream, reply.details);
      assert.ok(!JSON.stringify(rows).includes('PRIVATE_INPUT'));
    }
  }, () => assert.fail('delivery failed'));
  const send = (uuid: string, type: string, block: unknown, parent_tool_use_id: string | null = null) => delivery.send({
    type, uuid, session_id: 'native', parent_tool_use_id, message: { role: type, content: [block] },
  });
  try {
    await send('call', 'assistant', { type: 'tool_use', id: 'tool', name: 'Edit', input: { file_path: files[0]!.path, old_string: 'PRIVATE_INPUT' } });
    await send('child-result', 'user', { type: 'tool_result', tool_use_id: 'tool', content: 'ok' }, 'child');
    await send('result', 'user', { type: 'tool_result', tool_use_id: 'tool', content: 'ok' });
    // Delivery retries must not change the immutable transcript.
    await send('result', 'user', { type: 'tool_result', tool_use_id: 'tool', content: 'ok' });
    await send('denied-call', 'assistant', { type: 'tool_use', id: 'denied', name: 'Write', input: { file_path: '/project/denied.ts' } });
    await send('denied-result', 'user', { type: 'tool_result', tool_use_id: 'denied', content: 'denied', is_error: true });
    await delivery.finish();
    const messages = claudeChatMessages(f.key, store.pageBlocks(f.key)!.messages);
    assert.equal(messages.length, 5);
    const changed = messages.filter(row => row.sourceFiles?.length);
    assert.equal(changed.length, 1); assert.deepEqual(changed[0]!.sourceFiles, files);
    let indexed = new SessionFileIndex(f.db).page(f.key);
    assert.equal(indexed.entries.length, 1); assert.equal(indexed.entries[0]!.messageId, changed[0]!.id);
    assert.equal(indexed.coverage, 'partial');
    f.db.exec('DELETE FROM session_file_indexes; DELETE FROM session_file_evidence');
    // Make any details-table access fail. A rebuild needs stable display IDs,
    // not even the detail-block availability query used by ordinary history.
    f.db.exec('ALTER TABLE claude_transcript_details RENAME TO hidden_details');
    const jobs = new SessionFileRebuilds(new SessionFileIndex(f.db), () => 'native', (key, before) => store.fileEvidencePage(key, before));
    const job = jobs.start(f.key, 'actor');
    assert.equal(jobs.step(f.key, 'actor', job.id, 0).state, 'completed');
    f.db.exec('ALTER TABLE hidden_details RENAME TO claude_transcript_details');
    assert.deepEqual(new SessionFileIndex(f.db).page(f.key).entries, indexed.entries);
    indexed = new SessionFileIndex(f.db).page(f.key);
    assert.equal(changed[0]!.status, 'sent');
    assert.equal(sourceReferenceMedia(changed[0]!).length, 1);
    assert.equal(sourceReferenceMedia(messages.at(-1)!).length, 0);
    assert.equal(store.message(f.key, { nativeMessageId: 'result', parentToolUseId: 'child', blockIndex: 0 }), undefined);
    assert.equal(store.message('claude-code:other', { nativeMessageId: 'result', parentToolUseId: null, blockIndex: 0 }), undefined);
    f.db.close(); f = database(file, 'claude-code'); store = new ClaudeTranscriptStore(f.db);
    assert.deepEqual(claudeChatMessages(f.key, store.pageBlocks(f.key)!.messages), messages);
    assert.deepEqual(new SessionFileIndex(f.db).page(f.key), indexed);
  } finally { f.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('GHCP native stream -> validated IPC -> durable history keeps exact agent/parent scope without raw bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-copilot-files-')), file = join(dir, 'test.sqlite');
  let f = database(file, 'ghcp'), store = new CopilotTranscriptStore(f.db, () => 10);
  let frame: CopilotLifecycleFrame;
  const delivery = new CopilotStreamDelivery(async reply => {
    if (reply.kind === 'event') frame = reply.event;
    if (reply.kind === 'projection') {
      const row = validateCopilotProjection(reply.row, frame);
      store.append(f.ref, row, undefined, reply.detail);
      assert.ok(!JSON.stringify(row).includes('PRIVATE_INPUT'));
    }
  }, () => assert.fail('delivery failed'));
  const send = (id: string, type: string, data: Record<string, unknown>, agentId?: string) => delivery.send({
    id, type, data, timestamp: '2026-09-28T00:00:00.000Z', ...(agentId ? { agentId } : {}),
  });
  try {
    send('call', 'tool.execution_start', { toolCallId: 'tool', toolName: 'edit', arguments: { path: files[0]!.path, new_str: 'PRIVATE_INPUT' } });
    send('child', 'tool.execution_complete', { toolCallId: 'tool', success: true }, 'child');
    send('parent', 'tool.execution_complete', { toolCallId: 'tool', success: true, parentToolCallId: 'parent' });
    send('result', 'tool.execution_complete', { toolCallId: 'tool', success: true });
    send('result', 'tool.execution_complete', { toolCallId: 'tool', success: true });
    send('fail-call', 'tool.execution_start', { toolCallId: 'fail', toolName: 'create', arguments: { path: '/project/denied.ts' } });
    send('fail-result', 'tool.execution_complete', { toolCallId: 'fail', success: false });
    await delivery.finish();
    const page = store.page(f.key)!;
    assert.equal(page.messages.length, 6);
    const changed = page.messages.filter(row => row.sourceFiles?.length);
    assert.equal(changed.length, 1); assert.deepEqual(changed[0]!.sourceFiles, files);
    let indexed = new SessionFileIndex(f.db).page(f.key);
    assert.equal(indexed.entries[0]!.messageId, changed[0]!.id);
    f.db.exec('DELETE FROM session_file_indexes; DELETE FROM session_file_evidence');
    f.db.exec('ALTER TABLE copilot_transcript_details RENAME TO hidden_details');
    const jobs = new SessionFileRebuilds(new SessionFileIndex(f.db), () => 'native', (key, before) => store.fileEvidencePage(key, before));
    const job = jobs.start(f.key, 'actor');
    assert.equal(jobs.step(f.key, 'actor', job.id, 0).state, 'completed');
    f.db.exec('ALTER TABLE hidden_details RENAME TO copilot_transcript_details');
    assert.deepEqual(new SessionFileIndex(f.db).page(f.key).entries, indexed.entries);
    indexed = new SessionFileIndex(f.db).page(f.key);
    assert.equal(new SessionFileIndex(f.db).page(f.key, undefined, 'rebound-native').coverage, 'unavailable');
    assert.equal(changed[0]!.status, 'sent'); assert.equal(sourceReferenceMedia(changed[0]!).length, 1);
    assert.equal(sourceReferenceMedia(page.messages.at(-1)!).length, 0);
    assert.throws(() => store.message('ghcp:other', changed[0]!.id));
    f.db.close(); f = database(file, 'ghcp'); store = new CopilotTranscriptStore(f.db);
    assert.deepEqual(store.page(f.key), page);
    assert.deepEqual(new SessionFileIndex(f.db).page(f.key), indexed);
  } finally { delivery.dispose(); f.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('IPC validators discard file metadata from calls, failures, assistant text and invalid paths', () => {
  for (const [role, toolPhase, toolError] of [['tool', 'call', undefined], ['tool', 'result', true], ['assistant', undefined, undefined]] as const) {
    const row = { nativeMessageId: 'id', blockIndex: 0, parentToolUseId: null, role, text: '', truncated: false,
      detailAvailable: false, ...(role === 'tool' ? { toolCallId: 'tool', toolPhase, toolError } : {}), sourceFiles: files };
    assert.equal(validateClaudeProjection([row], 'id', null)[0]!.sourceFiles, undefined);
    const value = { nativeEventId: 'id', role, text: '', truncated: false, createdAt: 1,
      ...(role === 'tool' ? { toolCallId: 'tool', toolPhase, toolError, ...(toolPhase === 'call' ? { toolName: 'edit', text: 'edit' } : {}) } : { messageId: 'msg' }), sourceFiles: files };
    const frame = { id: 'id', type: role === 'tool' ? toolPhase === 'call' ? 'tool.execution_start' : 'tool.execution_complete' : 'assistant.message',
      data: role === 'tool' ? { toolCallId: 'tool', ...(toolPhase === 'result' ? { success: false } : {}) } : { messageId: 'msg' } };
    assert.equal(validateCopilotProjection(value, frame).sourceFiles, undefined);
  }
  const row = { nativeMessageId: 'id', blockIndex: 0, parentToolUseId: null, role: 'tool', text: '', truncated: false,
    detailAvailable: true, toolCallId: 'tool', toolPhase: 'result', toolError: false,
    sourceFiles: [{ path: '../secret', kind: 'modified' }, ...files] };
  assert.deepEqual(validateClaudeProjection([row], 'id', null)[0]!.sourceFiles, files);
});

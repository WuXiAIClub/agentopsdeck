import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexRolloutReader } from './rollout-reader.js';
import { InterruptedDispatchUnconfirmed, requireInterruptedDispatchSettled } from './interrupted-dispatch.js';

function buildPaddingLines(targetBytes: number): string {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'agent_message_delta', delta: 'x'.repeat(8_000) },
  }) + '\n';
  const count = Math.ceil(targetBytes / Buffer.byteLength(line));
  return line.repeat(count);
}

test('projectTurnsAndDisposeWithin verifies >16 MiB rollouts from the tail without scanning the prefix', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-tail-verify-'));
  try {
    const file = path.join(dir, 'rollout.jsonl');
    const head = [
      JSON.stringify({ type: 'session_meta' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-0' } }),
    ].join('\n') + '\n';
    const padding = buildPaddingLines(20 * 1024 * 1024);
    const tail = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-0' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec', arguments: '{}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'completed ok' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'exec', arguments: '{}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'aborted by user' } }),
    ].join('\n') + '\n';
    await writeFile(file, head + padding + tail);

    const reader = new CodexRolloutReader();
    try {
      await reader.projectTurnsAndDisposeWithin(file, ['turn-1'], 30_000, async snapshot => {
        await requireInterruptedDispatchSettled(snapshot, { id: 'turn-1', status: 'interrupted' });
      });
      const afterSettled = reader.cacheStats();
      assert.ok(afterSettled.sourceBytesRead <= 17 * 1024 * 1024, `expected bounded tail read, got ${afterSettled.sourceBytesRead}`);

      await assert.rejects(
        () => reader.projectTurnsAndDisposeWithin(file, ['turn-2'], 30_000, async snapshot => {
          await requireInterruptedDispatchSettled(snapshot, { id: 'turn-2', status: 'interrupted' });
        }),
        InterruptedDispatchUnconfirmed,
      );
    } finally {
      await reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('projectTurnsAndDisposeWithin falls back to full scan when target turn start lies before tail window', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-tail-fallback-'));
  try {
    const file = path.join(dir, 'rollout-fallback.jsonl');
    const head = [
      JSON.stringify({ type: 'session_meta' }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-early' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'early-exec', name: 'exec', arguments: '{}' } }),
    ].join('\n') + '\n';
    // Mid-turn turn_context after 68 MiB of output must NOT trick tail proof into skipping early-exec!
    const padding = buildPaddingLines(68 * 1024 * 1024);
    const tail = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-early', model: 'gpt-5.6-sol' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-early' } }),
    ].join('\n') + '\n';
    await writeFile(file, head + padding + tail);

    const reader = new CodexRolloutReader();
    try {
      await assert.rejects(
        () => reader.projectTurnsAndDisposeWithin(file, ['turn-early'], 30_000, async snapshot => {
          await requireInterruptedDispatchSettled(snapshot, { id: 'turn-early', status: 'interrupted' });
        }),
        InterruptedDispatchUnconfirmed,
      );
    } finally {
      await reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

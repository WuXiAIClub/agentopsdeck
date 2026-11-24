import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyOpenClawSessionRun } from './session-usage.js';

async function withTranscript(rows: any[], fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-session-usage-'));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('aborted last run is terminal even when the stored status is running', () => {
  const result = classifyOpenClawSessionRun(
    { status: 'running', updatedAt: Date.now() },
    { status: 'running', abortedLastRun: true },
  );
  assert.deepEqual(result, { status: 'failed', hasActiveRun: false });
});

test('stale unresolved toolUse transcript is classified idle so it cannot block queues forever', async () => {
  const previousThreshold = process.env.AOD_STALE_ACTIVE_RUN_MS;
  process.env.AOD_STALE_ACTIVE_RUN_MS = String(60 * 60 * 1000);
  const now = Date.UTC(2026, 5, 30, 2, 30, 0);
  await withTranscript([
    {
      type: 'message',
      timestamp: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', name: 'exec', arguments: { command: 'sleep 999' } }],
      },
    },
  ], async (sessionFile) => {
    const result = classifyOpenClawSessionRun(
      { status: 'running', updatedAt: now - (2 * 60 * 60 * 1000) },
      { status: 'running', sessionFile, updatedAt: now - (2 * 60 * 60 * 1000) },
      now,
    );
    assert.deepEqual(result, { status: 'idle', hasActiveRun: false });
  });
  if (previousThreshold === undefined) delete process.env.AOD_STALE_ACTIVE_RUN_MS;
  else process.env.AOD_STALE_ACTIVE_RUN_MS = previousThreshold;
});

test('recent unresolved toolUse transcript remains running', async () => {
  const previousThreshold = process.env.AOD_STALE_ACTIVE_RUN_MS;
  process.env.AOD_STALE_ACTIVE_RUN_MS = String(60 * 60 * 1000);
  const now = Date.UTC(2026, 5, 30, 2, 30, 0);
  await withTranscript([
    {
      type: 'message',
      timestamp: new Date(now - (5 * 60 * 1000)).toISOString(),
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', name: 'exec', arguments: { command: 'npm test' } }],
      },
    },
  ], async (sessionFile) => {
    const result = classifyOpenClawSessionRun(
      { status: 'running', updatedAt: now - (5 * 60 * 1000) },
      { status: 'running', sessionFile, updatedAt: now - (5 * 60 * 1000) },
      now,
    );
    assert.deepEqual(result, { status: 'running', hasActiveRun: true });
  });
  if (previousThreshold === undefined) delete process.env.AOD_STALE_ACTIVE_RUN_MS;
  else process.env.AOD_STALE_ACTIVE_RUN_MS = previousThreshold;
});

test('completed sessions_yield transcript is classified waiting instead of idle', async () => {
  const now = Date.UTC(2026, 5, 30, 2, 30, 0);
  await withTranscript([
    {
      type: 'message',
      timestamp: new Date(now - 1000).toISOString(),
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', name: 'sessions_yield', arguments: { message: 'waiting' } }],
      },
    },
    {
      type: 'message',
      timestamp: new Date(now).toISOString(),
      message: {
        role: 'toolResult',
        content: [{ type: 'text', text: '{"status":"yielded","message":"waiting"}' }],
      },
    },
  ], async (sessionFile) => {
    const result = classifyOpenClawSessionRun(
      { status: 'running', updatedAt: now },
      { status: 'running', sessionFile, updatedAt: now },
      now,
    );
    assert.deepEqual(result, { status: 'waiting', hasActiveRun: false });
  });
});

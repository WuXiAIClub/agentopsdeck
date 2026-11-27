import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { formatQuotaCountdown, parseAntigravityQuotaWait } from '@agentopsdeck/shared';
import { AntigravityQuotaRetryManager } from './quota-retry.js';
import { sdkSessionView } from '../connector/sdk-session-view.js';

test('parseAntigravityQuotaWait parses individual quota reset duration messages accurately', () => {
  const now = 1_700_000_000_000;
  const parsed = parseAntigravityQuotaWait(
    '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h9m53s.',
    now,
  );
  assert.ok(parsed);
  const expectedMs = ((3 * 60 + 9) * 60 + 53) * 1_000;
  assert.equal(parsed.retryAfterMs, expectedMs);
  assert.equal(parsed.retryAt, now + expectedMs);
  assert.equal(parsed.rawDuration, '3h9m53s');
  assert.equal(parsed.autoRetry, true);

  const minutesOnly = parseAntigravityQuotaWait('Quota reached. Retry in 12m 5s', now);
  assert.ok(minutesOnly);
  assert.equal(minutesOnly.retryAfterMs, (12 * 60 + 5) * 1_000);

  assert.equal(parseAntigravityQuotaWait('Hello! Everything completed successfully.', now), undefined);
  assert.equal(parseAntigravityQuotaWait('Individual quota reached with no timer.', now), undefined);
});

test('formatQuotaCountdown renders readable countdown strings', () => {
  assert.equal(formatQuotaCountdown(((3 * 60 + 9) * 60 + 53) * 1_000), '3h 09m 53s');
  assert.equal(formatQuotaCountdown((5 * 60 + 4) * 1_000), '5m 04s');
  assert.equal(formatQuotaCountdown(9_000), '9s');
});

test('AntigravityQuotaRetryManager schedules auto-continuation and supports cancellation', async () => {
  const changes: string[] = [];
  const manager = new AntigravityQuotaRetryManager({ onChange: key => changes.push(key) });
  try {
    const resumed: Array<{ key: string; prompt: string }> = [];
    const now = Date.now();
    manager.schedule(
      'antigravity:sess-1',
      { retryAt: now + 40, retryAfterMs: 40, detectedAt: now, reason: 'Quota reached', rawDuration: '1s', autoRetry: true },
      'Continue work',
      (key, prompt) => { resumed.push({ key, prompt }); },
    );
    assert.ok(manager.get('antigravity:sess-1'));
    await delay(90);
    assert.deepEqual(resumed, [{ key: 'antigravity:sess-1', prompt: 'Continue work' }]);
    assert.equal(manager.get('antigravity:sess-1'), undefined);

    const cancelledResumes: string[] = [];
    const now2 = Date.now();
    manager.schedule(
      'antigravity:sess-2',
      { retryAt: now2 + 80, retryAfterMs: 80, detectedAt: now2, reason: 'Quota reached', autoRetry: true },
      'Should cancel',
      key => { cancelledResumes.push(key); },
    );
    assert.equal(manager.cancel('antigravity:sess-2'), true);
    assert.equal(manager.get('antigravity:sess-2'), undefined);
    await delay(120);
    assert.deepEqual(cancelledResumes, []);
    assert.ok(changes.includes('antigravity:sess-1'));
    assert.ok(changes.includes('antigravity:sess-2'));
  } finally {
    manager.close();
  }
});

test('sdkSessionView exposes Antigravity messageCount, compactionCount, cumulative tokens, and quotaWait waiting status', () => {
  const quotaWait = {
    retryAt: 1_700_003_600_000,
    retryAfterMs: 3_600_000,
    detectedAt: 1_700_000_000_000,
    reason: 'Individual quota reached · resets in 1h',
    rawDuration: '1h',
    autoRetry: true,
  };
  const summary = sdkSessionView(
    'antigravity',
    {
      key: 'antigravity:session-metrics',
      nativeSessionId: 'native-1',
      title: 'AGY Metrics',
      createdAt: 1_700_000_000_000,
      nativeState: 'ready',
      metrics: {
        executionId: 'exec-1',
        sequence: 3,
        compactionCount: 2,
        context: { used: 18_400, limit: 1_048_576, basis: 'native-context' },
        usage: { scope: 'last-turn', inputTokens: 1200, outputTokens: 350 },
        totals: { inputTokens: 9800, outputTokens: 2450, totalTokens: 12250 },
      },
    },
    undefined,
    true,
    { messageCount: 14, quotaWait },
  );
  assert.equal(summary.status, 'waiting');
  assert.equal(summary.runtime?.phase, 'waiting');
  assert.equal(summary.runtime?.threadActivity, 'waiting');
  assert.deepEqual(summary.quotaWait, quotaWait);
  assert.equal(summary.messageCount, 14);
  assert.equal(summary.compactionCount, 2);
  assert.equal(summary.inputTokens, 9800);
  assert.equal(summary.outputTokens, 2450);
  assert.equal(summary.totalTokens, 12250);
  assert.equal(summary.contextUsedTokens, 18_400);
  assert.equal(summary.contextTokens, 1_048_576);
});

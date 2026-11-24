// Read-only acceptance: only history GET and the read-only workspace POST.
// Authentication belongs to the operator wrapper; never record headers/bodies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createConditionalHistoryCache, restoreConditionalHistory, restoreHistoryDelta,
  HISTORY_ASYNC_HEADER, HISTORY_DELTA_HEADER, isHistoryPending } from '../../packages/shared/dist/index.js';

export const MAX_PROBE_RESPONSE_BYTES = 16 * 1024 * 1024;

export async function readBoundedResponseText(response, maxBytes = MAX_PROBE_RESPONSE_BYTES, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error('History response exceeded byte ceiling');
  }
  if (!response.body) {
    const text = await response.text();
    assert.ok(Buffer.byteLength(text, 'utf8') <= maxBytes, 'History response exceeded byte ceiling');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('History response timed out');
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('History response exceeded byte ceiling');
      }
      chunks.push(chunk);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export async function verifyLargeHistory({ request, sessionKeys, rounds = 30, intervalMs = 2000,
  save = async () => {}, wait = delay, maxPendingMs = 120_000, maxResponseBytes = MAX_PROBE_RESPONSE_BYTES, now = Date.now }) {
  assert.ok(sessionKeys.length >= 1 && sessionKeys.length <= 6 && new Set(sessionKeys).size === sessionKeys.length);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100);
  assert.ok(Number.isInteger(maxResponseBytes) && maxResponseBytes > 0);
  const cache = createConditionalHistoryCache();
  const evidence = { state: 'testing', startedAt: new Date().toISOString(), rounds, sessions: sessionKeys.length,
    requests: [], observations: [], writes: 0 };
  let stage = 'request', activeMode, activeRound, activeStatus, activeSession;
  async function get(path, init, deadlineAt) {
    const remainingMs = Math.max(1, Math.min(30_000, deadlineAt - now()));
    const signal = AbortSignal.timeout(remainingMs);
    const started = performance.now();
    const response = await request(path, { ...init, signal });
    const text = await readBoundedResponseText(response, maxResponseBytes, signal);
    evidence.requests.push({ mode: path.includes('/workspace/') ? 'preview' : 'standard', status: response.status,
      bytes: Buffer.byteLength(text), ms: Math.round(performance.now() - started) });
    activeStatus = response.status;
    assert.ok(response.ok || response.status === 304, `History HTTP failed (${response.status})`);
    return { response, text };
  }
  function accept(frame, mode) {
    const { sessionKey: key, status, body } = frame, headers = new Headers(frame.headers);
    stage = 'frame'; activeStatus = status;
    activeSession = typeof key === 'string' ? createHash('sha256').update(key).digest('hex') : undefined;
    assert.ok(sessionKeys.includes(key));
    if (status === 202) { assert.ok(isHistoryPending(body)); return false; }
    assert.ok([200, 226, 304].includes(status), `History frame failed (${status})`);
    const previous = cache.get(key);
    stage = 'restore';
    const page = status === 304 ? restoreConditionalHistory(previous, headers.get('etag'), headers.get('x-agentopsdeck-history-meta'))
      : status === 226 || headers.get(HISTORY_DELTA_HEADER) === '1' ? restoreHistoryDelta(previous, body) : body;
    stage = 'page';
    assert.ok(Array.isArray(page?.messages) && page.messages.length > 0, 'Expected known non-empty history');
    assert.ok(page.messages.every(message => message.sessionKey === key && typeof message.id === 'string'));
    assert.equal(new Set(page.messages.map(message => message.id)).size, page.messages.length);
    if (status !== 304) cache.put(key, headers.get('etag'), page);
    evidence.observations.push({ mode, status, session: createHash('sha256').update(key).digest('hex'), messages: page.messages.length,
      digest: createHash('sha256').update(JSON.stringify(page.messages)).digest('hex') });
    return true;
  }
  try {
    for (let round = 0; round < rounds; round++) {
      for (const mode of ['standard', 'preview']) {
        activeRound = round; activeMode = mode;
        let remaining = [...sessionKeys]; const started = now();
        while (remaining.length) {
          stage = 'deadline'; activeStatus = undefined; activeSession = undefined;
          const elapsed = now() - started;
          assert.ok(elapsed < maxPendingMs, 'History preparation exceeded acceptance deadline');
          const deadlineAt = started + maxPendingMs;
          const items = remaining.map(sessionKey => ({ sessionKey, limit: 200, ...(cache.get(sessionKey) ? { etag: cache.get(sessionKey).etag } : {}) }));
          let frames;
          stage = 'request';
          if (mode === 'preview') {
            const { response, text } = await get('/api/hub/v1/workspace/sync', { method: 'POST',
              headers: { [HISTORY_ASYNC_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, items }) }, deadlineAt);
            assert.equal(response.headers.get('x-agentopsdeck-workspace-sync'), '1');
            frames = text.trim().split('\n').map(line => JSON.parse(line));
          } else frames = await Promise.all(items.map(async item => {
            const { response, text } = await get(`/api/hub/v1/sessions/${encodeURIComponent(item.sessionKey)}/messages?limit=200`,
              { headers: { [HISTORY_ASYNC_HEADER]: '1', 'x-agentopsdeck-history-delta': '1', ...(item.etag ? { 'if-none-match': item.etag } : {}) } }, deadlineAt);
            return { sessionKey: item.sessionKey, status: response.status, headers: Object.fromEntries(response.headers), body: text ? JSON.parse(text) : undefined };
          }));
          stage = 'frame-set';
          assert.deepEqual(frames.map(frame => frame.sessionKey).sort(), [...remaining].sort(), 'Missing or duplicate frame');
          remaining = frames.filter(frame => !accept(frame, mode)).map(frame => frame.sessionKey);
          await save(evidence);
          if (remaining.length) await wait(1000);
        }
      }
      if (round + 1 < rounds) await wait(intervalMs);
    }
    evidence.state = 'verified';
    evidence.finishedAt = new Date().toISOString();
    await save(evidence); return evidence;
  } catch {
    evidence.state = 'needs-review';
    // Bounded diagnostic fields only: never persist exception text, URLs or bodies.
    evidence.failure = { stage, mode: activeMode, round: activeRound, status: activeStatus, session: activeSession };
    await save(evidence);
    throw new Error('Large-history acceptance failed; inspect status evidence without retrying mutations');
  }
}

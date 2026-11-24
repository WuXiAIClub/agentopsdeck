import assert from 'node:assert/strict';

export const hubCodexBrowserChecks = Object.freeze([
  'desktop-mobile-two-users-two-nodes-with-colliding-session-identities-and-real-auth-http-sqlite',
  'four-browser-sends-original-receipts-idempotency-and-shared-queue',
  'live-revocation-clears-two-browser-snapshots-blocks-successor-and-preserves-other-node-sse',
  'same-data-hub-and-connectors-restart-browser-reload-revocation-and-original-receipts-without-replay',
]);

// An exit code is not enough: bind the inner business and physical-cleanup
// receipt to the exact candidate verified by the outer controller.
export function validateHubCodexBrowserReceipt(value, root, candidate) {
  assert.equal(value.passed, true, 'Hub browser business acceptance');
  assert.equal(value.childrenClosed, true, 'Native children must close without forced cleanup');
  assert.equal(value.candidateUnchanged, true, 'Candidate must remain unchanged');
  assert.deepEqual(value.errors, [], 'No hidden browser/backend/cleanup errors');
  assert.equal(value.provider, 'deterministic-native-protocol-simulator');
  assert.equal(value.paidRequests, 0, 'Protocol simulator is not external-model acceptance');
  assert.deepEqual(value.candidate, { root, ...candidate }, 'Exact candidate identity');
  assert.deepEqual(value.checks, hubCodexBrowserChecks, 'Every business phase must finish exactly once');
  const start = Date.parse(value.startedAt), finish = Date.parse(value.finishedAt);
  assert.ok(Number.isFinite(start) && Number.isFinite(finish) && finish >= start, 'Terminal receipt required');
}

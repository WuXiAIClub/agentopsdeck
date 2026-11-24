import assert from 'node:assert/strict';
import test from 'node:test';
import { hubCodexBrowserChecks, validateHubCodexBrowserReceipt } from './permissions-browser-receipts.mjs';

const root = '/isolated/candidate';
const candidate = { manifestSha256: 'a'.repeat(64), files: 100, entrypoint: 'apps/server/dist/index.js' };
const valid = () => ({ passed: true, childrenClosed: true, candidateUnchanged: true, errors: [],
  provider: 'deterministic-native-protocol-simulator', paidRequests: 0,
  candidate: { root, ...candidate }, checks: [...hubCodexBrowserChecks],
  startedAt: '2026-11-05T00:00:00.000Z', finishedAt: '2026-11-05T00:01:00.000Z' });

test('exact sealed-candidate browser receipt includes every phase and physical cleanup', () => {
  assert.doesNotThrow(() => validateHubCodexBrowserReceipt(valid(), root, candidate));
});

test('successful exit cannot mask failed business, cleanup, provenance or incomplete phases', () => {
  for (const change of [
    { passed: false }, { childrenClosed: false }, { candidateUnchanged: false }, { errors: ['failure'] },
    { paidRequests: 1 }, { provider: 'external' }, { candidate: { root, ...candidate, manifestSha256: 'b'.repeat(64) } },
    { checks: hubCodexBrowserChecks.slice(0, -1) }, { checks: [...hubCodexBrowserChecks, hubCodexBrowserChecks[0]] },
    { finishedAt: undefined }, { finishedAt: '2026-11-04T00:00:00.000Z' },
  ]) assert.throws(() => validateHubCodexBrowserReceipt({ ...valid(), ...change }, root, candidate));
  assert.throws(() => validateHubCodexBrowserReceipt(valid(), '/another/candidate', candidate));
});

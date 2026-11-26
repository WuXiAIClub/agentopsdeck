import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GEMINI_QUOTA_GROUP_NAME,
  isEmptyQuotaFraction,
  isLowQuotaFraction,
  resolveQuotaSampleGroupIndex,
} from './antigravity-quota.js';

test('resolveQuotaSampleGroupIndex targets Gemini Models and falls back cleanly', () => {
  assert.equal(resolveQuotaSampleGroupIndex([]), -1);
  assert.equal(
    resolveQuotaSampleGroupIndex([
      { name: GEMINI_QUOTA_GROUP_NAME },
      { name: 'Claude and GPT models' },
    ]),
    0,
  );
  assert.equal(
    resolveQuotaSampleGroupIndex([
      { name: 'Claude and GPT models' },
      { name: GEMINI_QUOTA_GROUP_NAME },
    ]),
    1,
  );
  assert.equal(
    resolveQuotaSampleGroupIndex([
      { name: 'Claude and GPT models' },
      { name: 'Other models' },
    ]),
    0,
  );
});

test('quota threshold helpers classify empty and low remaining fractions', () => {
  assert.equal(isEmptyQuotaFraction(0), true);
  assert.equal(isEmptyQuotaFraction(-0.01), true);
  assert.equal(isEmptyQuotaFraction(0.01), false);
  assert.equal(isLowQuotaFraction(0), true);
  assert.equal(isLowQuotaFraction(0.2), true);
  assert.equal(isLowQuotaFraction(0.201), false);
  assert.equal(isLowQuotaFraction(1), false);
});

test('AntigravityUsagePanel omits the redundant hero banner and renders check time in the group header', () => {
  const source = readFileSync(new URL('../../../src/components/AntigravityUsagePanel.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes('antigravity-quota-hero'), false);
  assert.equal(source.includes("t('Status cards')"), false);
  assert.equal(source.includes('antigravity-quota-group-header'), true);
  assert.equal(source.includes('resolveQuotaSampleGroupIndex'), true);
});

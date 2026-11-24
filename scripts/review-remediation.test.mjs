import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const report = JSON.parse(readFileSync(new URL('../docs/review/findings.json', import.meta.url), 'utf8'));

test('review findings keep severity separate from verification-gap categories', () => {
  const severities = new Set(['critical', 'high', 'medium', 'low', 'info']);
  for (const finding of report.findings) {
    assert.ok(severities.has(finding.severity), `Invalid severity for ${finding.id}`);
    if (finding.originalSeverity === 'verification-gap') {
      assert.equal(finding.severity, 'info');
      assert.equal(finding.category, 'verification-gap');
    }
  }
});

test('source remediation keeps historical evidence and scoped verification separate from release approval', () => {
  assert.equal(report.publicationApproved, false);
  assert.ok(report.releaseBlockers.includes('Incomplete semantic review'));
  const repairs = report.findings.filter(finding => finding.remediation);
  assert.ok(repairs.length > 20);
  for (const finding of repairs) {
    assert.ok(finding.evidence?.length || finding.verification || finding.originalStatus);
    assert.equal(finding.remediation.wholeFileApproved, false);
    assert.match(finding.remediation.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(finding.remediation.summary.length >= 12);
    assert.ok(finding.remediation.testEvidence.length > 0);
    assert.ok(finding.remediation.limits.length > 0);
    assert.equal(finding.remediation.liveAcceptance, false);
  }
});

test('rights, native artifact and incomplete review gates cannot be cleared by scoped source tests', () => {
  const rights = report.findings.find(finding => finding.id === 'NAT-008');
  assert.notEqual(rights.status, 'fixed-targeted-verified');
  assert.ok(report.releaseBlockers.includes('Inherited-source redistribution rights'));
  assert.ok(report.releaseBlockers.includes('Final artifact attribution'));
  assert.ok(report.releaseBlockers.includes('Explicit release authorization'));
});

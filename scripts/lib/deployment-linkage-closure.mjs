import assert from 'node:assert/strict';
import { verifyAllCardEvidence } from './all-card-linkage-evidence.mjs';

// A separate supplement can close ONLY a post-admission E2E failure. Never
// rewrite the failed deployment receipt or let healthy HTTP mask missing gates.
export function verifyDeploymentLinkageClosure({ prior, supplement, codex, sdk, live, expectedOrigins }) {
  assert.equal(prior.stage, 'needs-review');
  assert.equal(prior.failure?.stage, 'post-restart-isolated-agent-e2e');
  for (const key of ['restarted', 'launcherInstalled', 'launcherVerified',
    'admissionReleased', 'preStopHistoriesVerified', 'noMessagesSentByMaintenance',
    'localHistoryVerified', 'lanHistoryVerified', 'localAndLanAssetsVerified',
    'compatibilityShimVerified', 'fileBoardsEnabled']) assert.equal(prior[key], true, key);
  for (const key of ['queuePreserved', 'ownedExecutionPreserved', 'historyReadable', 'goalPreserved']) {
    assert.equal(prior.pausedProof?.[key], true, key);
  }
  assert.ok(prior.stopped && typeof prior.stopped === 'object');
  assert.match(prior.stopped.queueSha256, /^[a-f0-9]{64}$/);
  assert.equal(prior.stopped.queueCount, 0);
  assert.ok(Array.isArray(prior.stopped.executions));
  assert.ok(prior.backups?.length > 0 && prior.backupDirectory);
  for (const key of ['baselinePreserved', 'candidateEquivalent', 'actualRevisionPreserved']) {
    assert.equal(prior.configuration?.[key], true, key);
  }
  assert.ok(prior.configuration.comparedKeys > 0);
  assert.equal(prior.features?.sdkModelsVisible, true);
  assert.deepEqual([...prior.features.sdkRuntimesReady].sort(), ['claude-code', 'ghcp']);
  assert.equal(prior.features.bindingPanelEnabled, true);
  for (const key of ['realPtyCommand', 'resize', 'handleClosed']) assert.equal(prior.features.terminal?.[key], true);
  for (const media of [prior.media, prior.lanMedia]) {
    assert.equal(media?.enabled, true);
    assert.ok(media.samples?.length > 0 && media.samples.every(s => s.rangeAndSeekBytes && s.head && s.tamperedSignatureDenied));
    assert.equal(media.anonymousListingDenied, true); assert.equal(media.unsignedStreamDenied, true);
  }
  assert.equal(supplement.passed, true);
  assert.deepEqual(supplement.candidate, prior.candidate);
  assert.deepEqual(supplement.after.service, prior.service);
  assert.equal(supplement.linkage?.passed, true);
  assert.equal(supplement.linkage.productionSessionsTouched, false);
  assert.deepEqual(supplement.linkage.results.map(r => r.runtime).sort(), ['codex', 'sdk']);
  assert.ok(supplement.linkage.results.every(r => r.passed));
  const manifest = prior.candidate.manifestSha256;
  assert.equal(supplement.linkage.candidateManifest, manifest);
  verifyAllCardEvidence(codex, ['codex'], manifest);
  verifyAllCardEvidence(sdk, ['claude-code', 'ghcp'], manifest);
  assert.equal(codex.nativeClosed, true);
  assert.equal(sdk.gracefulShutdown, true);
  assert.equal(live.processCleanupVerified, true);
  assert.deepEqual(live.service, prior.service);
  assert.deepEqual(live.candidate, prior.candidate);
  assert.equal(live.launcherVerified, true);
  assert.equal(live.originalReceiptUnchanged, true);
  assert.ok(Array.isArray(expectedOrigins) && expectedOrigins.length === 2 && new Set(expectedOrigins).size === 2);
  for (const origin of expectedOrigins) {
    const parsed = new URL(origin);
    assert.ok(['http:', 'https:'].includes(parsed.protocol));
    assert.equal(parsed.origin, origin);
  }
  assert.deepEqual(live.health.map(h => h.origin).sort(), [...expectedOrigins].sort());
  assert.ok(live.health.every(h => h.status === 200 && h.ok === true && h.service === 'agentopsdeck'));
  assert.equal(prior.publicAcceptance?.status, 'deferred-by-user');
  assert.equal(prior.publicAcceptance.passed, false);
  return { passed: true, scope: 'local-and-LAN-deployment-plus-isolated-agent-title-linkage',
    assertions: codex.cardLinkage.cases.length + sdk.cardLinkage.cases.length,
    realTurns: codex.cardLinkage.commands.length + sdk.cardLinkage.commands.length,
    productionSessionsTouched: false, publicAcceptance: prior.publicAcceptance,
    originalFailureRetained: true };
}

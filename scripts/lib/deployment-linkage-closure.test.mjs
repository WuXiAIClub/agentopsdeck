import assert from 'node:assert/strict';
import test from 'node:test';
import { linkageSamples } from './all-card-linkage-probe.mjs';
import { verifyDeploymentLinkageClosure } from './deployment-linkage-closure.mjs';
function fixture() {
  const candidate = {manifestSha256: 'a'.repeat(64), directory: '/fixture/release'};
  const service = {MainPID: '12', InvocationID: 'fixture', ActiveState: 'active', SubState: 'running'};
  const media = {enabled: true, samples: [{rangeAndSeekBytes: true, head: true, tamperedSignatureDenied: true}], anonymousListingDenied: true, unsignedStreamDenied: true};
  const prior = {stage: 'needs-review', failure: {stage: 'post-restart-isolated-agent-e2e'}, candidate, service,
    restarted: true, stopped: {queueSha256: 'b'.repeat(64), queueCount: 0, executions: []}, launcherInstalled: true, launcherVerified: true, admissionReleased: true,
    preStopHistoriesVerified: true, noMessagesSentByMaintenance: true, localHistoryVerified: true, lanHistoryVerified: true,
    localAndLanAssetsVerified: true, compatibilityShimVerified: true, fileBoardsEnabled: true,
    pausedProof: {queuePreserved: true, ownedExecutionPreserved: true, historyReadable: true, goalPreserved: true},
    configuration: {baselinePreserved: true, candidateEquivalent: true, actualRevisionPreserved: true, comparedKeys: 76},
    backups: [{}], backupDirectory: '/fixture/backup', features: {sdkModelsVisible: true, sdkRuntimesReady: ['claude-code', 'ghcp'], bindingPanelEnabled: true,
      terminal: {realPtyCommand: true, resize: true, handleClosed: true}}, media, lanMedia: media, publicAcceptance: {status: 'deferred-by-user', passed: false}};
  function evidence(runtimes) {
    return {passed: true, candidate, scope: 'isolated-real-agent-13-kind-bidirectional-cards', nativeClosed: true, gracefulShutdown: true,
      cardLinkage: {passed: true, productionSessionsTouched: false, restarts: 1,
        commands: runtimes.flatMap(runtime => [1, 2].map(phase => ({runtime, phase, idempotencyKey: runtime + phase}))),
        cases: runtimes.flatMap(runtime => linkageSamples().flatMap(({kind}) => [
          ...[1, 2].map(phase => ({runtime, kind, phase, agentToHub: true, schemaPreserved: true})),
          {runtime, kind, hubToFile: true, receiptVerified: true},
        ]))}};
  }
  const expectedOrigins = ['http://127.0.0.1:8890', 'http://192.0.2.10:8890'];
  return {prior, expectedOrigins, supplement: {passed: true, candidate, after: {service}, linkage: {passed: true, productionSessionsTouched: false,
    candidateManifest: candidate.manifestSha256, results: [{runtime: 'codex', passed: true}, {runtime: 'sdk', passed: true}]}},
    codex: evidence(['codex']), sdk: evidence(['claude-code', 'ghcp']), live: {candidate, service, launcherVerified: true,
      originalReceiptUnchanged: true, processCleanupVerified: true, health: expectedOrigins.map(origin => ({origin, status: 200, ok: true, service: 'agentopsdeck'}))}};
}
test('complete supplement closes this gate while retaining public deferral and original failure', () => {
  const f = fixture(), before = JSON.stringify(f);
  const r = verifyDeploymentLinkageClosure(f);
  assert.equal(r.assertions, 117); assert.equal(r.realTurns, 6);
  assert.equal(r.publicAcceptance.passed, false);
  assert.equal(JSON.stringify(f), before);
});
for (const [name, change] of Object.entries({
  'earlier deployment failure': f => f.prior.failure.stage = 'protected-readiness',
  'missing backup': f => f.prior.backups = [],
  'missing stopped proof': f => f.prior.stopped = false,
  'configuration not restored': f => f.prior.fileBoardsEnabled = false,
  'effective configuration unverified': f => f.prior.configuration.candidateEquivalent = false,
  'deferred public check claimed passed': f => f.prior.publicAcceptance.passed = true,
  'production touched': f => f.supplement.linkage.productionSessionsTouched = true,
  'wrong candidate': f => f.sdk.candidate = {manifestSha256: 'b'.repeat(64)},
  'incomplete matrix': f => f.sdk.cardLinkage.cases.pop(),
  'cleanup unconfirmed': f => f.live.processCleanupVerified = false,
  'service changed': f => f.live.service = {...f.live.service, MainPID: '13'},
  'SPA HTML is not API health': f => delete f.live.health[0].ok,
  'modified original receipt': f => f.live.originalReceiptUnchanged = false,
  'missing expected origins': f => delete f.expectedOrigins,
  'duplicate expected origins': f => f.expectedOrigins[1] = f.expectedOrigins[0],
  'unexpected health origin': f => f.live.health[1].origin = 'http://192.0.2.11:8890',
})) test(`rejects ${name}`, () => { const f = fixture(); change(f); assert.throws(() => verifyDeploymentLinkageClosure(f)); });

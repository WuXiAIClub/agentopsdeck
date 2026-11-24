import assert from 'node:assert/strict';
import { linkageSamples } from './all-card-linkage-probe.mjs';

// Deployment evidence must cover the complete matrix, not just a truthy flag.
export function verifyAllCardEvidence(result, runtimes, manifest, { businessContent = false } = {}) {
  assert.equal(result.passed, true);
  assert.equal((result.candidateManifest ?? result.candidate).manifestSha256, manifest);
  assert.equal(result.scope, 'isolated-real-agent-13-kind-bidirectional-cards');
  const proof = result.cardLinkage;
  if (businessContent) assert.equal(proof.coverage, 'business-content', 'Title-only proof is not business-content acceptance');
  assert.equal(proof.passed, true);
  assert.equal(proof.productionSessionsTouched, false);
  assert.equal(proof.restarts, 1);
  const kinds = linkageSamples().map(sample => sample.kind);
  assert.equal(proof.commands.length, runtimes.length * 2);
  assert.equal(new Set(proof.commands.map(command => command.idempotencyKey)).size, proof.commands.length);
  assert.equal(proof.cases.length, runtimes.length * kinds.length * 3);
  for (const runtime of runtimes) {
    for (const phase of [1, 2]) {
      assert.equal(proof.commands.filter(command => command.runtime === runtime && command.phase === phase).length, 1);
      for (const kind of kinds) {
        const rows = proof.cases.filter(row => row.runtime === runtime && row.kind === kind && row.phase === phase);
        assert.equal(rows.length, 1); assert.equal(rows[0].agentToHub, true); assert.equal(rows[0].schemaPreserved, true);
        if (businessContent) {
          assert.equal(rows[0].businessContentVerified, true);
          if (phase === 2) assert.equal(rows[0].freshHumanContentPreserved, true);
        }
      }
    }
    for (const kind of kinds) {
      const rows = proof.cases.filter(row => row.runtime === runtime && row.kind === kind && row.hubToFile);
      assert.equal(rows.length, 1); assert.equal(rows[0].receiptVerified, true);
      if (businessContent) assert.equal(rows[0].businessContentVerified, true);
    }
  }
}

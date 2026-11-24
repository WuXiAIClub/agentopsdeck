import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import type { HubMemberCommands, HubMemberKind } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
for (const change of ['none', 'version', 'epoch', 'identity', 'close'] as const)
  test(`last connection delivery proof jointly observes identity and directory (${change})`, async () => {
    let checks = 0, mutated = false, submitted = 0, trailingIdentityReads = 0;
    const principal = { userId: 'member', admin: false }, scope = 'a'.repeat(64);
    let service!: AsyncHubMemberRequests;
    const owner = { command: async <K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']): Promise<HubMemberCommands[K]['output']> => {
      submitted++;
      let value: unknown;
      if (kind === 'memberSnapshot') {
        if (checks) trailingIdentityReads++;
        value = { principal, recoveryScope: scope };
      } else if (kind === 'connectionDirectory') value = { action: 'read', snapshot: { principal,
        connections: [{ id: 'node' }], users: [] }, version: 1, epochs: [1] };
      else if (kind === 'connectionDirectoryCheck') {
        checks++;
        value = mutated && change === 'identity' ? null : { ...(input as HubMemberCommands['connectionDirectoryCheck']['input']).command,
          ok: !(mutated && (change === 'version' || change === 'epoch')) };
        if (checks === 1) {
          mutated = true;
          if (change === 'close') void service.close();
        }
      } else throw Error('unexpected command');
      return value as HubMemberCommands[K]['output'];
    } };
    service = new AsyncHubMemberRequests(owner, new PerformanceDiagnostics(() => {}));
    try {
      const access = await service.begin(new Request('http://fixture.invalid/'));
      const directory = await access.connectionDirectory();
      if (change === 'none') await directory.check('node');
      else {
        await assert.rejects(directory.check('node'), error => error instanceof HubMemberRequestError
          && error.status === (change === 'identity' ? 401 : 503));
        const before = submitted;
        await assert.rejects(directory.check('node'), error => error instanceof HubMemberRequestError);
        assert.equal(submitted, before, 'a denied retained closure cannot submit more owner work');
      }
      assert.equal(trailingIdentityReads, 0, 'no unrelated identity await after the joint delivery proof');
      assert.equal(checks, change === 'close' ? 1 : 2);
    } finally { await service.close(); }
  });

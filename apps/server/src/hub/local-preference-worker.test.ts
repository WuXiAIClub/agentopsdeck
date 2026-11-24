import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
for (const mode of ['json', 'sqlite'] as const) {
  test(`${mode}: original Auth owner without explicit preference ownership cannot read or write raw files`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-no-preference-owner-'));
    const files = { hidden: join(root, 'hidden.json'), archived: join(root, 'archived.json'), pinned: join(root, 'pinned.json') };
    for (const file of Object.values(files)) writeFileSync(file, '[]');
    const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite'), administratorKey: 'original-admin',
      auth: mode === 'json' ? { kind: 'json', passkeysFile: join(root, 'passkeys.json'), sessionsFile: join(root, 'sessions.json') }
        : { file: join(root, 'auth.sqlite'), legacyFiles: [] },
      bootstrap: { legacyPreferences: files } }, quiet);
    try {
      await owner.open();
      await assert.rejects(owner.command('legacyAuth', { kind: 'localPreferenceSnapshot', input: {} }));
      await assert.rejects(owner.command('legacyAuth', { kind: 'localPreferenceChange', input: {
        field: 'pinned', key: 'original-local-session', enabled: true, evidence: { accessKey: 'original-admin' },
      } }));
      for (const file of Object.values(files)) {
        assert.equal(readFileSync(file, 'utf8'), '[]');
        startupDatabaseOwners.reserveExclusive(file)();
      }
      assert.equal(owner.snapshot().ready, true, 'Unsupported command does not retire a healthy original owner');
    } finally { await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
  });

  for (const collision of ['hidden', 'archived', 'pinned'] as const) {
    test(`${mode}: ${collision} reservation collision releases only the partially acquired original ownership`, () => {
      const root = mkdtempSync(join(tmpdir(), 'hub-preference-reservation-'));
      const file = join(root, 'hub.sqlite'), authFile = join(root, 'auth.sqlite');
      const passkeysFile = join(root, 'passkeys.json'), sessionsFile = join(root, 'sessions.json');
      const files = { hidden: join(root, 'hidden.json'), archived: join(root, 'archived.json'), pinned: join(root, 'pinned.json') };
      const releaseExisting = startupDatabaseOwners.reserveExclusive(files[collision]);
      let launches = 0;
      try {
        assert.throws(() => new AsyncHubMemberOwner({ file,
          auth: mode === 'json' ? { kind: 'json', passkeysFile, sessionsFile } : { file: authFile, legacyFiles: [] },
          bootstrap: { ownLocalPreferences: true, legacyPreferences: files } }, quiet,
        () => { launches++; throw Error('Worker must not launch after partial ownership refusal'); }), HubMemberOwnerUnavailable);
        assert.equal(launches, 0);
        assert.throws(() => startupDatabaseOwners.reserveExclusive(files[collision]), 'Existing unrelated owner remains held');
        for (const path of [file, ...(mode === 'json' ? [passkeysFile, sessionsFile] : [authFile]),
          ...Object.entries(files).filter(([field]) => field !== collision).map(([, path]) => path)]) {
          startupDatabaseOwners.reserveExclusive(path)();
        }
      } finally { releaseExisting(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

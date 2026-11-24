import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(process.argv[2]);
const baseline = process.argv[3];
const candidateEvidence = process.argv[2];
const candidate = join(candidateEvidence, 'dist');
const state = await mkdtemp(join(root, 'state-'));
const key = 'a'.repeat(24), token = 'b'.repeat(43), vault = 'synthetic-upgrade-vault';
const credential = { id: 'Zml4dHVyZQ', publicKey: 'AQ', counter: 0, rpId: 'hub.example',
  createdAt: 1, label: 'fixture', keyIdentityHash: key };
const importAt = (base, file) => import(pathToFileURL(join(base, file)).href);
const files = ['connector.sqlite', 'hub.sqlite', 'auth/auth.sqlite'];
const snapshot = file => {
  const db = new DatabaseSync(join(state, file), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return tables.map(({name}) => {
      assert.match(name, /^[a-zA-Z0-9_]+$/);
      const rows = db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort();
      return [name, rows];
    });
  } finally { db.close(); }
};
async function open(base) {
  const { ConnectorUserStore } = await importAt(base, 'connector/connector-user-store.js');
  const { HubStore } = await importAt(base, 'hub/hub-store.js');
  const { openSqliteAuth } = await importAt(base, 'auth/sqlite-store.js');
  const connector = new ConnectorUserStore(join(state, files[0]));
  const hub = new HubStore(join(state, files[1]), vault);
  const auth = openSqliteAuth(join(state, files[2]), [], () => key);
  const close = async () => { await auth.close(); await hub.close(); connector.close(); };
  return { connector, hub, auth, close };
}
await mkdir(join(state, 'auth'), { recursive: true, mode: 0o700 });
const original = await open(baseline);
const scope = JSON.stringify(['original-actor', 'codex:long-session']);
const sessionIdModule = await importAt(baseline, 'hub/session-id.js');
const sessionId = sessionIdModule.encodeHubSessionId('remote', 'codex:long-session');
try {
  original.connector.commands.claim(scope, 'original-command', { message: 'Synthetic retained input' });
  original.connector.turns.enqueue('codex', { id: 'queued-next', sessionKey: 'codex:long-session', createdAt: 1,
    payload: { actorId: 'original-actor', message: 'Synthetic queued input', media: [], deliveryMode: 'web-only' } });
  for (const phase of ['running', 'completed', 'failed', 'interrupted']) {
    const session = `codex:${phase}`;
    original.connector.codexExecutions.begin(session, `command:${phase}`, 'connection:original');
    assert.equal(original.connector.codexExecutions.acknowledge(session, `command:${phase}`, 'connection:original', `turn:${phase}`, () => {}), true);
    if (phase !== 'running') {
      original.connector.codexExecutions.observe(session, 'connection:original', `turn:${phase}`, phase);
      const fact = original.connector.codexExecutions.get(session);
      original.connector.codexExecutions.settleHistory(fact, phase === 'completed' ? 'current' : 'error');
    }
  }
  original.connector.codexExecutions.settleNativeHistory(original.connector.codexExecutions.get('codex:completed'), {
    turnId: 'goal:successor', fingerprint: 'c'.repeat(64), connectionId: 'connection:original', state: 'blocked', reason: 'background-work',
  });
  original.connector.events.append({ id: 'ignored', type: 'session.updated', ts: 1, sessionKey: 'codex:long-session', payload: { synthetic: true } });
  original.hub.upsertConnection({ id: 'remote', label: 'Synthetic remote', connectorUrl: 'http://synthetic.invalid', credentialToken: 'synthetic-token' });
  original.hub.setSessionPreference(sessionId, 'pinned', true);
  original.hub.appendDelivery({ envConnectionId: 'remote', sessionKey: sessionId, remoteSessionKey: 'codex:long-session', type: 'session.updated', ts: 1,
    payload: { synthetic: true } }, 'synthetic-domain', 'event:original');
  original.hub.notebooks.save('default', { resourceId: sessionId, text: 'Synthetic retained hot note', revision: 0 });
  original.hub.notebooks.saveArchive('default', { resourceId: sessionId, text: 'Synthetic retained cold archive', revision: 0 });
  original.auth.passkeys.importLegacy([credential], true);
  original.auth.passkeys.addAdministratorSession(token);
} finally { await original.close(); }
const before = files.map(snapshot);
const beforeDigest = createHash('sha256').update(JSON.stringify(before)).digest('hex');
const updated = await open(candidate);
let assertions = 0;
try {
  const preserved = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
  preserved(updated.connector.turns.list('codex', 'codex:long-session').length, 1);
  preserved(updated.connector.commands.claim(scope, 'original-command', { message: 'Synthetic retained input' }).fresh, false);
  for (const phase of ['running', 'completed', 'failed', 'interrupted']) {
    const fact = updated.connector.codexExecutions.get(`codex:${phase}`);
    preserved(fact.runId, `turn:${phase}`); preserved(fact.commandId, `command:${phase}`); preserved(fact.phase, phase);
    preserved(updated.connector.codexExecutions.canStart(`codex:${phase}`), false);
  }
  preserved(updated.connector.codexExecutions.get('codex:completed').nativeHistory.state, 'blocked');
  preserved(updated.hub.getCredentialToken('remote'), 'synthetic-token');
  preserved([...updated.hub.sessionPreferences()], [[sessionId, { pinned: true }]]);
  preserved([...await updated.hub.sessionPreferencesAsync()], [...updated.hub.sessionPreferences()]);
  preserved(updated.hub.deliveryPage(undefined, new Map([['remote', 'synthetic-domain']])).events.length, 1);
  preserved(await updated.hub.deliveryPageAsync(undefined, new Map([['remote', 'synthetic-domain']])),
    updated.hub.deliveryPage(undefined, new Map([['remote', 'synthetic-domain']])));
  preserved(updated.hub.notebooks.get('default', sessionId).text, 'Synthetic retained hot note');
  preserved(updated.hub.notebooks.getArchive('default', sessionId).text, 'Synthetic retained cold archive');
  preserved(updated.auth.sessions.has(token), true);
  preserved(updated.auth.sessions.isAccessKeySession(token), true);
  preserved(await updated.auth.routePasskeys.list(key), updated.auth.passkeys.list(key));
} finally { await updated.close(); }
const after = files.map(snapshot);
for (let i = 0; i < before.length; i++) {
  const next = new Map(after[i]);
  for (const [table, rows] of before[i]) assert.deepEqual(next.get(table), rows, `${files[i]} original table ${table} changed during read-only upgrade`);
}
const result = { version: 1, passed: true, baseline: '2.3.7', baselineTagObject: 'a3e87af23f7d8c626c8af1921bfe2484b79ab9e7', baselineCommit: '1fe624fc889f6be8b55e7ea5889d8aa6d72a92a5',
  candidateInputManifest: join(candidateEvidence, 'inputs.json'),
  syntheticDatabases: files.length, originalTables: before.map(tables => tables.length), domainAssertions: assertions,
  baselineStateSha256: beforeDigest, originalTableRowsPreserved: true, sourceManifestSha256: createHash('sha256').update(await readFile(join(candidateEvidence, 'inputs.json'))).digest('hex'),
  liveDatabaseAccess: false, nativeSessionStarted: false, deployed: false, wholeWriterAsync: false, windowsAcceptance: false };
const text = JSON.stringify(result, null, 2);
await writeFile(join(state, 'result.json'), text + '\n', { flag: 'wx', mode: 0o600 });
console.log(text);

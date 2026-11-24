import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncLocalCredentials } from './async-local-credentials.js';
import { localCredentialPlan } from './local-credential-plan.js';
import { createLocalCredentialsCommands, validLocalCredentialsInput, validLocalCredentialsOutput,
  type LocalCredentialBundle } from './local-credentials-domain.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const base = () => loadConfig({ AOD_SERVER_ROLE: 'connector' });
const specs = () => localCredentialPlan({ ...base(), serverRole: 'connector' });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'local-credentials-'));
  const cleanup: (() => Promise<unknown> | void)[] = [];
  t.after(async () => { try { for (const dispose of cleanup.reverse()) await dispose(); }
    finally { rmSync(root, { recursive: true, force: true }); } });
  return { config: { file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json') }, cleanup };
}
const minted = (input: { leaseId: string; specs: ReturnType<typeof specs> }): LocalCredentialBundle => ({
  leaseId: input.leaseId, credentials: input.specs.map(s => ({ ...s, token: `aod_local_${'x'.repeat(43)}` })),
});

test('local plan preserves default and maintenance scopes without granting remote defaults', () => {
  const plan = specs(); assert.deepEqual(plan.map(s => s.role), ['daily', 'maintenance']);
  assert.deepEqual(plan[0]!.scopes, [...DEFAULT_SCOPES, 'models:read']);
  assert.deepEqual(plan[1]!.scopes, ['sessions:read', 'models:read', 'models:write', 'connector:update', 'queue:manage']);
  assert.equal(DEFAULT_SCOPES.includes('models:read'), false);
});
test('local plan preserves explicit features, all-mode and separate stable board identities', () => {
  const config = { ...base(), serverRole: 'all' as const, boardLocalBinding: true,
    boardFiles: { root: join(tmpdir(), 'boards'), policies: [{ owner: 'local:file-boards', runtime: 'codex' as const }] },
    fileBrowserRoots: { codex: join(tmpdir(), 'workspace') }, fileBrowserLocalWrite: true,
    automationLocalManage: true, issueLocalRead: true, issueSources: [{}] as any,
    websiteLocalAccess: true, websiteLocalBrowse: true, websiteLocalActions: true, websiteLocalConnect: true,
    websiteServices: [{ browse: true, actions: [{}], sockets: [{}] }] as any,
    terminalLocalAccess: true, terminalTargets: [{ local: true }] as any };
  const plan = localCredentialPlan(config);
  assert.deepEqual(plan.map(s => s.identity), ['local:daily', 'local:maintenance', 'local:boards', 'local:file-boards', 'local:source-approval']);
  assert.deepEqual(plan[0]!.scopes.slice(DEFAULT_SCOPES.length), ['models:read', 'files:read', 'files:write',
    'automation:manage', 'issues:read', 'websites:read', 'websites:browse', 'websites:act', 'websites:connect', 'terminals:use']);
  assert.deepEqual(plan[2]!.scopes, ['boards:bind']); assert.deepEqual(plan[3]!.scopes, ['boards:files']);
  assert.deepEqual(plan[4]!.scopes, ['messages:read', 'media:read', 'source:approve', 'source:approve:admin']);
  assert.equal(plan[0]!.scopes.includes('source:approve'), false);
  assert.equal(plan[0]!.scopes.includes('source:approve:admin'), false);
  assert.equal(localCredentialPlan({ ...config, serverRole: 'connector' }).length, 2);
  const disabled = localCredentialPlan({ ...config, issueSources: [], websiteServices: [], terminalTargets: [], fileBrowserRoots: {} });
  assert.deepEqual(disabled[0]!.scopes, [...DEFAULT_SCOPES, 'models:read', 'automation:manage']);
  plan[0]!.scopes.length = 0; assert.ok(specs()[0]!.scopes.length, 'caller mutation does not change defaults');
});
test('wire rejects arbitrary identities, duplicate roles/scopes, foreign fields and malformed bearer', () => {
  const input = { leaseId: randomUUID(), specs: specs() };
  assert.ok(validLocalCredentialsInput('localCredentialsCreate', input));
  for (const candidate of [{ ...input, leaseId: 'not-a-lease' }, { ...input, authorization: 'not accepted' },
    { ...input, specs: [input.specs[0]] }, { ...input, specs: [...input.specs, input.specs[0]] },
    { ...input, specs: input.specs.map(s => ({ ...s, identity: 'actor_foreign' })) },
    { ...input, specs: input.specs.map(s => ({ ...s, scopes: ['sessions:read', 'sessions:read'] })) }]) {
    assert.equal(validLocalCredentialsInput('localCredentialsCreate', candidate), false);
  }
  const output = minted(input); assert.ok(validLocalCredentialsOutput('localCredentialsCreate', output));
  output.credentials[0]!.token = 'aod_conn_durable'; assert.equal(validLocalCredentialsOutput('localCredentialsCreate', output), false);
});
test('original conflict rolls back only this bundle and forbids a second creation attempt', t => {
  const { config } = fixture(t), tokens = new ConnectorTokenStore(config.tokenFile);
  const existing = tokens.createTransient(['models:read'], 'local:maintenance');
  const commands = createLocalCredentialsCommands(tokens), input = { leaseId: randomUUID(), specs: specs() };
  assert.throws(() => commands.execute('localCredentialsCreate', input));
  const daily = tokens.createTransient(['sessions:read'], 'local:daily'); daily.dispose();
  assert.ok(tokens.authenticateAuthorization(`Bearer ${existing.token}`), 'pre-existing conflicting identity survives');
  assert.throws(() => commands.execute('localCredentialsCreate', { ...input, leaseId: randomUUID() }));
  commands.dispose(); assert.ok(tokens.authenticateAuthorization(`Bearer ${existing.token}`)); existing.dispose();
});
test('bundle release is exact, idempotent and never releases a replacement identity', t => {
  const { config } = fixture(t), tokens = new ConnectorTokenStore(config.tokenFile);
  const commands = createLocalCredentialsCommands(tokens), leaseId = randomUUID();
  const bundle = commands.execute('localCredentialsCreate', { leaseId, specs: specs() });
  assert.equal(commands.execute('localCredentialsRelease', { leaseId: randomUUID() }).released, false);
  assert.ok(tokens.authenticateAuthorization(`Bearer ${bundle.credentials[0]!.token}`));
  assert.deepEqual(commands.execute('localCredentialsRelease', { leaseId }), { leaseId, released: true });
  const replacement = tokens.createTransient(['models:read'], 'local:daily');
  commands.execute('localCredentialsRelease', { leaseId }); commands.dispose();
  assert.ok(tokens.authenticateAuthorization(`Bearer ${replacement.token}`)); replacement.dispose();
});
test('real sole worker uses local bearer for metadata, scopes stay distinct, release revokes all without persistence', async t => {
  const { config, cleanup } = fixture(t), owner = new AsyncConnectorOwner({ ...config, bootstrapToken: 'synthetic-default',
    sdkModels: { ghcp: { model: 'original', modelChoices: ['original'] } } }, quiet);
  cleanup.push(() => owner.closeForShutdown()); await owner.open();
  const before = readFileSync(config.tokenFile, 'utf8');
  const holder = new AsyncLocalCredentials(owner, specs(), quiet); cleanup.push(() => holder.close());
  assert.throws(() => holder.token('daily'), ConnectorOwnerUnavailable);
  const first = holder.open(); assert.equal(holder.open(), first); await first;
  const daily = holder.token('daily')!, maintenance = holder.token('maintenance')!;
  assert.equal(holder.token('boards'), undefined);
  assert.equal((await owner.command('tokenAuthenticate', { authorization: `Bearer ${daily}` }))?.tokenId, 'local:daily');
  assert.equal(await owner.command('tokenHasScope', { tokenId: 'local:daily', scope: 'models:write' }), false);
  assert.equal(await owner.command('tokenHasScope', { tokenId: 'local:maintenance', scope: 'models:write' }), true);
  assert.ok(!('error' in await owner.command('sdkModelsRead', { runtime: 'ghcp', authorization: `Bearer ${daily}` })));
  assert.equal((await owner.command('tokensList', {})).some(r => r.id.startsWith('local:')), false);
  assert.equal(readFileSync(config.tokenFile, 'utf8'), before);
  const close = holder.close(); assert.equal(holder.close(), close); assert.throws(() => holder.token('daily')); await close;
  for (const token of [daily, maintenance]) assert.equal(await owner.command('tokenAuthenticate', { authorization: `Bearer ${token}` }), null);
  await assert.rejects(holder.open()); assert.equal(readFileSync(config.tokenFile, 'utf8'), before);
});
test('worker exit/reopen invalidates unpersisted local credentials while keeping stable identities and durable authority', async t => {
  const { config, cleanup } = fixture(t), owner = new AsyncConnectorOwner({ ...config, bootstrapToken: 'synthetic-default' }, quiet);
  cleanup.push(() => owner.closeForShutdown()); await owner.open();
  const bundle = await owner.command('localCredentialsCreate', { leaseId: randomUUID(), specs: specs() });
  const token = bundle.credentials[0]!.token;
  await assert.rejects(owner.command('localCredentialsCreate', { leaseId: randomUUID(), specs: specs() }));
  await owner.close();
  const reopened = new AsyncConnectorOwner(config, quiet); cleanup.push(() => reopened.closeForShutdown()); await reopened.open();
  assert.equal(await reopened.command('tokenAuthenticate', { authorization: `Bearer ${token}` }), null);
  assert.ok(await reopened.command('tokenAuthenticate', { authorization: 'Bearer synthetic-default' }));
  const next = await reopened.command('localCredentialsCreate', { leaseId: randomUUID(), specs: specs() });
  assert.notEqual(next.credentials[0]!.token, token); assert.equal(next.credentials[0]!.identity, 'local:daily');
});
test('holder retains original create until ACK when closing and never exposes a late credential', async () => {
  let finish!: (bundle: LocalCredentialBundle) => void;
  const calls: string[] = []; let original: Parameters<typeof minted>[0] | undefined;
  const command = (async (kind, input) => {
    calls.push(kind);
    if (kind === 'localCredentialsCreate') { original = input as typeof original; return new Promise(resolve => { finish = resolve; }); }
    return { leaseId: (input as { leaseId: string }).leaseId, released: true };
  }) as AsyncConnectorOwner['command'];
  const holder = new AsyncLocalCredentials({ command }, specs(), quiet), opening = holder.open();
  const closing = holder.close(); let closed = false; void closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.deepEqual(calls, ['localCredentialsCreate']);
  assert.throws(() => holder.token('daily')); finish(minted(original!)); await opening; await closing;
  assert.deepEqual(calls, ['localCredentialsCreate', 'localCredentialsRelease']); assert.throws(() => holder.token('daily'));
});
test('lost create ACK is sticky, emits no secrets and cannot trigger reissue or an invented release', async () => {
  let calls = 0; const logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(event => logs.push(JSON.stringify(event)));
  const command = (async () => { calls++; throw Error('synthetic-private-token-must-not-log'); }) as AsyncConnectorOwner['command'];
  const holder = new AsyncLocalCredentials({ command }, specs(), diagnostics);
  await assert.rejects(holder.open()); await assert.rejects(holder.open());
  const close = holder.close(); await assert.rejects(close); assert.equal(holder.close(), close); assert.equal(calls, 1);
  assert.ok(logs.length); assert.equal(logs.join('').includes('synthetic-private-token'), false);
  assert.equal(logs.join('').includes('local:daily'), false);
});
test('bad release ACK remains failed and close never retries; closing before open has no effect', async () => {
  const calls: string[] = [];
  const command = (async (kind, input) => {
    calls.push(kind); return kind === 'localCredentialsCreate' ? minted(input as Parameters<typeof minted>[0])
      : { leaseId: randomUUID(), released: true };
  }) as AsyncConnectorOwner['command'];
  const unused = new AsyncLocalCredentials({ command }, specs(), quiet); await unused.close(); await assert.rejects(unused.open());
  assert.equal(calls.length, 0);
  const holder = new AsyncLocalCredentials({ command }, specs(), quiet); await holder.open();
  const close = holder.close(); await assert.rejects(close); assert.equal(holder.close(), close);
  assert.deepEqual(calls, ['localCredentialsCreate', 'localCredentialsRelease']);
});

test('diagnostic reentry sees the already-published original open and close flights', async () => {
  const calls: string[] = []; let holder!: AsyncLocalCredentials;
  let opened: Promise<void> | undefined, closed: Promise<void> | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {
    if (calls.includes('localCredentialsRelease')) closed = holder.close();
    else opened = holder.open();
    throw Error('broken diagnostic observer');
  });
  const command = (async (kind, input) => {
    calls.push(kind);
    return kind === 'localCredentialsCreate' ? minted(input as Parameters<typeof minted>[0])
      : { leaseId: (input as { leaseId: string }).leaseId, released: true };
  }) as AsyncConnectorOwner['command'];
  holder = new AsyncLocalCredentials({ command }, specs(), diagnostics);
  const original = holder.open(); await original; assert.equal(opened, original);
  const closing = holder.close(); await closing; assert.equal(closed, closing);
  assert.deepEqual(calls, ['localCredentialsCreate', 'localCredentialsRelease']);
});

test('startup holder copies mutable configuration before issuing its original worker command', async () => {
  const input = specs(); let original: Parameters<typeof minted>[0] | undefined;
  const command = (async (kind, value) => {
    if (kind === 'localCredentialsCreate') { original = value as typeof original; return minted(original!); }
    return { leaseId: (value as { leaseId: string }).leaseId, released: true };
  }) as AsyncConnectorOwner['command'];
  const holder = new AsyncLocalCredentials({ command }, input, quiet);
  input[0]!.scopes.push('models:write'); input[0]!.identity = 'actor_foreign';
  await holder.open(); assert.equal(original!.specs[0]!.identity, 'local:daily');
  assert.equal(original!.specs[0]!.scopes.includes('models:write'), false); await holder.close();
});

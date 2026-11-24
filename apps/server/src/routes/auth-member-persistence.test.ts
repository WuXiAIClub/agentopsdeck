import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { AuthPasskeyStore } from '../auth/route-persistence.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAuthRoutes } from './auth.js';
import { AuthAuditLog, LoginAttemptLimiter } from '../auth/security.js';
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return { resolve,reject,promise }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
type Dependencies = Parameters<typeof registerAuthRoutes>[1];
function fixture(overrides: Partial<Omit<Dependencies, 'memberSessionCurrent'>> & {
  memberSessionCurrent?: Dependencies['memberSessionCurrent'];
} = {}) {
  const app = new Hono(), auditLog = new AuthAuditLog();
  const unsupported = async (): Promise<never> => { throw Error('Unexpected verification'); };
  const passkeys: AuthPasskeyStore = {status:()=>({available:false,count:0}), list:()=>[], revoke:()=>false, registrationOptions:unsupported, verifyRegistration:unsupported, authenticationOptions:unsupported, verifyAuthentication:unsupported};
  const { memberSessionCurrent, ...otherOverrides } = overrides;
  const validator = Object.hasOwn(overrides, 'memberSessionCurrent') ? memberSessionCurrent : () => true;
  const deps = { accessKey:'fixture-key', passkeys, sessions:new Set<string>(),
    isAuthorizedRequest:()=>true, auditLog, loginLimiter:new LoginAttemptLimiter({maxFailures:10,windowMs:60000,lockoutMs:1000}),
    lockoutSeconds:1, ...(validator ? { memberSessionCurrent: validator } : {}), ...otherOverrides };
  registerAuthRoutes(app,deps); return { app,auditLog,deps };
}
const login = (app: Hono) => app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accessKey:'hub_key_fixture'})});
test('member SQL login is awaited before success and session cookie delivery',async()=>{
  const pending = deferred<string | undefined>(); let calls=0,settled=false;
  const {app,auditLog}=fixture({memberLogin:()=>{calls++;return pending.promise;}});
  const response=Promise.resolve(login(app)); void response.then(()=>{settled=true;});
  await turn(); assert.equal(calls,1); assert.equal(settled,false); assert.equal(auditLog.list().length,0);
  pending.resolve('hub_session_fixture'); const result=await response;
  assert.equal(result.status,200); assert.match(result.headers.get('set-cookie')!,/hub_session_fixture/);
});
test('awaited member login resolving undefined cannot become a truthy Promise grant',async()=>{
  const {app}=fixture({memberLogin:async()=>undefined});
  const response=await login(app); assert.equal(response.status,401); assert.equal(response.headers.get('set-cookie'),null);
});
test('member SQL revoke is awaited before cookie clear or successful logout audit',async()=>{
  const pending=deferred<void>(); let settled=false,calls=0;
  const {app,auditLog}=fixture({revokeMemberSession:()=>{calls++;return pending.promise;}});
  const response=Promise.resolve(app.request('/api/auth/logout',{method:'POST',headers:{cookie:'agentopsdeck_session=hub_session_fixture'}}));
  void response.then(()=>{settled=true;}); await turn();
  assert.equal(calls,1);assert.equal(settled,false);assert.equal(auditLog.list().length,0);
  pending.resolve();const result=await response; assert.equal(result.status,200);assert.ok(result.headers.get('set-cookie'));
});
test('member session revoked while status is pending cannot receive a cookie or success audit',async()=>{
  const pending=deferred<{available: boolean; count: number}>();let current=true;
  const {app,auditLog}=fixture({memberLogin:()=> 'hub_session_fixture',memberSessionCurrent:()=>current,
    passkeys:{...fixture().deps.passkeys,status:()=>pending.promise}});
  const response=login(app);await turn();current=false;pending.resolve({available:false,count:0});
  const result=await response;assert.equal(result.status,401);assert.equal(result.headers.get('set-cookie'),null);
  assert.equal(auditLog.list().filter(r=>r.outcome==='success').length,0);
});
test('member login cannot publish without a current-session validator',async()=>{
  let calls=0;
  const {app}=fixture({memberSessionCurrent:undefined,memberLogin:()=>{calls++;return 'hub_session_fixture';}});
  const response=await login(app);assert.equal(response.status,503);assert.equal(response.headers.get('set-cookie'),null);
  assert.equal(calls,0,'missing domain proof must refuse before the original session mutation');
});
for (const port of ['memberLogin','revokeMemberSession'])
  test('original '+port+' rejection is sanitized and never publishes success or a cookie',async()=>{
    const {app,auditLog}=fixture({[port]:async()=>{throw Error('private-token-and-path');}});
    const response=port==='memberLogin'?await login(app):await app.request('/api/auth/logout',{method:'POST',headers:{cookie:'agentopsdeck_session=hub_session_fixture'}});
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'auth_persistence_failed'});
    assert.equal(response.headers.get('set-cookie'),null);assert.equal(auditLog.list().length,0);
  });

test('member identity lookup is awaited and cannot deliver a session revoked during that lookup', async () => {
  const pending = deferred<{ userId: string; keyId: string } | undefined>();
  let current = true;
  const { app, auditLog } = fixture({ memberLogin: () => 'hub_session_fixture',
    memberKeyIdentity: () => pending.promise, memberSessionCurrent: () => current });
  const response = login(app);
  await turn();
  assert.equal(auditLog.list().length, 0);
  current = false; pending.resolve({ userId: 'fixture-user', keyId: 'fixture-key-id' });
  const result = await response;
  assert.equal(result.status, 401);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(auditLog.list().length, 0);
});

test('private recovery scope is awaited and omitted when authorization disappears', async () => {
  const pending = deferred<string | undefined>(); let authorized = true;
  const { app } = fixture({ recoveryScope: () => pending.promise, isAuthorizedRequest: () => authorized });
  const response = app.request('/api/auth/status');
  await turn(); authorized = false; pending.resolve('private-recovery-scope');
  const result = await response;
  assert.equal(result.status, 200);
  assert.doesNotMatch(await result.text(), /private-recovery-scope/);
});

test('audit identity read is awaited and authorization is checked again before private audit delivery', async () => {
  const pending = deferred<{ userId: string; authMethod: 'administrator' } | undefined>();
  let authorized = true;
  const { app, auditLog } = fixture({ auditIdentity: () => pending.promise, isAuthorizedRequest: () => authorized });
  auditLog.append({ event: 'access_key_login', outcome: 'success', reason: 'private-audit-row' });
  const response = app.request('/api/auth/audit');
  await turn(); authorized = false; pending.resolve({ userId: 'fixture-user', authMethod: 'administrator' });
  const result = await response;
  assert.equal(result.status, 401);
  assert.doesNotMatch(await result.text(), /private-audit-row/);
});

test('missing member proof is logged as pre-dispatch refusal, not an unknown mutation', async () => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  const { app } = fixture({ diagnostics, memberSessionCurrent: undefined, memberLogin: () => { throw Error('must not execute'); } });
  assert.equal((await login(app)).status, 503);
  const events = diagnostics.snapshot().events.filter(row => row.operation === 'auth-route-persistence');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.step, 8);
  assert.equal(events[0]!.deferred, 1);
  assert.equal(events[0]!.unknown, undefined);
  const port = new AuthRoutePersistence(diagnostics);
  assert.throws(() => port.refuse(13), /auth_persistence_failed/);
  assert.equal(port.pending, 0);
});

test('asynchronous final member proof errors do not leak original errors or publish success', async () => {
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const { app, auditLog } = fixture({ diagnostics, memberLogin: () => 'hub_session_fixture',
    memberSessionCurrent: async () => { throw Error('private-sql-file-and-token'); } });
  const result = await login(app);
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: 'auth_persistence_failed' });
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(auditLog.list().length, 0);
  assert.ok(diagnostics.snapshot().events.some(row => row.step === 13 && row.unknown === 1));
  assert.doesNotMatch(lines.join('\n'), /private-sql-file-and-token|hub_session_fixture/);
});

for (const invalid of ['', 12, false, null, {}]) test(`invalid member mutation ACK is unknown, not a pre-dispatch refusal (${typeof invalid})`, async () => {
  let calls = 0;
  const diagnostics = new PerformanceDiagnostics(() => {});
  const invalidPort = (async () => { calls++; return invalid; }) as unknown as NonNullable<Dependencies['memberLogin']>;
  const { app, auditLog } = fixture({ diagnostics, memberLogin: invalidPort });
  const result = await login(app);
  assert.equal(result.status, 503);
  assert.equal(calls, 1);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(auditLog.list().length, 0);
  const events = diagnostics.snapshot().events.filter(row => row.operation === 'auth-route-persistence' && row.step === 8);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.admitted, 1);
  assert.equal(events[0]!.unknown, 1);
  assert.equal(events[0]!.settled, undefined);
  assert.equal(events[0]!.deferred, undefined);
});

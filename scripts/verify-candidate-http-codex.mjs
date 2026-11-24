import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function invalidProcessObservation(code) {
  return Object.assign(new Error('Process stop proof unavailable; outcome unknown'), { code });
}

export function parseProcessStat(text, pid) {
  const closing = typeof text === 'string' ? text.lastIndexOf(')') : -1;
  const prefix = typeof text === 'string' ? text.slice(0, text.indexOf('(')) : '';
  const fields = closing >= 0 ? text.slice(closing + 1).trim().split(/\s+/) : [];
  if (!Number.isSafeInteger(pid) || pid < 1 || text?.length > 8192 || prefix !== `${pid} `
    || closing < text.indexOf('(') || !/^\s/.test(text.slice(closing + 1))
    || fields.length < 20 || !/^[RSDZTtWXxKPI]$/.test(fields[0])
    || !fields.slice(1).every(field => /^-?(0|[1-9]\d*)$/.test(field))
    || !/^(0|[1-9]\d*)$/.test(fields[1]) || !Number.isSafeInteger(Number(fields[1]))
    || !/^(0|[1-9]\d*)$/.test(fields[19])) {
    throw invalidProcessObservation('ERR_INVALID_PROC_STAT');
  }
  return { pid, parent: Number(fields[1]), start: fields[19], state: fields[0] };
}

export async function readProcessIdentity(pid, readText = readFile) {
  try { return parseProcessStat(await readText(`/proc/${pid}/stat`, 'utf8'), pid); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function processTerminationProof(identity, readText = readFile) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1
    || typeof identity.start !== 'string' || !/^(0|[1-9]\d*)$/.test(identity.start)) {
    throw invalidProcessObservation('ERR_INVALID_PROC_STAT');
  }
  const current = await readProcessIdentity(identity.pid, readText);
  const reason = !current ? 'absent' : current.start !== identity.start ? 'identity-replaced'
    : current.state === 'Z' ? 'zombie' : undefined;
  return reason ? { pid: identity.pid, start: identity.start, reason } : undefined;
}

function processUnknown(operation, error, pid) {
  const codes = ['ENOENT', 'EACCES', 'EIO', 'ERR_INVALID_PROC_STAT', 'ERR_PROC_ENVIRONMENT', 'ERR_PROCESS_IDENTITY_CHANGED'];
  return { operation, ...(pid === undefined ? {} : { pid }),
    code: codes.includes(error?.code) ? error.code : 'ERR_PROCESS_INSPECTION' };
}

export async function snapshotProcessOwnership(fixtureHomes, { readText = readFile, readDirectory = readdir } = {}) {
  let names;
  try {
    names = await readDirectory('/proc');
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) throw invalidProcessObservation('ERR_INVALID_PROC_STAT');
  } catch (error) { return { processes: [], unknown: [processUnknown('proc-directory', error)] }; }
  const processes = [], unknown = [];
  await Promise.all(names.filter(name => /^\d+$/.test(name)).map(async name => {
    const pid = Number(name);
    try {
      const before = await readProcessIdentity(pid, readText);
      if (!before) return;
      let environment;
      try { environment = await readText(`/proc/${pid}/environ`, 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const after = await readProcessIdentity(pid, readText);
        if (!after || after.start !== before.start) return;
        throw error;
      }
      if (typeof environment !== 'string' || environment && !environment.endsWith('\0')) {
        throw invalidProcessObservation('ERR_PROC_ENVIRONMENT');
      }
      const after = await readProcessIdentity(pid, readText);
      if (!after) return;
      if (after.start !== before.start) throw invalidProcessObservation('ERR_PROCESS_IDENTITY_CHANGED');
      const fixtureOwned = environment.split('\0').some(value => fixtureHomes.includes(value));
      processes.push({ ...after, fixtureOwned });
    } catch (error) { unknown.push(processUnknown('proc-process', error, pid)); }
  }));
  return { processes: processes.sort((first, second) => first.pid - second.pid), unknown };
}

function ownedProcessIdentities(processes, identities) {
  const known = new Map(identities.map(item => [`${item.pid}:${item.start}`, item]));
  const owned = new Set(processes.filter(item => item.fixtureOwned || known.has(`${item.pid}:${item.start}`)).map(item => item.pid));
  for (let previous = -1; previous !== owned.size;) {
    previous = owned.size;
    for (const item of processes) if (owned.has(item.parent)) owned.add(item.pid);
  }
  for (const item of processes) if (owned.has(item.pid)) known.set(`${item.pid}:${item.start}`, item);
  return [...known.values()];
}

export async function verifyCandidateShutdown({ child, lifetime, closed, fixtureHomes, wait,
  readText = readFile, readDirectory = readdir }) {
  lifetime.shutdownProof = 'unknown';
  delete lifetime.descendantsExited;
  delete lifetime.terminationProofs;
  const unknown = lifetime.shutdownUnknown ??= [];
  let identities = lifetime.shutdownDescendants ?? [];
  if (Number.isSafeInteger(child.pid) && typeof lifetime.start === 'string') {
    identities = ownedProcessIdentities([], [...identities, { pid: child.pid, start: lifetime.start }]);
  } else unknown.push({ operation: 'server-identity', code: 'ERR_INVALID_PROC_STAT' });
  const scan = async () => {
    const snapshot = await snapshotProcessOwnership(fixtureHomes, { readText, readDirectory });
    unknown.push(...snapshot.unknown);
    identities = ownedProcessIdentities(snapshot.processes, identities);
    lifetime.shutdownDescendants = identities;
  };
  await scan();
  try {
    if (child.exitCode === null && child.signalCode === null) assert.equal(child.kill('SIGTERM'), true);
    await wait('graceful server shutdown', () => lifetime.closed && lifetime, 120000);
    await closed;
    assert.equal(lifetime.code, 0);
  } catch (error) { unknown.push(processUnknown('server-shutdown', error)); }
  await wait('native descendants exit', async () => {
    await scan();
    const proofs = await Promise.all(identities.map(async identity => {
      try { return await processTerminationProof(identity, readText); }
      catch (error) { unknown.push(processUnknown('descendant-identity', error, identity.pid)); return undefined; }
    }));
    lifetime.remainingDescendants = identities.filter((item, index) => !proofs[index]).map(item => item.pid);
    if (unknown.length) throw invalidProcessObservation('ERR_PROCESS_STOP_UNKNOWN');
    if (lifetime.remainingDescendants.length) return false;
    lifetime.terminationProofs = proofs;
    return true;
  }, 10000);
  lifetime.shutdownProof = 'verified';
  lifetime.descendantsExited = identities.map(item => item.pid);
}

const SAFE_API_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_DIAGNOSTIC_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function sanitizeApiErrorSummary(value) {
  if (value === undefined || value === null || value === '') return 'none';
  if (typeof value === 'string' && SAFE_API_ERROR_CODE.test(value)) return value;
  if (typeof value === 'object' && typeof value.code === 'string' && SAFE_API_ERROR_CODE.test(value.code)) {
    return value.code;
  }
  return 'redacted-error';
}

function scrubDiagnosticText(raw, redactions = []) {
  let text = typeof raw === 'string' ? raw : '';
  for (const secret of redactions) {
    if (typeof secret === 'string' && secret.length >= 4) {
      text = text.replaceAll(secret, '[redacted]');
    }
  }
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ghp|ghu|ghs|glpat|xox[baprs]|aod)_[A-Za-z0-9_-]{8,}\b/gi, '[redacted-token]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted-hex]')
    .replace(/https?:\/\/[^\s)'"`]+/gi, match => {
      try {
        const parsed = new URL(match);
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
          return `${parsed.protocol}//${parsed.host}${parsed.pathname}[redacted-url]`;
        }
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      } catch {
        return '[redacted-url]';
      }
    })
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/g, '[redacted-path]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export function formatCandidateFailureDiagnostic(error, step = 'unknown', redactions = []) {
  const safeStep = typeof step === 'string' && SAFE_DIAGNOSTIC_TOKEN.test(step) ? step : 'unknown';
  const rawName = typeof error?.name === 'string' && SAFE_DIAGNOSTIC_TOKEN.test(error.name) ? error.name : 'Error';
  const rawCode = typeof error?.code === 'string' && SAFE_DIAGNOSTIC_TOKEN.test(error.code) ? error.code : undefined;
  if (error instanceof assert.AssertionError || rawName === 'AssertionError') {
    const scrubbed = scrubDiagnosticText(error?.message ?? 'Assertion failed', redactions) || 'Assertion failed';
    return { name: 'AssertionError', message: (`${safeStep}: ${scrubbed}`).slice(0, 200) };
  }
  const rawMessage = typeof error?.message === 'string' ? error.message : '';
  if (/^Timeout:\s+[A-Za-z0-9 _.:/-]{1,120}$/.test(rawMessage)) {
    const scrubbed = scrubDiagnosticText(rawMessage, redactions);
    return { name: rawName, message: (`${safeStep}: ${scrubbed}`).slice(0, 200) };
  }
  const classifier = rawCode ? `${rawName} (${rawCode})` : rawName;
  return { name: rawName, message: `${safeStep}: ${classifier}`.slice(0, 200) };
}

export function hasTurnBoundAssistantReply(messages, { turnId, marker, priorMessageIds, match = 'exact' } = {}) {
  if (!Array.isArray(messages) || typeof turnId !== 'string' || !turnId.trim() || typeof marker !== 'string' || !marker) {
    return false;
  }
  return messages.some(message => {
    if (!message || message.role !== 'assistant' || message.status === 'failed' || typeof message.text !== 'string') {
      return false;
    }
    if (typeof message.turnId === 'string' && message.turnId.trim()) {
      if (message.turnId !== turnId) return false;
    } else if (priorMessageIds instanceof Set && typeof message.id === 'string' && message.id) {
      if (priorMessageIds.has(message.id)) return false;
    } else {
      return false;
    }
    return match === 'includes' ? message.text.includes(marker) : message.text.trim() === marker;
  });
}

async function main() {
const { verifyCandidateRelease } = await import('./stage-candidate-release.mjs');

const [candidateRoot, command, model, providerOrigin] = process.argv.slice(2);
assert.ok(process.argv.length === 6 && isAbsolute(candidateRoot) && isAbsolute(command));
assert.match(model, /^[a-zA-Z0-9._-]+$/);
const stopRepeats = Number(process.env.AOD_TEST_STOP_REPEATS ?? 1);
assert.ok(Number.isSafeInteger(stopRepeats) && stopRepeats >= 1 && stopRepeats <= 5);
const provider = new URL(providerOrigin);
assert.ok(provider.protocol === 'http:' && provider.hostname === '127.0.0.1' && provider.port
  && !provider.username && !provider.password && !provider.search && !provider.hash && provider.pathname === '/');
const candidate = await verifyCandidateRelease(candidateRoot);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-http-codex-e2e-'));
console.log('EVIDENCE', directory);
// Observe only fixture-owned interrupt calls. Keep production code and the
// immutable candidate unchanged; never log RPC bodies, native output or IDs.
const interruptObserver = join(directory, 'interrupt-observer.mjs');
await writeFile(interruptObserver, `
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { CodexAppServer } from ${JSON.stringify(pathToFileURL(join(candidateRoot, 'apps/server/dist/codex/app-server.js')).href)};
const scope = new AsyncLocalStorage();
const output = ${JSON.stringify(join(directory, 'interrupt-observations.jsonl'))};
const emit = record => appendFileSync(output, JSON.stringify({ at: Date.now(), ...record }) + '\\n', { mode: 0o600 });
const identity = value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;
const originalNotification = CodexAppServer.prototype.handleNotification;
CodexAppServer.prototype.handleNotification = function(method, params) {
  const result = originalNotification.call(this, method, params);
  if (['item/started', 'item/completed', 'turn/completed'].includes(method)) {
    const fact = this.options.executions.get('codex:' + params?.threadId);
    emit({ notification: method, itemType: params?.item?.type, itemStatus: params?.item?.status,
      item: identity(params?.item?.id), run: identity(params?.turnId ?? params?.turn?.id),
      boundRun: identity(fact?.runId), phase: fact?.phase, pending: (fact?.pendingCommandTools ?? []).map(identity) });
  }
  return result;
};
const classify = error => {
  const message = error instanceof Error ? error.message : '';
  const reconciliation = message.replace(/^Codex completed, but AgentOpsDeck could not load the final response: /, '');
  if (/^Final history missing [0-9]+ assistant items, [0-9]+ live tools; [0-9]+ tools still incomplete$/.test(reconciliation)) return reconciliation;
  if (['Final turn snapshot is incomplete', 'New execution or live events arrived during final synchronization'].includes(reconciliation)) return reconciliation;
  if (/^Invalid Codex background terminal (page|identity|termination response)$/.test(message)) return message;
  if (/^Codex background terminals are still running$/.test(message)) return message;
  if (/^Codex background terminal belongs to another run$/.test(message)) return message;
  if (/timed out/i.test(message)) return 'timeout';
  return error?.name === 'RunControlConflict' ? 'run-control-conflict'
    : error?.name === 'TurnAuthorizationError' ? 'authorization-changed' : 'unclassified';
};
const originalRequest = CodexAppServer.prototype.request;
CodexAppServer.prototype.request = async function(method, params, ...rest) {
  const observation = scope.getStore();
  if (!observation) return originalRequest.call(this, method, params, ...rest);
  const started = Date.now();
  try {
    const result = await originalRequest.call(this, method, params, ...rest);
    const details = method === 'thread/read' ? { latestTurnMatches: result?.thread?.turns?.at(-1)?.id === observation.turnId,
      threadStatus: result?.thread?.status,
      latestTurnStatus: result?.thread?.turns?.at(-1)?.status,
      latestTurnItemTypes: [...new Set((Array.isArray(result?.thread?.turns?.at(-1)?.items) ? result.thread.turns.at(-1).items : []).map(item => item?.type))] }
      : method === 'thread/backgroundTerminals/list' ? { terminalCount: result?.data?.length,
        terminalItems: (Array.isArray(result?.data) ? result.data : []).map(item => identity(item?.itemId)),
        terminalIdentityTypes: (Array.isArray(result?.data) ? result.data : []).map(item => [typeof item?.processId, typeof item?.itemId]) }
      : method === 'thread/backgroundTerminals/terminate' ? { terminated: result?.terminated } : {};
    emit({ method, elapsedMs: Date.now() - started, ok: true, ...details });
    return result;
  } catch (error) { emit({ method, elapsedMs: Date.now() - started, ok: false, category: classify(error) }); throw error; }
};
const originalPublishRun = CodexAppServer.prototype.publishRun;
CodexAppServer.prototype.publishRun = function(key, runtime, ...rest) {
  if (runtime.sync === 'error') emit({ projection: 'error', phase: runtime.phase,
    category: classify(new Error(runtime.reason ?? '')) });
  return originalPublishRun.call(this, key, runtime, ...rest);
};
const originalInterrupt = CodexAppServer.prototype.interrupt;
CodexAppServer.prototype.interrupt = function(...args) {
  return scope.run({ turnId: args[1] }, async () => {
    try { const result = await originalInterrupt.apply(this, args); emit({ interrupt: 'accepted' }); return result; }
    catch (error) { emit({ interrupt: 'failed', category: classify(error) }); throw error; }
  });
};
const originalReconcile = CodexAppServer.prototype.reconcileCompletedTurn;
CodexAppServer.prototype.reconcileCompletedTurn = function(...args) {
  return scope.run({ turnId: args[3] }, () => originalReconcile.apply(this, args));
};
`, { mode: 0o600 });
for (const name of ['home', 'native', 'state', 'workspace', 'tmp']) await mkdir(join(directory, name));
await writeFile(join(directory, 'native/config.toml'), `model = ${JSON.stringify(model)}
model_provider = "copilot_bridge"
[model_providers.copilot_bridge]
name = "copilot_bridge"
base_url = ${JSON.stringify(provider.origin)}
wire_api = "responses"
requires_openai_auth = false
`, { mode: 0o600 });
const nonce = randomBytes(12).toString('hex');
await writeFile(join(directory, 'workspace/input.txt'), nonce, { mode: 0o600 });
await writeFile(join(directory, 'workspace/probe.mjs'), `import { readFile, writeFile } from 'node:fs/promises';
const mode = process.argv[2];
const root = new URL('./', import.meta.url);
const value = await readFile(new URL('input.txt', root), 'utf8');
const fields = (await readFile('/proc/self/stat', 'utf8')).split(') ').at(-1).split(' ');
await writeFile(new URL(mode + '-process.json', root), JSON.stringify({ pid: process.pid, start: fields[19] }));
await writeFile(new URL(mode + '-started.txt', root), value);
if (mode === 'queue') await new Promise(resolve => setTimeout(resolve, 20000));
if (mode.startsWith('stop')) await new Promise(resolve => setTimeout(resolve, 90000));
await writeFile(new URL(mode + '-done.txt', root), value);
console.log('PROBE_' + mode.toUpperCase() + '_OK');
`, { mode: 0o600 });
const accessKey = randomBytes(32).toString('hex');
const vault = randomBytes(32).toString('hex');
const evidence = { candidateRoot, candidate, directory, startedAt: new Date().toISOString(), passed: false,
  transport: 'real-TCP-HTTP-and-SSE', native: command, model, provider: provider.origin,
  approvalPolicy: 'on-request', sandboxOverride: false, userInstanceTouched: false,
  checks: [], requests: [], streams: [], lifetimes: [], errors: [] };
const save = () => writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, closed, origin, cookie, recoveryScope, sessionPath, sessionKey, streamController, streamTask, browser;
let currentStep = 'startup', generation = 0;
async function until(label, check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(250);
  }
  throw new Error(`Timeout: ${label}`);
}
async function request(path, body, options = {}) {
  const method = options.method ?? (body === undefined ? 'GET' : 'POST');
  const started = Date.now();
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(20000),
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}),
      ...(recoveryScope ? { 'x-agentopsdeck-recovery-scope': recoveryScope } : {}), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  evidence.requests.push({ step: currentStep, method, path, status: response.status, elapsedMs: Date.now() - started });
  const receiptState = typeof value?.command?.state === 'string' && SAFE_API_ERROR_CODE.test(value.command.state)
    ? value.command.state : 'absent';
  assert.equal(response.status, options.status ?? (path.endsWith('/agents/codex/sessions') && method === 'POST' ? 201 : 200),
    `${method} ${path} HTTP status (receipt: ${receiptState}; error: ${sanitizeApiErrorSummary(value?.error)})`);
  if (path === '/api/auth/login') cookie = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
  return value;
}
async function login() {
  cookie = undefined; recoveryScope = undefined;
  await request('/api/auth/login', { accessKey });
  recoveryScope = (await request('/api/auth/status')).recoveryScope;
  assert.ok(recoveryScope);
}
async function start() {
  generation++;
  const log = createWriteStream(join(directory, `server-${generation}.log`), { mode: 0o600 });
  child = spawn(process.execPath, ['--import', pathToFileURL(interruptObserver).href, join(candidateRoot, candidate.entrypoint)], {
    cwd: join(directory, 'state'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), PATH: '/usr/bin:/bin', NODE_ENV: 'production',
      CODEX_HOME: join(directory, 'native'), PORT: '0', AOD_LISTEN_HOST: '127.0.0.1', AOD_SERVER_ROLE: 'all',
      AOD_ACCESS_KEY: accessKey, AOD_HUB_VAULT_SECRET: vault,
      AOD_CODEX_ENABLED: 'true', AOD_CODEX_COMMAND: command, AOD_CODEX_HOME: join(directory, 'native'),
      AOD_CODEX_DEFAULT_CWD: join(directory, 'workspace'), AOD_CODEX_DEFAULT_MODEL: model,
      AOD_CODEX_MODEL_PROVIDER: 'copilot_bridge', AOD_CODEX_APPROVAL_POLICY: 'on-request',
      AOD_CONNECTOR_ENV_ID: 'parallel-codex', AOD_HUB_LOCAL_CONNECTION_ID: 'parallel-codex',
      AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
      AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_MEDIA_LIBRARY_ENABLED: 'false',
      AOD_ARTIFACT_RECEIVER_ENABLED: 'false', AOD_ARTIFACT_CAPABILITY_INJECTION: 'false',
      AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false' },
  });
  const lifetime = { pid: child.pid, generation, closed: false };
  evidence.lifetimes.push(lifetime);
  closed = new Promise(resolve => child.once('close', (code, signal) => {
    Object.assign(lifetime, { closed: true, code, signal }); log.end(); resolve(lifetime);
  }));
  let output = '';
  child.stdout.on('data', chunk => { log.write(chunk); output += chunk; });
  child.stderr.pipe(log, { end: false });
  child.on('error', () => { lifetime.spawnError = true; });
  lifetime.start = (await readProcessIdentity(child.pid))?.start;
  assert.ok(lifetime.start, 'Server process identity must be observed');
  await until('HTTP listener', () => {
    assert.equal(lifetime.closed || !!lifetime.spawnError, false, 'Server exited during startup');
    const found = output.match(/AgentOpsDeck server listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (found) { origin = found[1]; lifetime.origin = origin; return true; }
  }, 20000);
  assert.equal((await request('/api/health')).ok, true);
  await login();
}
async function stop() {
  streamController?.abort();
  await streamTask;
  if (!child) return;
  await verifyCandidateShutdown({ child, lifetime: evidence.lifetimes.at(-1), closed, wait: until,
    fixtureHomes: [`HOME=${join(directory, 'home')}`, `CODEX_HOME=${join(directory, 'native')}`] });
}
async function stream(lastEventId) {
  streamController = new AbortController();
  const response = await fetch(origin + '/api/hub/v1/events/stream', { signal: streamController.signal,
    headers: { cookie, origin, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const record = { generation, types: {}, sessionEvents: 0, lastId: lastEventId, unexpectedClose: false };
  evidence.streams.push(record);
  const controller = streamController;
  streamTask = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const type = frame.match(/^event: ?(.+)$/m)?.[1];
          const id = frame.match(/^id: ?(.+)$/m)?.[1];
          if (type) record.types[type] = (record.types[type] ?? 0) + 1;
          if (id) record.lastId = id;
          if (sessionKey && frame.includes(sessionKey)) record.sessionEvents++;
        }
      }
      if (!controller.signal.aborted) record.unexpectedClose = true;
    } catch { if (!controller.signal.aborted) record.unexpectedClose = true; }
  })();
}
async function session() {
  const state = await request('/api/hub/v1/sessions/state');
  const found = state.groups.flatMap(group => group.sessions).find(item => item.sessionKey === sessionKey);
  if (found) evidence.lastRuntime = found.runtime;
  return found;
}
async function messages() { return (await request(`${sessionPath}/messages?limit=100`)).messages; }
async function snapshotMessageIds() { return new Set((await messages()).map(item => item.id).filter(Boolean)); }
async function send(key, message, extra = {}) {
  const result = await request(`${sessionPath}/messages`, { message, deliveryMode: 'web-only', media: [], idempotencyKey: key, ...extra });
  assert.equal(result.command.state, 'accepted', 'Message must have a durable acceptance receipt');
  return result;
}
async function completion(marker, previousRun, priorMessageIds) {
  return until(`assistant reply ${marker}`, async () => {
    const item = await session();
    if (!item || !item.runtime?.turnId || item.runtime?.turnId === previousRun) return false;
    assert.notEqual(item.runtime?.phase, 'failed', 'Native turn failed');
    if (item.runtime?.phase !== 'completed' || item.runtime.sync !== 'current' || item.hasActiveRun) return false;
    const history = await messages();
    assert.ok(hasTurnBoundAssistantReply(history, {
      turnId: item.runtime.turnId,
      marker,
      priorMessageIds,
    }), `Missing turn-bound assistant marker ${marker}`);
    return item.runtime.turnId;
  });
}
async function check(name, operation) {
  currentStep = name;
  console.log('STEP', name);
  const started = Date.now();
  const result = await operation();
  evidence.checks.push({ name, elapsedMs: Date.now() - started, passed: true });
  await save();
  console.log('PASS', name);
  return result;
}
const probe = mode => `Execute exactly this harmless command once: ${process.execPath} ${join(directory, 'workspace/probe.mjs')} ${mode}. `
  + `It only reads and writes the temporary test workspace. Wait for it to finish, then reply with exactly PROBE_${mode.toUpperCase()}_OK. Do not access other paths or use other tools.`;
try {
  await check('real-entrypoint-login', start);
  await check('verify-create-receipt-idempotency', async () => {
    await request('/api/hub/v1/connections/parallel-codex/verify', {});
    const path = '/api/hub/v1/connections/parallel-codex/agents/codex/sessions';
    const body = { title: 'Isolated real HTTP E2E', idempotencyKey: 'e2e.create' };
    const creation = await request(path, body);
    assert.equal(creation.command.state, 'accepted');
    sessionKey = creation.key; assert.ok(sessionKey);
    sessionPath = `/api/hub/v1/sessions/${encodeURIComponent(sessionKey)}`;
    evidence.sessionKey = sessionKey;
    assert.equal((await request(path, body)).key, sessionKey);
    assert.equal((await request(`${path}/creation-commands/e2e.create`)).command.state, 'accepted');
    await until('created session projection', session);
    await stream();
  });
  let lastRun = await check('first-message-SSE-history-and-receipt', async () => {
    const priorFirstIds = await snapshotMessageIds();
    const message = 'Remember the code word JADE_47 for this conversation. Reply with exactly HELLO_OK. Do not use tools.';
    await send('e2e.first', message);
    await send('e2e.first', message);
    const turn = await completion('HELLO_OK', undefined, priorFirstIds);
    assert.equal((await request(`${sessionPath}/commands/e2e.first`)).command.state, 'accepted');
    assert.equal((await messages()).filter(item => item.role === 'user').length, 1);
    await until('session SSE events', () => evidence.streams.at(-1).sessionEvents > 0, 10000);
    assert.equal(evidence.streams.at(-1).unexpectedClose, false);
    return turn;
  });
  lastRun = await check('second-message-retains-context-after-relogin', async () => {
    streamController.abort(); await streamTask;
    await login(); await stream(evidence.streams.at(-1).lastId);
    assert.equal((await messages()).filter(item => item.role === 'user').length, 1);
    const priorContextIds = await snapshotMessageIds();
    await send('e2e.context', 'What code word did I ask you to remember? Reply with only that word, without tools.');
    return completion('JADE_47', lastRun, priorContextIds);
  });
  lastRun = await check('real-tool-read-write-queue-edit-cancel', async () => {
    const priorToolIds = await snapshotMessageIds();
    await send('e2e.tool', probe('queue'));
    await until('real tool started', async () => {
      const state = await session();
      assert.notEqual(state?.runtime?.phase, 'failed');
      return readFile(join(directory, 'workspace/queue-started.txt'), 'utf8').then(value => value === nonce, () => false);
    });
    const toolRun = (await session()).runtime.turnId;
    assert.ok(toolRun); assert.notEqual(toolRun, lastRun);
    const queued = await send('e2e.cancelled', 'Reply with exactly SHOULD_NOT_RUN. Do not use tools.');
    const page = await request(`${sessionPath}/queue`);
    const item = page.items.find(value => value.id === queued.idempotencyKey);
    assert.ok(item, 'Admitted backlog must appear in queue');
    const target = `${sessionPath}/queue/${encodeURIComponent(item.id)}`;
    const edited = await request(target, { message: 'Reply with exactly EDITED_SHOULD_NOT_RUN. Do not use tools.' },
      { method: 'PATCH', headers: { 'if-match': JSON.stringify(item.version), 'idempotency-key': 'e2e.edit' } });
    assert.equal(edited.command.state, 'accepted');
    const updated = (await request(`${sessionPath}/queue`)).items.find(value => value.id === item.id);
    assert.ok(updated); assert.notEqual(updated.version, item.version);
    const cancelled = await request(target, undefined, { method: 'DELETE',
      headers: { 'if-match': JSON.stringify(updated.version), 'idempotency-key': 'e2e.cancel' } });
    assert.equal(cancelled.command.state, 'accepted');
    assert.equal((await request(`${target}/commands/e2e.cancel`)).command.state, 'accepted');
    const successor = await send('e2e.successor', 'Reply with exactly QUEUE_FOLLOWUP_OK. Do not use tools.');
    assert.ok((await request(`${sessionPath}/queue`)).items.some(value => value.id === successor.idempotencyKey));
    const turn = await completion('QUEUE_FOLLOWUP_OK', toolRun, priorToolIds);
    assert.equal(await readFile(join(directory, 'workspace/queue-done.txt'), 'utf8'), nonce);
    assert.equal((await request(`${sessionPath}/queue`)).items.length, 0);
    const history = await messages();
    assert.equal(history.filter(item => item.role === 'user').length, 4);
    assert.ok(hasTurnBoundAssistantReply(history, {
      turnId: toolRun,
      marker: 'PROBE_QUEUE_OK',
      priorMessageIds: priorToolIds,
    }), 'Missing turn-bound PROBE_QUEUE_OK reply');
    return turn;
  });
  for (let attempt = 0; attempt < stopRepeats; attempt++) await check(`targeted-stop-real-running-tool-${attempt + 1}`, async () => {
    const mode = attempt ? `stop-${attempt + 1}` : 'stop';
    const commandKey = attempt ? `e2e.stop.${attempt + 1}` : 'e2e.stop';
    await send(`e2e.long.${attempt + 1}`, probe(mode));
    await until('interruptible real tool started', () => readFile(join(directory, `workspace/${mode}-started.txt`), 'utf8').then(value => value === nonce, () => false));
    const active = await session();
    assert.ok(active.hasActiveRun); assert.ok(active.runtime.turnId); assert.notEqual(active.runtime.turnId, lastRun);
    await send(commandKey, '/stop', { expectedRunId: active.runtime.turnId });
    await until('interrupted and idle', async () => {
      const item = await session();
      return item.runtime.turnId === active.runtime.turnId && item.runtime.phase === 'interrupted'
        && item.runtime.sync === 'current' && !item.hasActiveRun;
    }, 30000);
    assert.equal((await request(`${sessionPath}/queue`)).items.length, 0);
    const stopped = JSON.parse(await readFile(join(directory, `workspace/${mode}-process.json`), 'utf8'));
    assert.ok(Number.isSafeInteger(stopped.pid) && stopped.pid > 1 && typeof stopped.start === 'string');
    await until('stopped native tool actually exited', () => processTerminationProof(stopped), 2000);
    assert.equal(await readFile(join(directory, `workspace/${mode}-done.txt`), 'utf8').then(() => true, () => false), false);
    lastRun = active.runtime.turnId;
  });
  await check('graceful-restart-history-receipts-and-next-message', async () => {
    const before = await messages();
    await stop(); await start(); await stream();
    await until('restored same idle session', async () => {
      const item = await session(); return item && item.runtime.sync === 'current' && !item.hasActiveRun;
    });
    assert.deepEqual((await messages()).map(item => [item.role, item.text]), before.map(item => [item.role, item.text]));
    assert.equal((await request(`${sessionPath}/commands/e2e.first`)).command.state, 'accepted');
    assert.equal((await request(`${sessionPath}/commands/e2e.stop`)).command.state, 'accepted');
    assert.equal((await request(`${sessionPath}/queue`)).items.length, 0);
    const priorRestartIds = await snapshotMessageIds();
    await send('e2e.restart', 'What was the code word at the beginning? Reply with exactly RESTART_ followed by that word, without tools.');
    await completion('RESTART_JADE_47', lastRun, priorRestartIds);
    assert.equal((await messages()).filter(item => item.role === 'user').length, 5 + stopRepeats);
  });
  await check('native-rollout-no-extra-turns-and-tool-proof', async () => {
    for (let attempt = 0; attempt < stopRepeats; attempt++) {
      const mode = attempt ? `stop-${attempt + 1}` : 'stop';
      assert.equal(await readFile(join(directory, `workspace/${mode}-done.txt`), 'utf8').then(() => true, () => false), false,
        'Interrupted tools must not finish later after a successor was admitted');
    }
    const files = await readdir(join(directory, 'native/sessions'), { recursive: true });
    const rollouts = files.filter(file => file.endsWith('.jsonl'));
    assert.equal(rollouts.length, 1);
    const records = (await readFile(join(directory, 'native/sessions', rollouts[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const started = records.filter(item => item.type === 'event_msg' && item.payload?.type === 'task_started');
    assert.equal(started.length, 5 + stopRepeats, 'Idempotency, cancel and restart must not replay turns');
    evidence.nativeTurnStarts = started.length;
    evidence.nativeToolCalls = records.filter(item => item.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(item.payload?.type)).length;
    assert.ok(evidence.nativeToolCalls >= 2);
    const usage = records.filter(item => item.type === 'event_msg' && item.payload?.type === 'token_count').at(-1)?.payload?.info;
    assert.ok(Number.isSafeInteger(usage?.last_token_usage?.total_tokens), 'Real provider must supply a context usage sample');
    const projection = await session();
    assert.equal(projection.contextUsedTokens, usage.last_token_usage.total_tokens);
    assert.equal(projection.contextTokens, usage.model_context_window);
    assert.equal(projection.compactionCount, records.filter(item => item.type === 'compacted').length);
    evidence.contextUsage = { used: projection.contextUsedTokens, limit: projection.contextTokens, compactions: projection.compactionCount };
    assert.deepEqual(await verifyCandidateRelease(candidateRoot), candidate);
  });
  if (process.env.AOD_TEST_PLAYWRIGHT) await check('real-browser-create-send-reload-mobile-followup', async () => {
    const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT);
    browser = await chromium.launch({ headless: true,
      ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', locale: 'en-US' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.name));
    await page.goto(origin);
    await page.locator('input[type="password"]').fill(accessKey);
    await page.getByRole('button', { name: 'Sign in with access key', exact: true }).click();
    await page.getByRole('button', { name: 'New session', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create new session' });
    await until('actual Codex browser creation target', async () => {
      const selected = await dialog.getByLabel('Agent', { exact: true }).inputValue();
      if (selected === 'codex') return true;
      evidence.browserCreationWaiting = { selected,
        environments: await dialog.getByLabel('Environment', { exact: true }).innerText(),
        agents: await dialog.getByLabel('Agent', { exact: true }).innerText() };
      assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true,
        'Unresolved initial target must not permit creation');
      return false;
    }, 30000);
    await dialog.getByLabel('Session name').fill('Real browser E2E');
    const created = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url().endsWith('/agents/codex/sessions'));
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    const creationResponse = await created;
    assert.equal(creationResponse.status(), 201);
    const creation = await creationResponse.json();
    sessionKey = creation.key; sessionPath = `/api/hub/v1/sessions/${encodeURIComponent(sessionKey)}`;
    const priorBrowserFirstIds = await snapshotMessageIds();
    const prompt = 'Remember BROWSER_JADE_47. Reply with exactly BROWSER_HELLO_OK. Do not use tools.';
    await page.getByPlaceholder('Message this agent…', { exact: true }).fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('BROWSER_HELLO_OK', { exact: true }).first().waitFor({ timeout: 120000 });
    const firstRun = await completion('BROWSER_HELLO_OK', undefined, priorBrowserFirstIds);
    await page.reload();
    await page.getByText('BROWSER_HELLO_OK', { exact: true }).first().waitFor({ timeout: 30000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/#/tab/sessions`);
    await page.getByText('Real browser E2E', { exact: true }).first().click();
    const priorBrowserSecondIds = await snapshotMessageIds();
    await page.getByPlaceholder('Message this agent…', { exact: true }).fill('What word did I ask you to remember? Reply with only that word, without tools.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('BROWSER_JADE_47', { exact: true }).first().waitFor({ timeout: 120000 });
    await completion('BROWSER_JADE_47', firstRun, priorBrowserSecondIds);
    assert.equal((await messages()).filter(item => item.role === 'user').length, 2);
    assert.equal((await request(`${sessionPath}/queue`)).items.length, 0);
    assert.deepEqual(pageErrors, []);
    const rollouts = (await readdir(join(directory, 'native/sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'));
    assert.equal(rollouts.length, 2);
    let starts = 0;
    for (const file of rollouts) starts += (await readFile(join(directory, 'native/sessions', file), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line)).filter(item => item.type === 'event_msg' && item.payload?.type === 'task_started').length;
    assert.equal(starts, 7 + stopRepeats);
    evidence.browser = { desktop: true, mobile: true, reload: true, pageErrors, totalNativeTurnStarts: starts };
    await browser.close(); browser = undefined;
  });
  evidence.passed = true;
} catch (error) {
  evidence.failedStep = currentStep;
  const diagnostic = formatCandidateFailureDiagnostic(error, currentStep, [accessKey, vault, directory]);
  evidence.errors.push(diagnostic);
  console.error('FAIL', currentStep, diagnostic.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  try { await stop(); }
  catch (error) {
    const cleanupDiagnostic = formatCandidateFailureDiagnostic(error, 'cleanup', [accessKey, vault, directory]);
    evidence.errors.push(cleanupDiagnostic);
    evidence.passed = false;
    process.exitCode = 1;
  }
  evidence.finishedAt = new Date().toISOString();
  await save();
  console.log('RESULT', JSON.stringify({ passed: evidence.passed, checks: evidence.checks, failedStep: evidence.failedStep,
    lifetimes: evidence.lifetimes, evidence: join(directory, 'result.json') }));
}

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

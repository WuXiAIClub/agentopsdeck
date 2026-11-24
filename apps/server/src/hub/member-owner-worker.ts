import { MessagePort, parentPort, workerData } from 'node:worker_threads';
import { applicationTransactionRequest, serveApplicationTransactions } from '../auth/application-transaction-gate.js';
import { createHash } from 'node:crypto';
import { HubStore } from './hub-store.js';
import { openSqliteAuth } from '../auth/sqlite-store.js';
import { createAccessKeyGuard, createAdministratorKeyGuard } from '../auth/access-key.js';
import { sqliteAuthRefusal, sqliteAuthKinds, type SqliteAuthKind } from '../auth/sqlite-owner-domain.js';
import { OriginalJsonAuthCommandStore } from '../auth/original-json-command-store.js';
import { requireOriginalAuthReady } from './legacy-auth-domain.js';
import { addSqlFailure } from '../storage/sql-failure-diagnostics.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { initializeHubMemberOwner } from './member-owner-bootstrap.js';
import { executeHubMemberCommand, hubMemberKinds, hubMemberFailureSteps, validHubMemberInput, hubMemberOwnerConfig,
  hubMemberCommandBytes, hubMemberCommandBudget, hubMemberResultBytes, hubMemberResultBudget,
  type HubMemberKind } from './member-owner-domain.js';
import { executeHubLegacyAuthCommand, type HubLegacyAuthCommand } from './legacy-auth-domain.js';
import { HubMemberOwnerScheduler } from './member-owner-scheduler.js';
import { OriginalAuthCurrentKey } from '../auth/current-key-binding.js';
import { OriginalLocalPreferences } from '../auth/local-preference-domain.js';

function observeFailure(step: number, error: unknown) {
  try {
    const trace = performanceDiagnostics.start('hub-member-sqlite-owner');
    trace.add('step', step); trace.add('unknown', 1); addSqlFailure(trace, error); trace.finish(true);
  } catch { /* Never expose credentials or replace the original result. */ }
}
/** Colocated ORIGINAL owners, never a second writer beside application.ts.
 * Original Auth remains a separate database. Only its current synchronous
 * authority is bound into Hub mutations on this one worker thread. */
async function main() {
  const port = parentPort!;
  if (!port) throw Error('hub_member_storage_unavailable');
  const { entry: _entry, loader: _loader, applicationTransactionPort, applicationTransactionLifetime, ...provided } = workerData;
  if ((applicationTransactionPort !== undefined || applicationTransactionLifetime !== undefined)
    && (!(applicationTransactionPort instanceof MessagePort) || !(applicationTransactionLifetime instanceof MessagePort))) throw Error('hub_member_storage_unavailable');
  const config = hubMemberOwnerConfig(provided);
  const digest = !config.administratorKey ? undefined
    : createHash('sha256').update(config.administratorKey).digest('hex');
  const currentKey = new OriginalAuthCurrentKey(digest?.slice(0, 24));
  let auth: ReturnType<typeof openSqliteAuth> | { passkeys: OriginalJsonAuthCommandStore;
    sessions: OriginalJsonAuthCommandStore['sessions']; close(): void } | undefined;
  let owner: HubStore | undefined;
  let preferences: OriginalLocalPreferences | undefined;
  let legacy: ((request: Request) => boolean) | undefined;
  let limiter: ReturnType<HubStore['createLoginLimiter']> | undefined;
  // Always attempt BOTH independent closes, even after the first refusal.
  // Neither an ACK nor an elapsed timer releases parent reservations: real
  // native worker exit remains the sole release point.
  const close = async () => {
    let failure = false;
    for (const store of [owner, auth]) {
      if (!store) continue;
      try { await store.close(); } catch (error) { failure = true; observeFailure(12, error); }
    }
    if (failure) throw Error('hub_member_storage_unavailable');
  };
  try {
    if (config.auth?.kind === 'json') {
      const passkeys = new OriginalJsonAuthCommandStore(config.auth.passkeysFile, config.auth.sessionsFile, digest?.slice(0, 24), {},
        () => currentKey.keyIdentityHash);
      auth = { passkeys, sessions: passkeys.sessions, close: () => passkeys.close() };
    } else if (config.auth) auth = openSqliteAuth(config.auth.file, config.auth.legacyFiles, () => currentKey.keyIdentityHash);
    legacy = auth ? createAccessKeyGuard(config.administratorKey, auth.sessions) : undefined;
    owner = new HubStore(config.file, config.encryptionSecret, config.lifecycleEndpoints, config.administratorKey, legacy, config.localMaintenanceConnectionId,
      createAdministratorKeyGuard(config.administratorKey, auth?.sessions));
    if (config.bootstrap) initializeHubMemberOwner(owner, config.bootstrap, config.administratorKey);
    if (config.bootstrap?.ownLocalPreferences) {
      if (!auth) throw Error('hub_member_storage_unavailable');
      preferences = new OriginalLocalPreferences(config.bootstrap.legacyPreferences);
    }
    limiter = config.loginLimiter ? owner.createLoginLimiter(config.loginLimiter) : undefined;
  } catch (error) { await close().catch(() => {}); throw error; }
  const hub = owner;
  let sequence = 0, accepted = 0, bytes = 0, resultBytes = 0, closing = false;
  const scheduler = new HubMemberOwnerScheduler();
  if (applicationTransactionPort) serveApplicationTransactions({ data: applicationTransactionPort, lifetime: applicationTransactionLifetime }, {
    schedule: work => scheduler.schedule('barrier', work), available: () => !closing,
    authorize(binding) {
      if (!auth || !legacy || currentKey.keyIdentityHash !== digest?.slice(0, 24)) return false;
      requireOriginalAuthReady(auth.passkeys);
      // Reconstruct the original headers, not a principal-derived credential.
      // A normal Hub member must not become the local daily administrator.
      return hub.identities.requestPrincipal(applicationTransactionRequest(binding.evidence), legacy)?.admin === true;
    },
  });
  const stop = () => { closing = true; port.close(); process.exitCode = 1; };
  port.on('message', (message: unknown) => {
    const r = message as { id?: unknown; kind?: unknown; body?: unknown } | null;
    if (closing || !r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 3
      || !Number.isSafeInteger(r.id) || Number(r.id) !== sequence + 1 || typeof r.kind !== 'string'
      || typeof r.body !== 'string') { stop(); return; }
    const id = r.id as number, kind = r.kind as HubMemberKind | 'close', body = r.body;
    const size = Buffer.byteLength(body);
    if (size > hubMemberCommandBytes(kind) || accepted >= 256
      || kind !== 'close' && bytes + size > hubMemberCommandBudget(kind)) { stop(); return; }
    let input: unknown;
    try { input = JSON.parse(body); } catch { stop(); return; }
    if (kind === 'close' ? body !== '{}' : !hubMemberKinds.includes(kind) || !validHubMemberInput(kind, input)) { stop(); return; }
    const resultSize = hubMemberResultBytes(kind, input);
    if (kind !== 'close' && resultBytes + resultSize > hubMemberResultBudget(kind)) { stop(); return; }
    sequence = id; accepted++; bytes += size; resultBytes += resultSize;
    if (kind === 'close') closing = true;
    const execute = async () => {
      let reply: { id: number; kind: string; ok: boolean; body?: string; refusal?: number; retryAfterSeconds?: number };
      try {
        let value: unknown;
        if (kind === 'close') { await close(); value = null; }
        else if (kind === 'legacyAuth') {
          if (!auth || !legacy) throw Error('hub_member_storage_unavailable');
          requireOriginalAuthReady(auth.passkeys);
          const command = input as HubLegacyAuthCommand;
          value = await executeHubLegacyAuthCommand(hub, auth.passkeys, digest, command, legacy, currentKey, preferences);
        } else value = await executeHubMemberCommand(hub, kind, input as never, limiter);
        const result = JSON.stringify(value);
        if (Buffer.byteLength(result) > resultSize) throw Error('hub_member_storage_unavailable');
        reply = { id, kind, ok: true, body: result };
      } catch (error) {
        reply = { id, kind, ok: false };
        if (kind === 'legacyAuth' && auth) {
          try {
            requireOriginalAuthReady(auth.passkeys);
            const authKind = (input as HubLegacyAuthCommand).kind;
            const refusal = sqliteAuthKinds.includes(authKind as SqliteAuthKind) ? sqliteAuthRefusal(authKind as SqliteAuthKind, error) : undefined;
            if (refusal) reply = { ...reply, ...refusal };
          } catch { /* Fenced original SQL keeps the unknown negative ACK. */ }
        }
        if (reply.refusal === undefined) observeFailure(kind === 'close' ? 12 : hubMemberFailureSteps[kind], error);
      } finally { accepted--; bytes -= size; resultBytes -= resultSize; }
      port.postMessage(reply);
      if (kind === 'close') { if (!reply.ok) process.exitCode = 1; port.close(); }
    };
    // WebAuthn yields outside SQL transactions and MUST NOT block revocation,
    // status or subsequent Hub commands. Original Hub bodies stay serialized.
    void scheduler.schedule(kind === 'close' ? 'close' : kind === 'legacyAuth'
      ? (input as HubLegacyAuthCommand).kind === 'currentKeyBinding' ? 'barrier' : 'auth' : 'hub', execute).catch(stop);
  });
  port.postMessage({ kind: 'ready', ...(config.bootstrap ? { metadata: { hubId: hub.identities.hubId } } : {}) });
}
void main().catch(error => { observeFailure(13, error); parentPort?.close(); process.exitCode = 1; });

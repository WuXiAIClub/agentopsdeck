import { MessagePort, parentPort, workerData } from 'node:worker_threads';
import { openSqliteAuth } from './sqlite-store.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { reportSqliteAuthOwnerFailure } from './sqlite-owner-diagnostics.js';
import { executeSqliteAuthCommand,
  SQLITE_AUTH_COMMAND_BYTES, SQLITE_AUTH_RESULT_BYTES } from './sqlite-owner-domain.js';
import { standaloneAuthConfig, standaloneAuthKinds, validStandaloneAuthInput, standaloneAuthRefusal,
  type StandaloneAuthKind } from './standalone-owner-domain.js';
import { OriginalJsonAuthCommandStore } from './original-json-command-store.js';
import { executeOriginalJsonAuthCommand, type OriginalJsonAuthCommand } from './original-json-command-domain.js';
import { executeOriginalJsonSqliteCommand } from './original-json-sqlite-commands.js';
import { OriginalAuthCurrentKey, type CurrentKeyBinding } from './current-key-binding.js';
import { OriginalLocalPreferences, originalStandaloneAuthorization, type LocalPreferenceInput } from './local-preference-domain.js';
import { applicationTransactionRequest, serveApplicationTransactions } from './application-transaction-gate.js';
import { originalJsonEvidenceFromRequest } from './original-json-command-domain.js';
import { sqliteAuthEvidenceFromRequest } from './sqlite-owner-domain.js';

/** One complete runtime database connection and store, not a SQL-per-call or
 * per-substore worker. Instantiate only instead of the synchronous owner.
 * SQL transaction bodies stay synchronous on this one thread. Awaited
 * WebAuthn verification is outside those transactions and must yield to
 * revocation/status. Close freezes admission and drains accepted work. */
async function main() {
  const port = parentPort!;
  const { entry: _entry, loader: _loader, applicationTransactionPort, applicationTransactionLifetime, ...raw } = workerData;
  if ((applicationTransactionPort !== undefined || applicationTransactionLifetime !== undefined)
    && (!(applicationTransactionPort instanceof MessagePort) || !(applicationTransactionLifetime instanceof MessagePort))) throw Error('auth_persistence_failed');
  const config = standaloneAuthConfig(raw);
  const currentKey = new OriginalAuthCurrentKey(config.accessKeyDigest?.slice(0, 24));
  if (!port) throw Error('auth_persistence_failed');
  const sql = config.kind === 'json' ? undefined
    : openSqliteAuth(config.file, config.legacyFiles, () => currentKey.keyIdentityHash);
  const json = config.kind === 'json'
    ? new OriginalJsonAuthCommandStore(config.passkeysFile, config.sessionsFile, config.accessKeyDigest?.slice(0, 24), {},
      () => currentKey.keyIdentityHash) : undefined;
  const assertReady = () => { if (json) json.assertReady(); else requireConnectionReady(sql!.passkeys.db); };
  const preferences = config.legacyPreferences ? new OriginalLocalPreferences(config.legacyPreferences) : undefined;
  let sequence = 0, accepted = 0, bytes = 0, closing = false;
  const running = new Set<Promise<void>>();
  let barrier = Promise.resolve();
  const stop = () => { closing = true; port.close(); process.exitCode = 1; };
  if (applicationTransactionPort) serveApplicationTransactions({ data: applicationTransactionPort, lifetime: applicationTransactionLifetime }, {
    available: () => !closing,
    schedule(execute) {
      // The original Auth lane permits concurrent cryptographic awaits. A
      // grant joins ALL accepted Auth work; later commands join this barrier
      // until the actual peer writer settles (or that original worker exits).
      const predecessors = [...running], previousBarrier = barrier;
      const work = Promise.resolve().then(async () => {
        await previousBarrier; await Promise.all(predecessors); await execute();
      });
      barrier = work; running.add(work);
      void work.then(() => running.delete(work), () => { running.delete(work); stop(); });
      return work;
    },
    authorize(binding) {
      if (currentKey.keyIdentityHash !== config.accessKeyDigest?.slice(0, 24)) return false;
      assertReady();
      const request = applicationTransactionRequest(binding.evidence);
      const proof = json ? originalJsonEvidenceFromRequest(request) : sqliteAuthEvidenceFromRequest(request);
      return originalStandaloneAuthorization(json ?? sql!.passkeys, config.accessKeyDigest, proof);
    },
  });
  port.on('message', (message: unknown) => {
    const r = message as { id?: unknown; kind?: unknown; body?: unknown } | null;
    if (closing || !r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 3
      || !Number.isSafeInteger(r.id) || Number(r.id) !== sequence + 1 || typeof r.kind !== 'string'
      || typeof r.body !== 'string') { stop(); return; }
    const id = r.id as number, kind = r.kind as StandaloneAuthKind | 'close', body = r.body;
    const size = Buffer.byteLength(body);
    if (size > SQLITE_AUTH_COMMAND_BYTES || accepted >= 256 || bytes + size > 32 * SQLITE_AUTH_COMMAND_BYTES) { stop(); return; }
    let input: unknown;
    try { input = JSON.parse(body); } catch { stop(); return; }
    if (kind === 'close' ? body !== '{}' : !standaloneAuthKinds.includes(kind) || !validStandaloneAuthInput(kind, input, json !== undefined)
      || !json && (kind === 'originalJsonSession' || kind === 'originalJsonAuthorized')) { stop(); return; }
    sequence = id; accepted++; bytes += size;
    if (kind === 'close') closing = true;
    const predecessors = kind === 'close' || kind === 'currentKeyBinding' ? [...running] : [];
    const previousBarrier = barrier;
    const work = Promise.resolve().then(async () => {
      let reply: { id: number; kind: string; ok: boolean; body?: string; refusal?: number; retryAfterSeconds?: number };
      try {
        await previousBarrier;
        if (kind === 'close' || kind === 'currentKeyBinding') await Promise.all(predecessors);
        else assertReady();
        let value: unknown;
        if (kind === 'close') value = await (json ? json.close() : sql!.close());
        else if (kind === 'currentKeyBinding') {
          assertReady();
          // Invalidate only short-lived delivery proofs, never persisted sessions.
          json?.invalidateAuthenticationDeliveries(); value = currentKey.update(input as CurrentKeyBinding);
        }
        else if (kind === 'localPreferenceSnapshot') {
          if (!preferences) throw Error('auth_persistence_failed');
          value = preferences.snapshot();
        }
        else if (kind === 'localPreference') {
          if (!preferences) throw Error('auth_persistence_failed');
          value = preferences.change(input as LocalPreferenceInput,
            proof => originalStandaloneAuthorization(json ?? sql!.passkeys, config.accessKeyDigest, proof));
        }
        else if (kind === 'originalJsonSession' || kind === 'originalJsonAuthorized') {
          value = executeOriginalJsonAuthCommand(json!, config.accessKeyDigest, { kind, input } as OriginalJsonAuthCommand).value;
        } else value = json ? await executeOriginalJsonSqliteCommand(json, config.accessKeyDigest, kind, input as never)
          : await executeSqliteAuthCommand(sql!.passkeys, config.accessKeyDigest, kind, input as never);
        const result = JSON.stringify(kind === 'close' ? null : value);
        if (Buffer.byteLength(result) > SQLITE_AUTH_RESULT_BYTES) throw Error('auth_persistence_failed');
        reply = { id, kind, ok: true, body: result };
      } catch (error) {
        reply = { id, kind, ok: false };
        // A stuck/unknown transaction must retain the generic failure. Known
        // domain refusal is safe only while this original DB is ready.
        try {
          assertReady();
          const refusal = standaloneAuthRefusal(kind, error);
          if (refusal) reply = { ...reply, ...refusal };
        } catch { /* Retain sanitized uncertain failure. */ }
        // A validated ordinary refusal has its own negative ACK and parent
        // command observation. Reserve SQL failure telemetry for actual or
        // uncertain owner faults, including refusal-like errors on fenced DBs.
        if (reply.refusal === undefined) reportSqliteAuthOwnerFailure(kind, error, undefined, notice => port.postMessage(notice));
      }
      finally { accepted--; bytes -= size; }
      port.postMessage(reply);
      if (kind === 'close') { if (!reply.ok) process.exitCode = 1; port.close(); }
    });
    if (kind === 'currentKeyBinding') barrier = work;
    running.add(work);
    void work.then(() => { running.delete(work); }, () => { running.delete(work); stop(); });
  });
  port.postMessage({ kind: 'ready' });
}
void main().catch(error => {
  reportSqliteAuthOwnerFailure('open', error, undefined, notice => parentPort?.postMessage(notice));
  parentPort?.close(); process.exitCode = 1;
});

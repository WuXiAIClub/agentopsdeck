import { MessagePort, parentPort, workerData } from 'node:worker_threads';
import { createApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from '../storage/sql-failure-diagnostics.js';
import { recoverOpenClawStartup } from '../openclaw/startup-recovery.js';
import { connectorOwnerConfig, connectorOwnerKinds, connectorOwnerSteps, createConnectorOwnerCommands,
  encodeConnectorOwnerJson, validConnectorOwnerInput, connectorOwnerResultBytes,
  CONNECTOR_PENDING_LIMIT, CONNECTOR_PENDING_INPUT_BYTES, connectorOwnerCommandBytes, connectorOwnerLargeInput, type ConnectorOwnerKind } from './connector-owner-domain.js';

/** Whole connection, original shared callbacks, EXCLUSIVE lock and migrations.
 * Recovery completes before ready. Token authority, grants, admission and
 * settlement share this owner; no second connection to live Connector state. */
async function main() {
  const port = parentPort!;
  if (!port) throw Error('connector_storage_unavailable');
  const { entry: _entry, loader: _loader, applicationTransactionPort, ...provided } = workerData;
  if (applicationTransactionPort !== undefined && !(applicationTransactionPort instanceof MessagePort)) throw Error('connector_storage_unavailable');
  const config = connectorOwnerConfig(provided);
  let tokens: ConnectorTokenStore | undefined;
  const owner = new ConnectorUserStore(config.file, (id, action) =>
    !!tokens?.hasScope(id, 'execution:delegate') && tokens.hasScope(id, 'messages:send')
      && (action !== 'messages:mirror' || tokens.hasScope(id, 'messages:mirror')), { runtimeOwner: true });
  tokens = config.tokenFile ? new ConnectorTokenStore(config.tokenFile, config.bootstrapToken) : undefined;
  if (config.mirrorOutboxFile !== undefined) owner.mirrorOutbox.importLegacy(config.mirrorOutboxFile);
  recoverOpenClawStartup(owner.turns, owner.openClawExecutions, config.openClawQueueFile);
  const execute = createConnectorOwnerCommands(owner, tokens, config.sdkModels, config.codexQueueFile, config.boardFiles, config.codexBoardTools, config.fileToolPolicies,
    applicationTransactionPort ? createApplicationTransactionClient(applicationTransactionPort) : undefined);
  let sequence = 0, accepted = 0, inputBytes = 0, largeInputBytes = 0, closing = false;
  const authorityStop = new AbortController();
  let queue = Promise.resolve();
  const stop = () => { closing = true; authorityStop.abort(); port.close(); process.exitCode = 1; };
  port.on('message', (message: unknown) => {
    const r = message as { id?: number; kind?: ConnectorOwnerKind | 'close'; body?: string } | null;
    if (closing || !r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 3
      || !Number.isSafeInteger(r.id) || r.id !== sequence + 1 || typeof r.kind !== 'string' || typeof r.body !== 'string'
      || Buffer.byteLength(r.body) > connectorOwnerCommandBytes(r.kind) || accepted >= CONNECTOR_PENDING_LIMIT
      || (connectorOwnerLargeInput(r.kind, Buffer.byteLength(r.body)) ? largeInputBytes !== 0
        : inputBytes + Buffer.byteLength(r.body) > CONNECTOR_PENDING_INPUT_BYTES)) { stop(); return; }
    const id = r.id!, kind = r.kind, body = r.body;
    let input: unknown;
    try { input = JSON.parse(body); } catch { stop(); return; }
    if (kind === 'close' ? body !== '{}' : !connectorOwnerKinds.includes(kind) || !validConnectorOwnerInput(kind, input)) { stop(); return; }
    const size = Buffer.byteLength(body);
    const large = connectorOwnerLargeInput(kind, size);
    sequence = id; accepted++; if (large) largeInputBytes += size; else inputBytes += size;
    if (kind === 'close') closing = true;
    queue = queue.then(async () => {
      let reply: { id: number; kind: string; ok: boolean; body?: string };
      try {
        const value = kind === 'close' ? (execute.dispose(), owner.close(), null) : await execute(kind, input as never);
        const result = encodeConnectorOwnerJson(value, connectorOwnerResultBytes(kind));
        reply = { id, kind, ok: true, body: result };
      } catch (error) {
        reply = { id, kind, ok: false };
        const trace = guardedTrace(performanceDiagnostics, 'connector-sqlite-command');
        trace.add('step', kind === 'close' ? 0 : connectorOwnerSteps[kind]);
        trace.add('unknown', 1); addSqlFailure(trace, error); trace.finish(true);
      } finally { accepted--; if (large) largeInputBytes -= size; else inputBytes -= size; }
      port.postMessage(reply);
      if (kind === 'close') { authorityStop.abort(); if (!reply.ok) process.exitCode = 1; port.close(); }
    }).catch(stop);
  });
  port.postMessage({ kind: 'ready' });
  // Wake hints only; each consumer must re-read current authority in a command.
  // Observe the original token signal, including transient credential disposal,
  // rather than polling or inventing a second authority cache in the parent.
  if (tokens) {
    const authority = tokens.changes;
    void (async () => {
      let revision = authority.revision;
      while (!closing) {
        await authority.wait(revision,authorityStop.signal);
        if (closing || authorityStop.signal.aborted) return;
        revision = authority.revision;
        port.postMessage({kind:'authorityChanged',revision});
      }
    })().catch(stop);
  }
}
void main().catch(error => {
  const trace = guardedTrace(performanceDiagnostics, 'connector-sqlite-owner');
  trace.add('step', 6); trace.add('unknown', 1); addSqlFailure(trace, error); trace.finish(true);
  parentPort?.close(); process.exitCode = 1;
});

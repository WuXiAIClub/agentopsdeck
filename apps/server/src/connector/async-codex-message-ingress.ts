import type { CodexAppServer } from '../codex/app-server.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncCodexMessages } from './async-codex-messages.js';
import { AsyncCodexStop } from './async-codex-stop.js';
import { codexMessageAdmission } from './connector-codex-message-domain.js';
import type { CodexMessagesHttp } from './codex-messages-http.js';
import { AsyncCodexReads, type AsyncCodexReadsOptions } from './async-codex-reads.js';

/** Ingress composition only, not the completed Codex application/root cutover.
 * Its owner is supplied by the application; it never opens a second writer. */
export function createAsyncCodexMessageIngress(options: {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  runtime: Pick<CodexAppServer, 'messageAdmissionReady' | 'messageAdmissionState' | 'publishMessageAdmission'>;
  stopRuntime?: Pick<CodexAppServer, 'stopConnectionId' | 'interruptOwned'>;
  /** Maintenance blocks fresh execution, not stopping an existing invocation. */
  stopAvailable?(): boolean;
  reads?: AsyncCodexReadsOptions;
  persist?: ConstructorParameters<typeof AsyncCodexMessages>[0]['persist'];
  prepareSession?: ConstructorParameters<typeof AsyncCodexMessages>[0]['prepareSession'];
  diagnostics?: PerformanceDiagnostics;
  timeoutMs?: number;
}) {
  let frozen = false;
  const ready = () => !frozen && options.runtime.messageAdmissionReady;
  const messages = new AsyncCodexMessages({ owner: options.owner, ready,
    sessionExists: key => { const s = options.runtime.messageAdmissionState(key); return s.ready && s.exists; },
    displayBlocked: key => options.runtime.messageAdmissionState(key).blocked,
    ...(options.prepareSession ? { prepareSession: options.prepareSession } : {}),
    admitted: (key, text, result) => {
      const body = result.receipt?.result?.body;
      if (!frozen && codexMessageAdmission(body)) options.runtime.publishMessageAdmission(key, text, body);
    },
    ...(options.persist ? { persist: options.persist } : {}), ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) });
  const stop = options.stopRuntime ? new AsyncCodexStop({ owner: options.owner, runtime: options.stopRuntime,
    available: () => !frozen && (options.stopAvailable ? options.stopAvailable() === true : ready()),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) }) : undefined;
  const reads = options.reads ? new AsyncCodexReads(options.owner,
    { ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}), ...options.reads }) : undefined;
  const codexMessages = { messages, ready, ...(stop ? { stop } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) } satisfies CodexMessagesHttp;
  return { codexMessages, ...(reads ? { codexReads: { reads } } : {}),
    // Maintenance waits already-entered admission/stop effects without closing
    // read ports or freezing subsequent safe receipt/stop requests.
    drainAdmissions() { return Promise.all([messages.drain(), stop?.drain()]).then(() => {}); },
    freeze() { frozen = true; messages.freeze(); stop?.freeze(); void reads?.close(); },
    drain() { return Promise.all([messages.drain(), stop?.drain(), reads?.close()]).then(() => {}); },
    close() { frozen = true; return Promise.all([messages.close(), stop?.close(), reads?.close()]).then(() => {}); } };
}

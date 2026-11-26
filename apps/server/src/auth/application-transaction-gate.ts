import { MessageChannel, MessagePort } from 'node:worker_threads';
import { types } from 'node:util';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Original HTTP evidence, not a principal, cached authorization or bearer
 * manufactured from a successful application-side observation. */
export type ApplicationTransactionEvidence = Readonly<{
  authorization?: string; accessKey?: string; cookie?: string;
}>;
export type ApplicationTransactionBinding = Readonly<{
  runtime: 'codex' | 'openclaw' | 'hermes' | 'claude-code' | 'ghcp' | 'antigravity'; resource: string; commandKey: string;
  payloadDigest: string; phase: 'claim' | 'queue' | 'control-claim' | 'control-ready'; evidence: ApplicationTransactionEvidence;
}>;
export type OriginalTransactionWrite = <T>(write: () => T) => Promise<T>;
export type ApplicationTransactionClient = { run<T>(binding: ApplicationTransactionBinding, write: () => T): Promise<T> };
// Match the existing application scope's aggregate original-header bound.
// JSON may escape each original byte; reserve that overhead, not less authority.
export const APPLICATION_TRANSACTION_COMMAND_OVERHEAD = 6 * 65_536 + 16 * 1024;
const unavailable = () => Error('application_transaction_unavailable');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validApplicationTransactionEvidence(v: unknown): v is ApplicationTransactionEvidence {
  return object(v) && Object.keys(v).every(k => ['authorization', 'accessKey', 'cookie'].includes(k)
    && typeof v[k] === 'string' && !/[\r\n\u0000]/.test(v[k] as string))
    && Object.values(v).reduce<number>((sum, value) => sum + Buffer.byteLength(value as string), 0) <= 65_536;
}
export function validApplicationTransactionBinding(v: unknown): v is ApplicationTransactionBinding {
  return object(v) && Object.keys(v).length === 6 && ['codex', 'openclaw', 'hermes', 'claude-code', 'ghcp', 'antigravity'].includes(String(v.runtime))
    && typeof v.resource === 'string' && v.resource.length > 0 && sessionRuntimeId(v.resource) === v.runtime
    && Buffer.byteLength(v.resource) <= (v.runtime === 'codex' || v.runtime === 'openclaw' ? 4096 : 512)
    && !/[\u0000-\u001f\u007f]/.test(v.resource)
    && typeof v.commandKey === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v.commandKey)
    && typeof v.payloadDigest === 'string' && /^[a-f0-9]{64}$/.test(v.payloadDigest)
    && ['claim', 'queue', 'control-claim', 'control-ready'].includes(String(v.phase)) && validApplicationTransactionEvidence(v.evidence);
}
export function applicationTransactionRequest(evidence: ApplicationTransactionEvidence): Request {
  if (!validApplicationTransactionEvidence(evidence)) throw unavailable();
  const headers = new Headers();
  for (const [field, name] of [['authorization', 'authorization'], ['accessKey', 'x-agentopsdeck-key'], ['cookie', 'cookie']] as const) {
    if (evidence[field] !== undefined) headers.set(name, evidence[field]);
  }
  return new Request('http://application-transaction.invalid/', { headers });
}

/** Trusted bootstrap only; ports are never part of the JSON command protocol.
 * The control sender stays with the original Connector worker owner. ONLY its
 * real `exit` event may confirm that a granted SQL writer cannot still run. */
export function createApplicationTransactionLink() {
  const data = new MessageChannel(), lifetime = new MessageChannel();
  lifetime.port1.unref();
  let exited = false, connectorStarted = false, authExited = false;
  let releaseAuth: (() => void) | undefined;
  const auth = { data: data.port1, lifetime: lifetime.port2,
    /** A dead Auth worker cannot acknowledge whether its last grant reached
     * the peer. Retain its file reservations until THAT Connector exits.
     * Transport loss, close ACKs and terminate Promises are not proof. */
    retire(release: () => void) {
      authExited = true;
      if (!connectorStarted || exited) release(); else releaseAuth = release;
    },
  };
  const confirmExit = () => {
    if (exited) return;
    exited = true;
    try { lifetime.port1.postMessage({ kind: 'peerExited' }); } catch { /* Auth may already have exited. */ }
    lifetime.port1.close();
    releaseAuth?.(); releaseAuth = undefined;
  };
  return {
    auth,
    connector: { data: data.port2, auth,
      begin() {
        if (connectorStarted || exited || authExited) throw unavailable();
        connectorStarted = true;
      },
      // Called only if native construction never returned a Worker, or by its
      // actual exit event. A never-created peer cannot own an old SQL writer.
      confirmExit,
    },
    /** Partial construction only; do not use this as transaction settlement. */
    closeUnused() { data.port1.close(); data.port2.close(); lifetime.port1.close(); lifetime.port2.close(); },
  };
}
export type ApplicationTransactionAuthEndpoint = ReturnType<typeof createApplicationTransactionLink>['auth'];
export type ApplicationTransactionConnectorEndpoint = ReturnType<typeof createApplicationTransactionLink>['connector'];

/** Auth scheduler's barrier spans ONLY the original synchronous SQL writer.
 * No native/file/network effect, capacity wait or parent HTTP waiter is held.
 * Transport loss never releases a granted barrier; settlement or actual peer
 * exit are the only evidence that its original writer has stopped. */
export function serveApplicationTransactions(endpoint: Pick<ApplicationTransactionAuthEndpoint, 'data' | 'lifetime'>, deps: {
  schedule(work: () => Promise<void>): Promise<void>;
  authorize(binding: ApplicationTransactionBinding): boolean;
  available(): boolean;
  diagnostics?: PerformanceDiagnostics;
}) {
  const { data, lifetime } = endpoint;
  let sequence = 0, failed = false, peerExited = false;
  let pending: { id: number; granted: boolean; settle(): void } | undefined;
  const stop = () => { failed = true; data.close(); /* NOT settlement. */ };
  const post = (value: unknown) => { try { data.postMessage(value); } catch { stop(); } };
  lifetime.on('message', value => {
    if (!object(value) || Object.keys(value).length !== 1 || value.kind !== 'peerExited') { stop(); return; }
    peerExited = true; pending?.settle(); data.close(); lifetime.close();
  });
  // Control-plane closure is not proof of peer SQL termination either.
  lifetime.on('messageerror', stop);
  data.on('messageerror', stop);
  data.on('close', () => { failed = true; });
  data.on('message', (value: unknown) => {
    if (!object(value)) { stop(); return; }
    if (value.kind === 'settled') {
      if (Object.keys(value).length !== 2 || !pending?.granted || value.id !== pending.id) { stop(); return; }
      const original = pending; pending = undefined; original.settle();
      post({ kind: 'settled', id: value.id }); return;
    }
    if (failed || peerExited || !deps.available() || pending || Object.keys(value).length !== 3 || value.kind !== 'acquire'
      || value.id !== sequence + 1 || !Number.isSafeInteger(value.id) || !validApplicationTransactionBinding(value.binding)) { stop(); return; }
    sequence++;
    const id = sequence, binding = value.binding;
    let settle!: () => void;
    const settlement = new Promise<void>(resolve => { settle = resolve; });
    const original = { id, granted: false, settle }; pending = original;
    void deps.schedule(async () => {
      const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'application-transaction-gate');
      trace.add('step', { claim: 1, queue: 2, 'control-claim': 3, 'control-ready': 4 }[binding.phase]);
      let allowed = false;
      const warning = setTimeout(() => trace.reportPending({ pending: 1, unknown: Number(original.granted) }), 30_000); warning.unref();
      try {
        if (!failed && !peerExited && deps.available()) allowed = deps.authorize(binding) === true;
        if (!allowed) { if (pending === original) pending = undefined; post({ kind: 'grant', id, allowed: false }); return; }
        original.granted = true;
        post({ kind: 'grant', id, allowed: true });
        // In particular, post/close errors MUST NOT skip this physical fence.
        if (!peerExited) await settlement;
        trace.add('settled', 1);
      } finally {
        clearTimeout(warning); trace.finish(!allowed || failed || peerExited);
      }
    }).catch(() => { if (!original.granted && pending === original) pending = undefined; stop(); });
  });
  data.unref(); lifetime.unref();
}

/** Worker-local client. The only code between grant and settlement is a
 * retained original synchronous writer. No deadline/retry/AbortSignal here. */
export function createApplicationTransactionClient(data: MessagePort): ApplicationTransactionClient {
  let sequence = 0, failed = false;
  let pending: { id: number; phase: 'grant' | 'settled'; resolve(value: boolean): void; reject(error: Error): void } | undefined;
  const stop = () => { failed = true; pending?.reject(unavailable()); pending = undefined; data.close(); };
  data.on('close', stop); data.on('messageerror', stop);
  data.on('message', (value: unknown) => {
    if (!object(value) || !pending || value.id !== pending.id || value.kind !== pending.phase
      || (value.kind === 'grant' ? Object.keys(value).length !== 3 || typeof value.allowed !== 'boolean' : Object.keys(value).length !== 2)) { stop(); return; }
    const original = pending; pending = undefined; original.resolve(value.kind === 'settled' || value.allowed === true);
  });
  data.unref();
  const receive = (id: number, phase: 'grant' | 'settled', value: unknown) => new Promise<boolean>((resolve, reject) => {
    pending = { id, phase, resolve, reject };
    try { data.postMessage(value); } catch { stop(); }
  });
  let busy = false;
  return Object.freeze({ async run<T>(binding: ApplicationTransactionBinding, write: () => T): Promise<T> {
    if (failed || busy || !validApplicationTransactionBinding(binding) || typeof write !== 'function') throw unavailable();
    busy = true;
    const id = ++sequence;
    try {
      if (!await receive(id, 'grant', { kind: 'acquire', id, binding })) throw unavailable();
      let result!: T, failure: unknown, threw = false;
      try {
        result = write();
        if (types.isPromise(result) || result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
          // Trusted callers use synchronous original SQL writers. An accidental
          // async writer cannot prove settlement: retain the Auth fence until
          // this original worker exits instead of falsely releasing authority.
          if (types.isPromise(result)) void Promise.prototype.then.call(result, () => {}, () => {});
          stop(); throw unavailable();
        }
      } catch (error) { failure = error; threw = true; }
      if (failed) throw unavailable();
      await receive(id, 'settled', { kind: 'settled', id });
      if (threw) throw failure;
      return result;
    } finally { busy = false; }
  } });
}

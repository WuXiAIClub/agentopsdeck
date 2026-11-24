import type { ChatMessage } from '@agentopsdeck/shared';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector-owner-domain.js';
import { OPENCLAW_MESSAGE_PAYLOAD_BYTES, type OpenClawMessageScope } from './connector-openclaw-message-domain.js';
import { validConnectorOpenClawStatusInput, validConnectorOpenClawStatusOutput,
  type ConnectorOpenClawStatusCommands, type ConnectorOpenClawStatusKind, type OpenClawStatusDisplay } from './connector-openclaw-status-domain.js';
import { runNativeOperation } from './native-operation.js';

type Wait = { timeoutMs: number; signal?: AbortSignal };
/** Physical SQL/projection work remains in drain after logical cancellation.
 * The trusted synchronous Deck upserts run immediately after current authority
 * is checked by the shared worker; no native effects or second database owner. */
export class AsyncOpenClawStatus {
  private frozen = false;
  private closing?: Promise<void>;
  private readonly tasks = new Set<Promise<unknown>>();
  private bytes = 0;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>;
    display(key: string): OpenClawStatusDisplay;
    project(messages: [ChatMessage, ChatMessage]): void;
    diagnostics?: PerformanceDiagnostics }) {}
  send(input: Omit<ConnectorOpenClawStatusCommands['openClawStatus']['input'], 'display'>, wait: Wait) {
    return runNativeOperation(() => this.sendPhysical(input), wait);
  }
  sendPhysical(input: Omit<ConnectorOpenClawStatusCommands['openClawStatus']['input'], 'display'>, authority?: ApplicationCommandScope) {
    return this.invoke('openClawStatus', input, authority);
  }
  read(input: OpenClawMessageScope, wait: Wait) { return runNativeOperation(() => this.readPhysical(input), wait); }
  readPhysical(input: OpenClawMessageScope, authority?: ApplicationCommandScope) { return this.invoke('openClawStatusRead', input, authority); }
  readForSend(input: OpenClawMessageScope, wait: Wait) { return runNativeOperation(() => this.invoke('openClawStatusSendRead', input), wait); }
  private invoke(kind: ConnectorOpenClawStatusKind, input: OpenClawMessageScope & { payloadJson?: string }, authority?: ApplicationCommandScope) {
    let snapshot: typeof input, bytes: number;
    try {
      const encoded = encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(kind));
      bytes = Buffer.byteLength(encoded); snapshot = JSON.parse(encoded) as typeof input;
      if (kind !== 'openClawStatus' && !validConnectorOpenClawStatusInput(kind, snapshot)) throw new ConnectorOwnerUnavailable();
    } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
      if (this.frozen || this.tasks.size >= 128 || this.bytes + bytes > 2 * OPENCLAW_MESSAGE_PAYLOAD_BYTES) return Promise.reject(new ConnectorOwnerUnavailable());
      this.bytes += bytes;
      const task = Promise.resolve().then(async () => {
        const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-status');
        let failed = true;
        try {
          trace.add('step', kind === 'openClawStatus' ? 1 : kind === 'openClawStatusSendRead' ? 2 : 3);
          if (kind === 'openClawStatus' && authority) { await authority.authorize('prepare'); authority.local(); }
          const request = kind === 'openClawStatus' ? { ...snapshot, display: structuredClone(this.options.display(snapshot.key)) } : snapshot;
          if (!validConnectorOpenClawStatusInput(kind, request)) throw new ConnectorOwnerUnavailable();
          const result = await this.options.owner.command(kind, request as ConnectorOpenClawStatusCommands[typeof kind]['input']);
          if (!validConnectorOpenClawStatusOutput(kind, result)) throw new ConnectorOwnerUnavailable();
          if ('error' in result) return result;
          if (result.key !== snapshot.key || result.commandKey !== snapshot.commandKey) throw new ConnectorOwnerUnavailable();
          if (kind !== 'openClawStatus' && authority) { await authority.authorize('prepare'); authority.local(); }
          // A close veto is local, not a way to rewrite the durable receipt.
          if (kind !== 'openClawStatus' && result.report && !this.frozen) this.options.project(structuredClone(result.report));
          failed = false; return result;
        } finally { trace.finish(failed); }
      });
      this.tasks.add(task);
      const release = () => { this.tasks.delete(task); this.bytes -= bytes; };
      void task.then(release, release); return task;
  }
  freeze() { this.frozen = true; }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= Promise.allSettled([...this.tasks]).then(() => {});
  }
}

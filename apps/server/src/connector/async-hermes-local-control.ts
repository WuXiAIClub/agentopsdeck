import type { ChatMessage } from '@agentopsdeck/shared';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { ConnectorOwnerUnavailable, type ConnectorOwnerCommands, type ConnectorOwnerKind } from './connector-owner-domain.js';
import type { ConnectorHermesLocalControlCommands, HermesLocalControlRequest } from './connector-hermes-local-control-domain.js';
import type { SdkStatusDisplay } from './connector-sdk-status-domain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { runNativeOperation } from './native-operation.js';

type Owner = { command<K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> };
type Scope = ConnectorHermesLocalControlCommands['hermesLocalControlRead']['input'];
type Wait = { timeoutMs: number; signal?: AbortSignal };

/** No native work. Physical owner+projection work outlives caller deadlines.
 * Current authorized report delivery and synchronous projection have no await
 * between them; retries upsert the immutable original IDs. */
export class AsyncHermesLocalControl {
  private closed = false;
  private readonly tasks = new Set<Promise<unknown>>();
  constructor(private readonly owner: Owner, private readonly display: (key: string) => SdkStatusDisplay,
    private readonly project: (messages: [ChatMessage, ChatMessage]) => void,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}

  send(input: Omit<HermesLocalControlRequest, 'display'>, wait: Wait) {
    return runNativeOperation(() => this.sendPhysical(input), wait);
  }
  sendPhysical(input: Omit<HermesLocalControlRequest, 'display'>, authority?: ApplicationCommandScope) {
    const request = structuredClone(input);
    return this.perform(async () => {
      if (authority) { await authority.authorize('prepare'); authority.local(); }
      return this.owner.command('hermesLocalControl', { ...request, display: structuredClone(this.display(request.key)) });
    }, 8);
  }
  read(input: Scope, wait: Wait) {
    return runNativeOperation(() => this.readPhysical(input), wait);
  }
  readPhysical(input: Scope, authority?: ApplicationCommandScope) {
    const request = structuredClone(input);
    return this.perform(async () => {
      const result = await this.owner.command('hermesLocalControlRead', request);
      if (authority) { await authority.authorize('prepare'); authority.local(); }
      if (!('error' in result) && result.report) this.project(structuredClone(result.report));
      return result;
    }, 9);
  }
  private perform<T>(body: () => Promise<T>, step: number): Promise<T> {
    if (this.closed || this.tasks.size >= 128) return Promise.reject(new ConnectorOwnerUnavailable());
      const trace = guardedTrace(this.diagnostics, 'hermes-message-http');
      trace.add('step', step);
      const task = Promise.resolve().then(body).then(result => {
        trace.finish(!!result && typeof result === 'object' && 'error' in result); return result;
      }, error => { trace.finish(true); throw error; });
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
      return task;
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.tasks]); }
}

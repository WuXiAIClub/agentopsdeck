import type { ChatMessage } from '@agentopsdeck/shared';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { ConnectorOwnerCommands, ConnectorOwnerKind } from './connector-owner-domain.js';
import type { ConnectorSdkStatusCommands, SdkStatusDisplay, SdkStatusRequest } from './connector-sdk-status-domain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { runNativeOperation } from './native-operation.js';

type Owner = { command<K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> };
type Scope = ConnectorSdkStatusCommands['sdkMessageStatusRead']['input'];
type Wait = { timeoutMs: number; signal?: AbortSignal };

/** Caller deadlines never cancel a committed local report. A projection error
 * is recovered by reading the original immutable report, never native replay.
 * Projection is synchronous (original DeckStore upserts), with no authority-
 * changing await between the worker's delivery check and those two writes. */
export class AsyncSdkStatus {
  constructor(private readonly owner: Owner, private readonly display: (runtime: Scope['runtime'], key: string) => SdkStatusDisplay,
    private readonly project: (messages: [ChatMessage, ChatMessage]) => void,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}

  send(input: Omit<SdkStatusRequest, 'display'>, wait: Wait) {
    return runNativeOperation(() => this.sendPhysical(input), wait);
  }
  async sendPhysical(input: Omit<SdkStatusRequest, 'display'>, authority?: ApplicationCommandScope) {
    const request = structuredClone(input);
      const trace = guardedTrace(this.diagnostics, 'sdk-message-http');
      let failed = true;
      try {
        trace.add('step', 6);
        if (authority) { await authority.authorize('prepare'); authority.local(); }
        const result = await this.owner.command('sdkMessageStatus', { ...request,
          display: structuredClone(this.display(request.runtime, request.key)) });
        failed = 'error' in result;
        return result;
      } finally { trace.finish(failed); }
  }

  read(input: Scope, wait: Wait) {
    return runNativeOperation(() => this.readPhysical(input), wait);
  }
  async readPhysical(input: Scope, authority?: ApplicationCommandScope) {
    const request = structuredClone(input);
      const trace = guardedTrace(this.diagnostics, 'sdk-message-http');
      let failed = true;
      try {
        trace.add('step', 7);
        const result = await this.owner.command('sdkMessageStatusRead', request);
        if ('error' in result) return result;
        if (authority) { await authority.authorize('prepare'); authority.local(); }
        if (result.report) this.project(structuredClone(result.report));
        failed = false;
        return result;
      } finally { trace.finish(failed); }
  }
}

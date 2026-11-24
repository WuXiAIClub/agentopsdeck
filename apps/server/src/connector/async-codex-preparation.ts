import type { CodexAppServer } from '../codex/app-server.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorCodexDispatchInput, type ConnectorCodexDispatchCommands } from './connector-codex-dispatch-domain.js';
import { requiredSynchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

export type CodexPreparationRef = ConnectorCodexDispatchCommands['codexPreparationReady']['input'];
export type CodexPreparedCompaction = { expected: CodexPreparationRef; previousRunId?: string };
export type CodexPreparationOutcome = 'ready' | 'unknown';
export type CodexRecoveryOutcome = { state: CodexPreparationOutcome; context?: string };

/** Original compaction subphase of an already claimed recovery, not a second
 * recovery planner or scheduler. The enclosing original recovery must own idle
 * history, rollback, projection and the immutable claim receipt. Never releases
 * protection or retries native mutation on an absent/failed settlement reply. */
export class AsyncCodexPreparation {
  private readonly tasks = new Set<Promise<void>>();
  private readonly keys = new Set<string>();
  private readonly attempted = new Set<string>();
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: Pick<CodexAppServer, 'compactOwnedPreparation' | 'stopConnectionId'> & Partial<Pick<CodexAppServer, 'recoverOwnedPreparation'>>;
    local(input: CodexPreparedCompaction): void;
    diagnostics?: PerformanceDiagnostics;
  }) {}

  compact(input: CodexPreparedCompaction): Promise<CodexPreparationOutcome> {
    return this.start(input, false).then(result => result.state);
  }

  recover(input: CodexPreparedCompaction, originalLocal?: () => void): Promise<CodexRecoveryOutcome> { return this.start(input, true, originalLocal); }

  private start(input: CodexPreparedCompaction, recover: boolean, originalLocal?: () => void): Promise<CodexRecoveryOutcome> {
    if (this.frozen || this.tasks.size >= 128 || this.keys.has(input.expected.sessionKey)) return Promise.resolve({ state: 'unknown' });
    const key = input.expected.sessionKey;
    this.keys.add(key);
    let snapshot: CodexPreparedCompaction, copyFailure: { error: unknown } | undefined;
    const task = Promise.resolve().then(() => {
      if (copyFailure) return { state: 'unknown' as const };
      return this.once(snapshot, recover, originalLocal);
    });
    const release = () => { this.keys.delete(key); this.tasks.delete(drain); };
    const drain = task.then(release, release);
    this.tasks.add(drain);
    try { snapshot = structuredClone(input); } catch (error) { copyFailure = { error }; }
    return task;
  }

  close(): Promise<void> {
    this.frozen = true;
    return this.closing ??= Promise.allSettled([...this.tasks]).then(() => {});
  }

  private async once(input: CodexPreparedCompaction, recover: boolean, originalLocal?: () => void): Promise<CodexRecoveryOutcome> {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-dispatch');
    const expected = input.expected;
    let failed = true, accepted = false, finishing = false;
    const local = () => {
      if (this.frozen || this.options.runtime.stopConnectionId !== expected.connectionId) throw new ConnectorOwnerUnavailable();
      requiredSynchronousEffectAuthority(() => this.options.local(structuredClone(input)));
      if (originalLocal) requiredSynchronousEffectAuthority(originalLocal);
    };
    try {
      if (!validConnectorCodexDispatchInput('codexPreparationReady', expected)
        || input.previousRunId !== undefined && (typeof input.previousRunId !== 'string' || !input.previousRunId
          || Buffer.byteLength(input.previousRunId) > 512 || /[\x00-\x1f\x7f]/.test(input.previousRunId)))
        throw new ConnectorOwnerUnavailable();
      const identity = JSON.stringify([expected.sessionKey, expected.commandId, expected.connectionId, expected.revision]);
      if (this.attempted.has(identity) || this.attempted.size >= 4096) throw new ConnectorOwnerUnavailable();
      this.attempted.add(identity); accepted = true;
      local(); trace.add('step', 10); trace.reportPending({ step: 10, pending: 1 });
      const nativeInput = { sessionKey: expected.sessionKey, commandId: expected.commandId,
        connectionId: expected.connectionId, revision: expected.revision,
        ...(input.previousRunId === undefined ? {} : { previousRunId: input.previousRunId }) };
      const port = {
        authorize: async () => {
          local();
          if (await this.options.owner.command('codexPreparationReady', expected) !== true) throw new ConnectorOwnerUnavailable();
          local(); trace.add('step', 11);
        },
        local,
        dispatched: () => { local(); trace.add('step', 12); },
      };
      let context: string | undefined;
      if (recover) {
        if (!this.options.runtime.recoverOwnedPreparation) throw new ConnectorOwnerUnavailable();
        const result = await this.options.runtime.recoverOwnedPreparation(nativeInput, port);
        if (!result || !['recovered', 'not_needed'].includes(result.state)
          || result.context !== undefined && (typeof result.context !== 'string' || result.context.length > 2000))
          throw new ConnectorOwnerUnavailable();
        context = result.context;
      } else await this.options.runtime.compactOwnedPreparation(nativeInput, port);
      // Connection/close can veto subsequent preparation, but may never release
      // or replay the original mutation. A lost finish reply remains unknown.
      local(); trace.add('step', 13);
      finishing = true;
      if (await this.options.owner.command('codexPreparationFinish', expected) !== true) throw new ConnectorOwnerUnavailable();
      failed = false; trace.add('settled', 1); return { state: 'ready', ...(context === undefined ? {} : { context }) };
    } catch {
      if (accepted && !finishing) {
        try {
          await this.options.owner.command('codexDispatchFailure', { sessionKey: expected.sessionKey, commandId: expected.commandId,
            proof: expected.proof, expected: { commandId: expected.commandId, connectionId: expected.connectionId,
              revision: expected.revision }, failure: 'unknown' });
        } catch { /* No absent reply can authorize replay or release. */ }
      }
      trace.add('unknown', 1); return { state: 'unknown' };
    }
    finally { trace.finish(failed); }
  }
}

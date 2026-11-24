import type { CodexAppServer } from '../codex/app-server.js';
import { CodexRpcError } from '../codex/rpc-error.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorCodexDispatchInput, validConnectorCodexDispatchOutput,
  connectorCodexDispatchReplyMatches,
  type ConnectorCodexDispatchCommands } from './connector-codex-dispatch-domain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { requiredSynchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import type { AsyncCodexTools } from './async-codex-tools.js';
import type { AsyncCodexInteractions } from './async-codex-interactions.js';
import { validNativeResumeReceipt, type NativeResumeReceipt } from '../codex/native-resume.js';

type Claim = ConnectorCodexDispatchCommands['codexDispatchClaim']['input'];
type Claimed = NonNullable<ConnectorCodexDispatchCommands['codexDispatchClaim']['output']>;
export type PreparedCodexDispatch = { claim: Claim; input: unknown[]; interactive: boolean };
export type CodexDispatchOutcome = 'not_started' | 'admitted' | 'unknown';

/** Internal prepared-turn consumer, not a new queue scheduler or HTTP API.
 * Native preparation and tool/interaction ownership must already be established
 * by the original executor. Never opens a DB, reconnects, retries or falls back.
 * Composition drains this port before closing executor/worker ownership. */
export class AsyncCodexDispatch {
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly keys = new Set<string>();
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: Pick<CodexAppServer, 'startOwnedTurn' | 'stopConnectionId'>;
    /** Synchronous original local preparation/identity veto, never SQL authority. */
    local(input: PreparedCodexDispatch): void;
    tools?: Pick<AsyncCodexTools, 'prepare'>;
    interactions?: Pick<AsyncCodexInteractions, 'prepare'>;
    settled?(input: PreparedCodexDispatch, runId: string): void | Promise<void>;
    diagnostics?: PerformanceDiagnostics;
  }) {}

  dispatch(input: PreparedCodexDispatch, originalLocal?: () => void, beforeEffect?: () => void): Promise<CodexDispatchOutcome> {
    if (this.frozen || this.tasks.size >= 128 || this.keys.has(input.claim.sessionKey)) return Promise.resolve('not_started');
    const key = input.claim.sessionKey;
    this.keys.add(key);
    // Reserve before cloning/callbacks so a reentrant close cannot miss work.
    let snapshot: PreparedCodexDispatch, copyFailure: { error: unknown } | undefined;
    const task = Promise.resolve().then(() => {
      if (copyFailure) throw copyFailure.error;
      return this.once(snapshot, originalLocal, beforeEffect);
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

  private async once(input: PreparedCodexDispatch, originalLocal?: () => void, beforeEffect?: () => void): Promise<CodexDispatchOutcome> {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-dispatch');
    let claimed: Claimed | undefined, claimRequested = false, acknowledged = false, entered = false, failed = true;
    const request = input.claim;
    const local = () => {
      if (this.frozen || this.options.runtime.stopConnectionId !== request.connectionId) throw new ConnectorOwnerUnavailable();
      // Give observers a copy, never the original proof/body held across await.
      requiredSynchronousEffectAuthority(() => this.options.local(structuredClone(input)));
      if (originalLocal) requiredSynchronousEffectAuthority(originalLocal);
    };
    try {
      if (!validConnectorCodexDispatchInput('codexDispatchClaim', request) || request.preparing
        || !Array.isArray(input.input) || typeof input.interactive !== 'boolean') throw new ConnectorOwnerUnavailable();
      local(); trace.add('step', 1);
      trace.reportPending({ step: 1, pending: 1 });
      // A missing IPC reply is not proof that the transaction never committed.
      // Retain unknown even when we cannot safely construct a settlement CAS.
      claimRequested = true;
      const receipt = await this.options.owner.command('codexDispatchClaim', request);
      if (!validConnectorCodexDispatchOutput('codexDispatchClaim', receipt)) throw new ConnectorOwnerUnavailable();
      if (!receipt) { failed = false; return 'not_started'; }
      if (!connectorCodexDispatchReplyMatches(request, receipt)) throw new ConnectorOwnerUnavailable();
      claimed = receipt; local(); trace.add('step', 2);
      await this.options.tools?.prepare({ sessionKey: request.sessionKey, commandId: request.commandId,
        connectionId: request.connectionId, proof: claimed.proof });
      const interactive = this.options.interactions ? await this.options.interactions.prepare({ sessionKey: request.sessionKey,
        commandId: request.commandId, connectionId: request.connectionId, proof: claimed.proof }) : input.interactive;
      local();
      const runId = await this.options.runtime.startOwnedTurn({ sessionKey: request.sessionKey, commandId: request.commandId,
        connectionId: request.connectionId, input: input.input, interactive,
        ...(claimed.completionOwnerId ? { completionOwnerId: claimed.completionOwnerId } : {}) }, {
        authorize: async () => {
          local();
          if (await this.options.owner.command('codexDispatchReady', { sessionKey: request.sessionKey, commandId: request.commandId,
            connectionId: request.connectionId, proof: claimed!.proof }) !== true) throw new ConnectorOwnerUnavailable();
          local(); trace.add('step', 3);
        },
        local,
        load: {
          begin: async (fingerprint: string) => {
            local();
            const receipt = await this.options.owner.command('codexOwnedLoadBegin', { sessionKey: request.sessionKey,
              commandId: request.commandId, connectionId: request.connectionId, revision: claimed!.execution.revision,
              proof: claimed!.proof, fingerprint });
            if (!validNativeResumeReceipt(receipt) || receipt.sessionKey !== request.sessionKey
              || receipt.nativeConnectionId !== request.connectionId) throw new ConnectorOwnerUnavailable();
            local(); return receipt;
          },
          acknowledge: async (receipt: NativeResumeReceipt) => {
            // Original ACK must survive a concurrent close/revocation.
            if (await this.options.owner.command('codexOwnedLoadAcknowledge', receipt) !== true) throw new ConnectorOwnerUnavailable();
          },
          finish: async (receipt: NativeResumeReceipt) => {
            local();
            if (await this.options.owner.command('codexOwnedLoadFinish', receipt) !== true) throw new ConnectorOwnerUnavailable();
            local();
          },
        },
        ...(beforeEffect === undefined ? {} : { beforeEffect }),
        dispatched: () => { local(); entered = true; trace.add('step', 4); },
      });
      // From this point on, no local recheck and no failure settlement may
      // erase an observed ACK, even if the worker settlement reply is lost.
      acknowledged = true; trace.add('step', 5);
      if (await this.options.owner.command('codexExecutionAcknowledge', { sessionKey: request.sessionKey,
        commandId: request.commandId, connectionId: request.connectionId, runId }) !== true) throw new ConnectorOwnerUnavailable();
      trace.add('settled', 1); failed = false;
      try { await this.options.settled?.(structuredClone(input), runId); }
      catch { trace.add('deferred', 1); /* Display failure cannot revoke the ACK. */ }
      return 'admitted';
    } catch (error) {
      trace.add('dispatchFailureStage', acknowledged ? 5 : entered ? 4 : claimed ? 3 : claimRequested ? 2 : 1);
      trace.add('nativeRpcRejection', Number(error instanceof CodexRpcError));
      if (error instanceof CodexRpcError) trace.add('nativeRpcErrorClass', error.diagnosticCode);
      if (claimed && !acknowledged) {
        try {
          // Only original proof/revision may settle. No retry after a missing
          // worker reply and no new command allowed to release this protection.
          await this.options.owner.command('codexDispatchFailure', { sessionKey: request.sessionKey, commandId: request.commandId,
            proof: claimed.proof, expected: { commandId: claimed.execution.commandId,
              connectionId: claimed.execution.connectionId, revision: claimed.execution.revision }, failure: 'unknown' });
        } catch { trace.add('unknown', 1); }
      }
      trace.add('unknown', Number(claimRequested || entered || acknowledged));
      return claimRequested || entered || acknowledged ? 'unknown' : 'not_started';
    } finally { trace.finish(failed); }
  }
}

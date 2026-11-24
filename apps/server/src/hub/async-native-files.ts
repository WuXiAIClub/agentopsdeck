import { workspaceFileCardContent, parseWorkspaceFileCardResource, type BoardWrite, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import type { NotebookMove } from './notebook-operations.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { FILE_BOARD_RUNTIMES, fileBoardRuntime } from '../connector/workspace-board-file-policy.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import { HubMemberRequestError } from './async-member-request.js';
import { nativeNotebookMutation, type NativeNotebookAutosave } from './native-notebook-autosave.js';
import { HubRequestWork } from './async-request-work.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { originalRequestScope } from './original-request-scope.js';
import { notebookMachineExpectation, validHubNotebookMachineCommand, validHubNotebookMachineReply, HUB_NOTEBOOK_MACHINE_BYTES,
  type HubNotebookMachineCommand, type NotebookMachineContext } from './member-notebook-machine-domain.js';
import type { ConnectorClient } from './connector-client.js';
import { hubNotebookReplyExpectation, validHubNotebookReply } from './member-notebook-domain.js';
import { HUB_NATIVE_FILE_BYTES, nativeFileExpectation, validHubNativeFileCommand, validHubNativeFileReply,
  type HubNativeFileCommand, type HubNativeFileResult, type NativeFileRequest, type NativeFileScope,
  type NativeFileTarget, type NativeFileWrite } from './member-native-file-domain.js';

type Result = Exclude<HubNativeFileResult, null | {error: number}>;
type Binding = NonNullable<Result['binding']>;
type ReceiptState = 'saved' | 'conflict' | 'uncertain';
const fail = (status: ConstructorParameters<typeof HubMemberRequestError>[0]): never => { throw new HubMemberRequestError(status); };
const body = (domain: NativeFileScope['domain'], value: NativeFileWrite) => domain === 'board'
  ? {title: (value as BoardWrite).title, tasks: (value as BoardWrite).tasks}
  : workspaceFileCardContent(value as WorkspaceFileCardWrite);
const state = (v: unknown): v is ReceiptState => v === 'saved' || v === 'conflict' || v === 'uncertain';

/** Request evidence -> original owner admission -> original Connector effect ->
 * original owner settlement. No synchronous store, SQL, replay or new receipt
 * ledger. Binding HTTP and background callers use this port; native editor
 * saves migrate as complete transaction variants before old services retire.
 * Request cancellation suppresses delivery, NOT an admitted operation's ACK. */
export class AsyncHubNativeFiles {
  private readonly persistence: AuthRoutePersistence;
  private readonly work = new HubRequestWork();
  private readonly controller = new AbortController();
  private readonly pending = new Set<string>();
  private closing?: Promise<void>;
  constructor(private readonly owner: Pick<AsyncHubMemberOwner, 'command'>,
    private readonly resolve: AsyncConnectorClientResolver,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.persistence = new AuthRoutePersistence(diagnostics);
  }
  get active() { return this.work.pending; }
  private copy(command: HubNativeFileCommand): HubNativeFileCommand {
    try {
      const copy: unknown = JSON.parse(encodeHubMemberJson(command, HUB_NATIVE_FILE_BYTES));
      if (validHubNativeFileCommand(copy)) return copy;
    } catch { /* Reject before any admission; never stringify caller accessors. */ }
    return fail(400);
  }
  async begin(request: Request, scope: NativeFileScope) {
    const base = this.copy({...scope, action: 'current'});
    scope = {domain: base.domain, resourceId: base.resourceId, ...(base.sessionProof ? {sessionProof: base.sessionProof} : {})};
    const evidence = Object.freeze(hubMemberEvidence(request));
    const originalScope = originalRequestScope(request);
    const expectedHeader = request.headers.get('x-agentopsdeck-recovery-scope');
    // Browser signal is not attached to admitted network/settlement work.
    // ConnectorClient still rechecks the pinned original request evidence.
    const transport = new Request(request.url, {headers: new Headers(request.headers), signal: this.controller.signal});
    const current = () => { if (request.signal.aborted) fail(499); };
    const snapshot = await this.work.run(async () => {
      current();
      const result = (await this.persistence.run(6, () => this.owner.command('memberSnapshot', evidence))).value;
      current();
      if (!result) return fail(401);
      if (originalScope !== undefined && originalScope !== result.recoveryScope) return fail(401);
      if (expectedHeader !== null && expectedHeader !== result.recoveryScope) return fail(409);
      return result;
    });
    const proof = {evidence, expectedScope: snapshot.recoveryScope};
    transport.headers.set('x-agentopsdeck-recovery-scope', proof.expectedScope);
    const command = async (input: HubNativeFileCommand): Promise<Result> => {
      const copied = this.copy(input);
      let value: HubNativeFileResult;
      try {
        value = (await this.persistence.run(103, () => this.owner.command('nativeFile', {...proof, command: copied}))).value;
      } catch {
        // A transport failure may follow the original COMMIT. Surface a
        // recoverable unavailable result; never repeat admission or dispatch.
        return fail(503);
      }
      if (!validHubNativeFileReply(nativeFileExpectation(copied), value)) return fail(503);
      if (!value) return fail(403);
      if ('error' in value) return fail(value.error);
      return value;
    };
    const run = <T>(action: () => Promise<T>) => this.work.run(async () => {
      current();
      const value = await action();
      // Settlement is already owned and finished before delivery is checked.
      current();
      const now = (await this.persistence.run(6, () => this.owner.command('memberSnapshot', evidence))).value;
      current();
      if (!now || now.recoveryScope !== proof.expectedScope || now.principal.userId !== snapshot.principal.userId) return fail(403);
      if (scope.sessionProof) {
        const original = {action: 'checkSession' as const, ...scope.sessionProof};
        const checked = (await this.persistence.run(71, () => this.owner.command('personalNotebook', {...proof, command: original}))).value;
        if (!validHubNotebookReply(hubNotebookReplyExpectation(original), checked)) return fail(503);
        if (!checked) return fail(401);
        if (checked.action !== 'checkSession' || !checked.current) return fail(403);
      }
      return value;
    });
    return this.executor(scope, proof.expectedScope, current, command, run, pin => this.resolve(transport, pin.connectionId, {
      boardBindingsOnly: scope.domain === 'board' ? 'file-boards' : 'card-files', expectedUserId: snapshot.principal.userId,
    }), {transport, userId: snapshot.principal.userId});
  }
  private async machineCommand(input: HubNotebookMachineCommand) {
    let copied: HubNotebookMachineCommand;
    try {
      copied = JSON.parse(encodeHubMemberJson(input, HUB_NOTEBOOK_MACHINE_BYTES));
      if (!validHubNotebookMachineCommand(copied)) return fail(400);
    }
    catch { return fail(400); }
    const expectation = notebookMachineExpectation(copied);
    let value;
    try { value = (await this.persistence.run(108, () => this.owner.command('notebookMachine', copied))).value; }
    catch { return fail(503); }
    if (!validHubNotebookMachineReply(expectation, value)) return fail(503);
    return value;
  }
  /** Separate original machine proof, restricted to the original bound move.
   * No cookie, caller owner ID or synthetic human principal is introduced. */
  beginNotebookMachine(request: Request, token: string) {
    return this.work.run(async () => {
      const current = () => { if (request.signal.aborted) fail(499); };
      current();
      const selected = await this.machineCommand({action: 'context', token});
      current();
      if (!selected) return fail(403);
      if (selected.action !== 'context') return fail(503);
      if (!selected.context) return undefined;
      const context: NotebookMachineContext = selected.context;
      const command = async (requestId: string, input: HubNativeFileCommand): Promise<Result> => {
        const copied = this.copy(input);
        const v = await this.machineCommand({action: 'native', token, requestId, command: copied});
        if (!v) return fail(403);
        if (v.action !== 'native' || !validHubNativeFileReply(nativeFileExpectation(copied), v.result)) return fail(503);
        if (!v.result) return fail(403);
        if ('error' in v.result) return fail(v.result.error);
        return v.result;
      };
      const check = async () => {
        const v = await this.machineCommand({action: 'context', token});
        if (!v || v.action !== 'context' || !v.context || Object.entries(context).some(([k, value]) => v.context![k as keyof NotebookMachineContext] !== value)) return fail(403);
      };
      const run = <T>(action: () => Promise<T>) => this.work.run(async () => {
        current(); const value = await action(); current(); await check(); current(); return value;
      });
      const access = {command: (input: HubNotebookMachineCommand) => this.machineCommand(input)};
      // Do not expose ordinary save, binding installation or deletion methods.
      return {move: (id: string, input: NotebookMove | null, enabled = true) => {
        const native = this.executor({domain: 'card', resourceId: context.fileResource}, context.capabilityId, current,
          value => command(id, value), run,
          () => this.resolve.notebookMachine ? this.resolve.notebookMachine(access, token, context) : fail(503));
        return native.moveNotebook(context.resourceId, id, input, enabled);
      }};
    });
  }
  private executor(scope: NativeFileScope, recoveryScope: string, current: () => void,
    command: (input: HubNativeFileCommand) => Promise<Result>, run: <T>(action: () => Promise<T>) => Promise<T>,
    resolve: (pin: NativeFileTarget) => Promise<ConnectorClient>, human?: {transport: Request; userId: string}) {
    const get = async (bindingId: string) => {
      const result = await command({...scope, action: 'get', bindingId});
      return result.binding ?? fail(404);
    };
    const target = async (binding: Binding) => {
      const result = await command({...scope, action: 'target', sessionId: binding.sessionId}), pin = result.target;
      if (!pin || pin.connectionId !== binding.connectionId || pin.authority !== binding.authority) return fail(403);
      return pin;
    };
    const path = (id?: string) => (scope.domain === 'board' ? '/workspace/board-files' : '/workspace/card-files')
      + (id === undefined ? '' : '/' + encodeURIComponent(id));
    const effect = async <T>(pin: NativeFileTarget, step: number, url: string, init: RequestInit = {}) => {
      this.controller.signal.throwIfAborted();
      const client = await resolve(pin);
      // Resolve/network may await: check original node/authority again immediately
      // before dispatch. A new node must not receive an old binding's effects.
      const now = await command({...scope, action: 'target', sessionId: pin.sessionId});
      if (!now.target || now.target.nodeId !== pin.nodeId || now.target.authority !== pin.authority
        || now.target.connectionId !== pin.connectionId) return fail(403);
      this.controller.signal.throwIfAborted();
      let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
      try { trace = this.diagnostics.start('hub-native-file-effect'); trace.add('step', step); } catch { /* Observation only. */ }
      try {
        const value = await client.json<T>(url, {...init, signal: this.controller.signal});
        try { trace?.finish(false); } catch { /* Observation only. */ }
        return value;
      } catch (error) {
        try { trace?.finish(true); } catch { /* Observation only. */ }
        throw error;
      }
    };
    const confirm = async (bindingId: string, pin: NativeFileTarget, remote: unknown) => {
      if (!remote || typeof remote !== 'object' || !('binding' in remote)) return;
      const row = remote.binding;
      if (!row || typeof row !== 'object' || !('id' in row) || row.id !== bindingId
        || !('sessionKey' in row) || row.sessionKey !== pin.sessionKey || !('state' in row)
        || row.state !== 'installed' && row.state !== 'revoked') return;
      await command({...scope, action: 'installation-settle', bindingId, target: pin, state: row.state});
    };
    const inspect = async (bindingId: string) => {
      const binding = await get(bindingId);
      if (binding.state === 'revoked') return binding;
      const pin = await target(binding);
      await confirm(bindingId, pin, await effect(pin, 3, path(bindingId)));
      return get(bindingId);
    };
    const refresh = async (bindingId: string) => {
      const binding = await get(bindingId);
      if (binding.state !== 'active') return fail(409);
      const pin = await target(binding);
      const remote = await effect<{snapshot?: Extract<HubNativeFileCommand, {action: 'refresh-apply'}>['snapshot']}>(pin, 4, path(bindingId) + '/snapshot');
      if (!remote?.snapshot) return fail(503);
      const result = await command({...scope, action: 'refresh-apply', bindingId, target: pin, baseline: binding.sourceHash, snapshot: remote.snapshot});
      // Null means a newer stream projection won; do not rebase that projection.
      if (result.applied !== null && result.applied !== 'updated' && result.applied !== 'unchanged') return fail(503);
    };
    const writable = async () => {
      const binding = (await command({...scope, action: 'current'})).binding;
      if (binding?.state !== 'active') return false;
      const pin = await target(binding), capability = await effect<{writeProtocol?: number}>(pin, 5, path());
      await target(binding);
      if (capability?.writeProtocol !== 1) return false;
      if (!binding.sourceHash) await refresh(binding.bindingId);
      const now = await get(binding.bindingId);
      return now.state === 'active' && !!now.sourceHash && !now.problem;
    };
    const inspectWrite = async (bindingId: string, mutationId: string) => {
      let result = await command({...scope, action: 'write-read', bindingId, mutationId});
      if (result.receipt?.state === 'uncertain' && result.target) {
        const pin = result.target, expectedHash = result.receipt.expectedHash;
        try {
          const remote = await effect<{receipt?: {mutationId?: string; state?: unknown}}>(pin, 6, path(bindingId) + '/writes/' + encodeURIComponent(mutationId));
          if (remote?.receipt?.mutationId === mutationId && state(remote.receipt.state))
            await command({...scope, action: 'write-settle', bindingId, target: pin, mutationId, expectedHash, state: remote.receipt.state, snapshot: null});
        } catch { /* Unknown is durable and inspectable. Never POST again. */ }
        result = await command({...scope, action: 'write-read', bindingId, mutationId});
      }
      if (!result.receipt) return fail(404);
      if (result.receipt.state === 'saved' && result.binding?.state === 'active') await refresh(bindingId);
      return {mutationId, state: result.receipt.state};
    };
    const bind = (input: {requestId: string; sessionId: string; revision: number}) => {
      const plan = this.copy({...scope, action: 'bind-plan', bindingId: input.requestId, sessionId: input.sessionId, revision: input.revision});
      if (plan.action !== 'bind-plan') return fail(400);
      const bindingId = plan.bindingId, revision = plan.revision;
      return run(async () => {
        const key = JSON.stringify([recoveryScope, scope.domain, scope.resourceId]);
        if (this.pending.has(key)) return fail(409);
        if (this.pending.size >= 16) return fail(429);
        this.pending.add(key);
        try {
          const planned = await command(plan);
          if (planned.binding) return planned.binding; // Original durable receipt; no repeat PUT.
          const pin = planned.target;
          if (!pin) return fail(403);
          const capability = await effect<{protocol?: number; mode?: string; runtimeProtocol?: unknown; runtimes?: unknown; notebookArchiveProtocol?: number}>(pin, 1, path());
          const runtime = fileBoardRuntime(pin.sessionKey);
          if (capability?.protocol !== 1 || capability.mode !== (scope.domain === 'board' ? 'whole-board-file' : 'workspace-card-file') || !runtime) return fail(409);
          if (scope.domain === 'card' && parseWorkspaceFileCardResource(scope.resourceId)?.kind === 'notebook' && capability.notebookArchiveProtocol !== 1) return fail(409);
          if ('runtimeProtocol' in capability || 'runtimes' in capability) {
            if (capability.runtimeProtocol !== 1 || !Array.isArray(capability.runtimes) || capability.runtimes.length > FILE_BOARD_RUNTIMES.length
              || new Set(capability.runtimes).size !== capability.runtimes.length
              || !capability.runtimes.every(value => FILE_BOARD_RUNTIMES.includes(value)) || !capability.runtimes.includes(runtime)) return fail(409);
          }
          current(); this.controller.signal.throwIfAborted();
          const admitted = await command({...scope, action: 'bind-admit', bindingId, revision, target: pin});
          if (admitted.fresh && admitted.document) {
            try {
              const remote = await effect<unknown>(pin, 2, path(bindingId), {method: 'PUT', body: JSON.stringify({sessionKey: pin.sessionKey, content: body(scope.domain, admitted.document)})});
              await confirm(bindingId, pin, remote);
            } catch { /* Original prepared intent remains unknown, not not-admitted. */ }
          }
          return get(bindingId);
        } finally { this.pending.delete(key); }
      });
    };
    const write = (bindingId: string, requestInput: NativeFileRequest) => {
      const plan = this.copy({...scope, action: 'write-plan', bindingId, request: requestInput});
      if (plan.action !== 'write-plan') return fail(400);
      // Own the nested document before capability/preflight awaits.
      const request = plan.request, mutationId = nativeFileExpectation(plan).mutationId!;
      return run(async () => {
        const planned = await command(plan);
        if (planned.receipt) return inspectWrite(bindingId, mutationId);
        const pin = planned.target;
        if (!pin) return fail(403);
        if (request.mode === 'archive') {
          const capability = await effect<{notebookArchiveProtocol?: number}>(pin, 5, path());
          if (capability?.notebookArchiveProtocol !== 1) return fail(409);
        }
        if (!await writable()) return fail(409);
        current(); this.controller.signal.throwIfAborted();
        const admitted = await command({...scope, action: 'write-admit', bindingId, target: pin, request});
        if (!admitted.fresh) return inspectWrite(bindingId, mutationId);
        if (!admitted.document || !admitted.receipt) return fail(503);
        try {
          const remote = await effect<{receipt?: {mutationId?: string; state?: unknown; snapshot?: Extract<HubNativeFileCommand, {action: 'refresh-apply'}>['snapshot']}}>(pin, 7, path(bindingId) + '/writes', {
            method: 'POST', body: JSON.stringify({mutationId, expectedHash: admitted.receipt.expectedHash, content: body(scope.domain, admitted.document)}),
          });
          if (remote?.receipt?.mutationId === mutationId && state(remote.receipt.state))
            await command({...scope, action: 'write-settle', bindingId, target: pin, mutationId, expectedHash: admitted.receipt.expectedHash,
              state: remote.receipt.state, snapshot: remote.receipt.snapshot ?? null});
        } catch { /* No replay, including lost ACK after original COMMIT. */ }
        const result = await command({...scope, action: 'write-read', bindingId, mutationId});
        if (!result.receipt) return fail(403);
        if (request.mode === 'archive' && result.receipt.state === 'saved') await refresh(bindingId);
        return {mutationId, state: result.receipt.state};
      });
    };
    const includeArchive = (bindingId: string, mutationId: string, revision: number) => run(async () => {
      const original = await command({...scope, action: 'archive-status', bindingId, mutationId});
      // Recovery precedes capability checks, including a later Connector
      // downgrade. Once admitted, this UUID is GET-only forever.
      if (original.receipt) return {receipt: await inspectWrite(bindingId, mutationId)};
      try {
        return {receipt: await write(bindingId, {mode: 'archive', mutationId, revision})};
      } catch (error) {
        if (!(error instanceof HubMemberRequestError) || error.status !== 409 && error.status !== 404) throw error;
        // Only a fresh original-store read AFTER a known rejection proves that
        // no intent exists. Lost SQL ACKs/close/cancellation/503 never enter
        // this branch, and no admission or write follows a negative proof.
        const confirmed = await command({...scope, action: 'archive-status', bindingId, mutationId});
        return confirmed.receipt ? {receipt: await inspectWrite(bindingId, mutationId)} : {notAdmitted: true as const};
      }
    });
    const saveEditor = (input: WorkspaceFileCardWrite, enabled = true, expectedBinding?: string) => {
      const selection = this.copy({...scope, action: 'editor-select', input});
      return run(async () => {
        const selected = await command(selection);
        const binding = selected.binding;
        if (expectedBinding !== undefined && expectedBinding !== (binding?.bindingId ?? 'none')) return fail(409);
        if (!binding) return false;
        if (!enabled) return fail(503); // Never save a private copy for an unavailable bound destination.
        if (!selected.document) return fail(503);
        // The original transaction chooses the exact destination (including
        // task/status aliases). All later awaits use that binding, never a
        // newly selected current binding. The private alternative is not retried.
        if (!human) return fail(403);
        const exact = await this.begin(human.transport, {domain: 'card', resourceId: binding.resourceId,
          ...(scope.sessionProof ? {sessionProof: scope.sessionProof} : {})});
        const receipt = await exact.write(binding.bindingId, {mode: 'ordinary', input: selected.document});
        if (receipt.state !== 'saved') return fail(receipt.state === 'conflict' ? 409 : 503);
        await exact.refresh(binding.bindingId);
        return true;
      });
    };
    const saveNotebook = (document: NativeNotebookAutosave['document'], area: NativeNotebookAutosave['area'], styled: boolean, enabled = true) => {
      // Own the exact legacy request (including its key ordering) before the
      // first await. Never hash or read a mutable caller body after selection.
      const owned = this.copy({...scope, action: 'notebook-plan', bindingId: '00000000-0000-4000-8000-000000000000',
        request: {mode: 'autosave', document, area, styled, mutationId: '00000000-0000-4000-8000-000000000000'}});
      if (owned.action !== 'notebook-plan') return fail(400);
      return run(async () => {
        const selected = await command({...scope, action: 'current'});
        if (!selected.binding) return undefined;
        const bindingId = selected.binding.bindingId;
        const request: NativeNotebookAutosave = {...owned.request,
          mutationId: nativeNotebookMutation(human?.userId ?? fail(403), bindingId, owned.request.document, owned.request.area)};
        const plan = await command({...scope, action: 'notebook-plan', bindingId, request});
        // Explicit original geometry-only/private-cold branch. This is not
        // reachable from a failed admission, lost ACK or network error.
        if (!plan.document && !plan.receipt) return undefined;
        if (!enabled) return fail(503);
        const receipt = await write(bindingId, request);
        if (receipt.state !== 'saved') return fail(receipt.state === 'conflict' ? 409 : 503);
        await refresh(bindingId);
        const finished = await command({...scope, action: 'notebook-finish', bindingId, request});
        return finished.note ?? fail(503);
      });
    };
    const moveNotebook = (notebookResource: string, requestId: string, input: NotebookMove | null = null, enabled = true) => {
      const selection = this.copy({...scope, action: 'move-select', notebookResource, requestId, input});
      if (selection.action !== 'move-select') return fail(400);
      return run(async () => {
        const selected = await command(selection);
        if (selected.moveState === 'saved') return selected.move ?? fail(503);
        if (!selected.binding) return undefined; // Explicit local/not-found branch only.
        if (!enabled) return fail(503);
        const bindingId = selected.binding.bindingId;
        const receipt = selected.moveState === 'pending' ? await inspectWrite(bindingId, requestId)
          : selection.input ? await write(bindingId, {mode: 'move', notebookResource, input: selection.input}) : fail(503);
        if (receipt.state === 'saved') await refresh(bindingId);
        const finished = await command({...scope, action: 'move-finish', bindingId, notebookResource, requestId});
        if (finished.moveState === 'conflict') return fail(409);
        return finished.move ?? fail(503);
      });
    };
    const release = (bindingId: string, action: 'cancel' | 'revoke') => run(async () => {
      const result = await command({...scope, action, bindingId}); // Local release BEFORE remote cleanup.
      let cleanup: 'confirmed' | 'pending' = result.binding ? 'pending' : 'confirmed';
      if (result.target) {
        try {
          const pin = result.target, remote = await effect<{binding?: {id?: string; sessionKey?: string; state?: string}}>(pin, 8, path(bindingId), {method: 'DELETE', body: JSON.stringify({sessionKey: pin.sessionKey})});
          if (remote?.binding?.id === bindingId && remote.binding.sessionKey === pin.sessionKey && remote.binding.state === 'revoked') cleanup = 'confirmed';
        } catch { /* Offline cleanup never rolls back local revoke/tombstone. */ }
      }
      return {binding: result.binding, cleanup, cancelled: true as const};
    });
    return {
      recoveryScope,
      current: () => run(async () => (await command({...scope, action: 'current'})).binding),
      get: (id: string) => run(() => get(id)), writable: () => run(writable), bind,
      inspect: (id: string) => run(() => inspect(id)), refresh: (id: string) => run(() => refresh(id)), write,
      includeArchive, saveEditor, saveNotebook, moveNotebook,
      inspectWrite: (id: string, mutationId: string) => run(() => inspectWrite(id, mutationId)),
      revoke: (id: string) => release(id, 'revoke'), cancel: (id: string) => release(id, 'cancel'),
      finishMove: (bindingId: string, notebookResource: string, requestId: string) => run(() => command({...scope, action: 'move-finish', bindingId, notebookResource, requestId})),
    };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Freeze new operations first; abort network, but keep SQL ACK settlement
    // available until ALL admitted operations have left their owned finally.
    const drain = this.work.close();
    this.controller.abort();
    this.closing = drain.then(() => this.persistence.close());
    return this.closing;
  }
}

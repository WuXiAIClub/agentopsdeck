import type { WorkspaceBoards } from './workspace-boards.js';
import type { WorkspaceBoardFiles, FileBoardBinding } from './workspace-board-files.js';
import type { ConnectorClient } from './connector-client.js';
import type { WorkspaceFileSnapshot } from '../connector/workspace-file-codec.js';
import { validBoardId, validBoardUuid, validBoardWrite, parseWorkspaceFileCardResource, type BoardContent } from '@agentopsdeck/shared';
import { ChangeSignal } from '../utils/change-signal.js';
import { FILE_BOARD_RUNTIMES, fileBoardRuntime } from '../connector/workspace-board-file-policy.js';

export type FileBoardTarget = {
  connectionId: string; authority: number; sessionKey: string; client: Pick<ConnectorClient, 'json' | 'fileBoardEvents'> & Partial<Pick<ConnectorClient, 'fileCardEvents'>>;
  valid: () => void;
};
export class HubFileBoardError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 503) { super('File board binding unavailable'); }
}
type BindInput = { requestId: string; sessionId: string; revision: number };
type Group = { ids: string; controller: AbortController; task: Promise<void> };
type ProjectionGeneration = { binding: FileBoardBinding; revision: number | undefined; current: boolean };
export type WorkspaceFileWrite<T> = T & { revision: number; mutationId: string };
export type HubWorkspaceFileStore<T> = Pick<WorkspaceBoardFiles,
  'changes' | 'current' | 'get' | 'active' | 'prepare' | 'activate' | 'revoke' | 'cancelAbsent' | 'writeReceipt' | 'finishWrite'> & {
  prepareWrite(owner: string, id: string, input: WorkspaceFileWrite<T>): ReturnType<WorkspaceBoardFiles['prepareWrite']>;
  apply(owner: string, id: string, snapshot: WorkspaceFileSnapshot<T>): ReturnType<WorkspaceBoardFiles['apply']>;
};
export type HubWorkspaceFileProtocol<T> = {
  base: '/workspace/board-files' | '/workspace/card-files';
  mode: 'whole-board-file' | 'workspace-card-file';
  eventPrefix: 'board-file' | 'card-file';
  validResource(value: unknown): value is string;
  validWrite(value: unknown): value is WorkspaceFileWrite<T>;
  content(value: T): T;
  events(client: FileBoardTarget['client'], ids: string[], signal: AbortSignal): ReturnType<ConnectorClient['fileBoardEvents']>;
};

/** Private composition API: caller supplies CURRENT owner/session/connection
 * authorization. No arbitrary URL or filesystem path is accepted here. */
export class HubWorkspaceFileService<T> {
  private readonly controller = new AbortController();
  private readonly pending = new Set<string>();
  private readonly groups = new Map<string, Group>();
  private runner: Promise<void> | undefined;
  private readonly drained = new ChangeSignal();
  private operations = 0;
  private healthy = true;
  private readonly projections = new Set<ProjectionGeneration>();
  constructor(private readonly files: HubWorkspaceFileStore<T>, private readonly boards: { get(owner: string, id: string): T & { revision?: number } },
    private readonly resolve: (owner: string, sessionId: string) => FileBoardTarget,
    private readonly protocol: HubWorkspaceFileProtocol<T>) {}
  private path(id: string) { return this.protocol.base + '/' + encodeURIComponent(id); }
  private generation(binding: FileBoardBinding) {
    const generation = { binding, revision: this.boards.get(binding.userId, binding.resourceId).revision, current: true };
    this.projections.add(generation);
    return generation;
  }
  private current(generation: ProjectionGeneration) {
    const previous = generation.binding, binding = this.files.get(previous.userId, previous.bindingId);
    return generation.current && binding?.state === 'active' && binding.resourceId === previous.resourceId
      && binding.sessionId === previous.sessionId && binding.connectionId === previous.connectionId
      && binding.authority === previous.authority && binding.createdAt === previous.createdAt
      && binding.sourceHash === previous.sourceHash
      && this.boards.get(binding.userId, binding.resourceId).revision === generation.revision;
  }
  private apply(owner: string, id: string, snapshot: WorkspaceFileSnapshot<T>) {
    const outcome = this.files.apply(owner, id, snapshot);
    if (['updated', 'unchanged', 'retained'].includes(outcome))
      for (const generation of this.projections)
        if (generation.binding.userId === owner && generation.binding.bindingId === id) generation.current = false;
    return outcome;
  }
  private target(binding: FileBoardBinding): FileBoardTarget {
    const target = this.resolve(binding.userId, binding.sessionId);
    target.valid();
    if (target.connectionId !== binding.connectionId || target.authority !== binding.authority) throw new HubFileBoardError(403);
    return target;
  }
  private guard() { if (this.controller.signal.aborted || !this.healthy) throw new HubFileBoardError(503); }
  /** Derived operations must participate in shutdown and use its abort signal,
   * including asynchronous capability checks before admitting a durable write. */
  protected async operation<R>(run: (signal: AbortSignal, guard: () => void) => Promise<R>): Promise<R> {
    this.guard(); this.operations++;
    try { return await run(this.controller.signal, () => this.guard()); }
    finally { this.operations--; this.drained.notify(); }
  }
  async writable(owner: string, resourceId: string): Promise<boolean> {
    this.guard(); this.operations++;
    try {
    const binding = this.files.current(owner, resourceId);
    if (!binding || binding.state !== 'active') return false;
    const target = this.target(binding);
    const capability = await target.client.json<{ writeProtocol?: number }>(this.protocol.base, { signal: this.controller.signal });
    this.guard(); this.target(binding);
    if (capability?.writeProtocol !== 1) return false;
    // Installation can finish before the first subscription snapshot. A card
    // is not writable until its CAS baseline has been read. Establish that
    // baseline explicitly rather than advertise a save that will always 409.
    // Never rebase a submitted revision: a concurrent Agent edit must still
    // conflict in prepareWrite below.
    if (!this.files.get(owner, binding.bindingId)?.sourceHash)
      await this.refresh(owner, resourceId, binding.bindingId);
    this.guard(); this.target(binding);
    const current = this.files.get(owner, binding.bindingId);
    return current?.state === 'active' && !!current.sourceHash && !current.problem;
    } finally { this.operations--; this.drained.notify(); }
  }
  async inspectWrite(owner: string, resourceId: string, id: string, mutationId: string) {
    this.guard(); this.operations++;
    try {
    const binding = this.files.get(owner, id), existing = this.files.writeReceipt(owner, id, mutationId);
    if (!binding || binding.resourceId !== resourceId || !existing) throw new HubFileBoardError(404);
    const target = this.target(binding);
    if (existing.state === 'uncertain') {
      try {
        const result = await target.client.json<{ receipt?: { mutationId?: string; state?: string } }>(`${this.path(id)}/writes/${mutationId}`, { signal: this.controller.signal });
        this.guard(); this.target(binding);
        if (result.receipt?.mutationId === mutationId && ['saved', 'conflict', 'uncertain'].includes(result.receipt.state ?? ''))
          this.files.finishWrite(owner, id, mutationId, result.receipt.state as 'saved' | 'conflict' | 'uncertain');
      } catch { /* A missing/unavailable receipt does not authorize resend. */ }
    }
    this.guard(); this.target(binding);
    const receipt = this.files.writeReceipt(owner, id, mutationId);
    if (!receipt) throw new HubFileBoardError(403);
    // A durable receipt confirms the disk write, not that the shared stream has
    // already projected it. Reconcile CURRENT file contents before letting the
    // UI clear its draft (or unlink). Never import the historical receipt's
    // snapshot: a later Agent edit may already exist. Failure stays inspectable,
    // and this explicit read never replays the mutation.
    if (receipt.state === 'saved' && this.files.get(owner, id)?.state === 'active')
      await this.refresh(owner, resourceId, id);
    return { mutationId, state: receipt.state };
    } finally { this.operations--; this.drained.notify(); }
  }
  async write(owner: string, resourceId: string, id: string, input: WorkspaceFileWrite<T>,
    admit?: (prepare: () => ReturnType<WorkspaceBoardFiles['prepareWrite']>) => ReturnType<WorkspaceBoardFiles['prepareWrite']>) {
    this.guard();
    if (!this.protocol.validWrite(input)) throw new HubFileBoardError(400);
    const binding = this.files.get(owner, id);
    if (!binding || binding.resourceId !== resourceId || binding.state !== 'active') throw new HubFileBoardError(409);
    const target = this.target(binding);
    // Existing intent is inspected, never submitted again, even if the first
    // request crashed before reaching the Connector.
    const existing = this.files.writeReceipt(owner, id, input.mutationId);
    if (!existing && !await this.writable(owner, resourceId)) throw new HubFileBoardError(409);
    this.guard(); this.target(binding);
    // Coordinators reserve their local state and the file intent in ONE
    // synchronous database transaction, after all asynchronous preflight.
    const prepare = () => this.files.prepareWrite(owner, id, input);
    const intent = admit && !existing ? admit(prepare) : prepare();
    if (!intent) throw new HubFileBoardError(409);
    if (!intent.fresh) return this.inspectWrite(owner, resourceId, id, input.mutationId);
    const generation = this.generation(this.files.get(owner, id)!);
    this.operations++;
    try {
      try {
        const result = await target.client.json<{ receipt?: { mutationId?: string; state?: string; snapshot?: WorkspaceFileSnapshot<T> } }>(`${this.path(id)}/writes`, {
          method: 'POST', body: JSON.stringify({ mutationId: input.mutationId, expectedHash: intent.expectedHash,
            content: this.protocol.content(input) }), signal: this.controller.signal,
        });
        this.guard(); this.target(binding);
        const receipt = result.receipt;
        if (receipt?.mutationId === input.mutationId && ['saved', 'conflict', 'uncertain'].includes(receipt.state ?? '')) {
          this.files.finishWrite(owner, id, input.mutationId, receipt.state as 'saved' | 'conflict' | 'uncertain');
          // Do not roll back a newer stream projection with a delayed response.
          if (receipt.snapshot && this.current(generation))
            this.apply(owner, id, receipt.snapshot);
        }
      } catch { /* Durable uncertain outcome; no background write retry. */ }
      this.guard(); this.target(binding);
      const receipt = this.files.writeReceipt(owner, id, input.mutationId);
      if (!receipt) throw new HubFileBoardError(403);
      return { mutationId: input.mutationId, state: receipt.state };
    } finally { this.projections.delete(generation); this.operations--; this.drained.notify(); }
  }
  async bind(owner: string, resourceId: string, input: BindInput) {
    this.guard();
    if (!this.protocol.validResource(resourceId) || !validBoardUuid(input.requestId) || typeof input.sessionId !== 'string' || input.sessionId.length > 1024
      || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new HubFileBoardError(400);
    const key = JSON.stringify([owner, resourceId]);
    if (this.pending.has(key)) throw new HubFileBoardError(409);
    if (this.pending.size >= 16) throw new HubFileBoardError(429);
    this.pending.add(key);
    this.operations++;
    try {
      const target = this.resolve(owner, input.sessionId); target.valid();
      const intent = { bindingId: input.requestId, userId: owner, resourceId, sessionId: input.sessionId, connectionId: target.connectionId, authority: target.authority };
      const previous = this.files.get(owner, input.requestId);
      if (previous) {
        const matching = this.files.prepare(intent, input.revision);
        if (!matching) throw new HubFileBoardError(409);
        return matching; // Durable receipt: NEVER repeat PUT after lost response.
      }
      // Verify explicit capability before locking a manual/empty board. A legacy
      // Connector's 404/403 must not create a frozen prepared binding.
      const runtime = fileBoardRuntime(target.sessionKey);
      if (!runtime) throw new HubFileBoardError(409);
      const capability = await target.client.json<{ protocol: number; mode: string; runtimeProtocol?: unknown; runtimes?: unknown; notebookArchiveProtocol?: unknown }>(this.protocol.base, { signal: this.controller.signal });
      this.guard(); target.valid();
      if (capability?.protocol !== 1 || capability.mode !== this.protocol.mode) throw new HubFileBoardError(409);
      if (this.protocol.mode === 'workspace-card-file' && parseWorkspaceFileCardResource(resourceId)?.kind === 'notebook'
        && capability.notebookArchiveProtocol !== 1) throw new HubFileBoardError(409);
      // Older Connectors omit both fields: retain their existing supported
      // runtime path. An explicit negative or malformed new declaration must
      // never downgrade to that legacy fallback or lock the manual document.
      if ('runtimeProtocol' in capability || 'runtimes' in capability) {
        if (capability.runtimeProtocol !== 1 || !Array.isArray(capability.runtimes)
          || capability.runtimes.length > FILE_BOARD_RUNTIMES.length
          || new Set(capability.runtimes).size !== capability.runtimes.length
          || !capability.runtimes.every(value => FILE_BOARD_RUNTIMES.includes(value))
          || !capability.runtimes.includes(runtime)) throw new HubFileBoardError(409);
      }
      const prepared = this.files.prepare(intent, input.revision);
      if (!prepared) throw new HubFileBoardError(409);
      const document = this.boards.get(owner, resourceId);
      try {
        const remote = await target.client.json<unknown>(this.path(input.requestId), {
          method: 'PUT', body: JSON.stringify({ sessionKey: target.sessionKey, content: this.protocol.content(document) }), signal: this.controller.signal,
        });
        this.guard(); target.valid(); this.confirm(prepared, target, remote);
      } catch { /* Prepared is deliberately uncertain, not failed/not-delivered. */ }
      return this.files.get(owner, input.requestId)!;
    } finally { this.pending.delete(key); this.operations--; this.drained.notify(); }
  }
  private confirm(binding: FileBoardBinding, target: FileBoardTarget, value: unknown) {
    if (!value || typeof value !== 'object' || !('binding' in value)) return;
    const row = value.binding;
    if (!row || typeof row !== 'object' || !('id' in row) || row.id !== binding.bindingId
      || !('sessionKey' in row) || row.sessionKey !== target.sessionKey || !('state' in row)) return;
    if (row.state === 'installed') this.files.activate(binding.userId, binding.bindingId);
    else if (row.state === 'revoked') this.files.revoke(binding.userId, binding.bindingId);
  }
  async inspect(owner: string, resourceId: string, id: string) {
    this.guard(); this.operations++;
    try {
      const binding = this.files.get(owner, id);
      if (!binding || binding.resourceId !== resourceId) throw new HubFileBoardError(404);
      if (binding.state === 'revoked') return binding;
      const target = this.target(binding);
      const remote = await target.client.json<unknown>(this.path(id), { signal: this.controller.signal });
      this.guard(); target.valid(); this.confirm(binding, target, remote);
      return this.files.get(owner, id)!;
    } finally { this.operations--; this.drained.notify(); }
  }
  /** Explicit post-save reconciliation, not periodic polling. Binding inspection
   * alone only reads lifecycle metadata and cannot settle a notebook CAS. */
  async refresh(owner: string, resourceId: string, id: string) {
    this.guard(); this.operations++;
    let generation: ProjectionGeneration | undefined;
    try {
      const binding = this.files.get(owner, id);
      if (!binding || binding.resourceId !== resourceId || binding.state !== 'active') throw new HubFileBoardError(409);
      const target = this.target(binding);
      generation = this.generation(binding);
      const result = await target.client.json<{ snapshot?: WorkspaceFileSnapshot<T> }>(`${this.path(id)}/snapshot`, { signal: this.controller.signal });
      this.guard(); this.target(binding);
      if (!result.snapshot) throw new HubFileBoardError(503);
      // An SSE event received during the read is newer evidence: don't roll it back.
      if (this.current(generation)) {
        const outcome = this.apply(owner, id, result.snapshot);
        if (!['updated', 'unchanged'].includes(outcome)) throw new HubFileBoardError(503);
      }
    } finally { if (generation) this.projections.delete(generation); this.operations--; this.drained.notify(); }
  }
  async revoke(owner: string, resourceId: string, id: string) {
    this.guard(); this.operations++;
    try {
      const binding = this.files.get(owner, id);
      if (!binding || binding.resourceId !== resourceId) throw new HubFileBoardError(404);
      this.files.revoke(owner, id); // Local imports stop BEFORE best-effort network cleanup.
      let cleanup: 'confirmed' | 'pending' = 'pending';
      try {
        const target = this.target(binding);
        const remote = await target.client.json<{ binding?: { id?: string; state?: string; sessionKey?: string } }>(this.path(id), {
          method: 'DELETE', body: JSON.stringify({ sessionKey: target.sessionKey }), signal: this.controller.signal,
        });
        target.valid();
        if (remote?.binding?.id === id && remote.binding.state === 'revoked' && remote.binding.sessionKey === target.sessionKey) cleanup = 'confirmed';
      } catch { /* Last-good board and revoked receipt survive an offline node. */ }
      return { binding: this.files.get(owner, id)!, cleanup };
    } finally { this.operations--; this.drained.notify(); }
  }
  async cancel(owner: string, resourceId: string, id: string) {
    this.guard();
    if (!this.protocol.validResource(resourceId) || !validBoardUuid(id)) throw new HubFileBoardError(400);
    const binding = this.files.get(owner, id);
    if (binding) {
      const result = await this.revoke(owner, resourceId, id);
      return { cancelled: true as const, cleanup: result.cleanup };
    }
    if (!this.files.cancelAbsent(owner, resourceId, id)) throw new HubFileBoardError(409);
    return { cancelled: true as const, cleanup: 'confirmed' as const };
  }
  start() {
    this.guard();
    if (!this.runner) this.runner = this.run().catch(() => { this.healthy = false; });
  }
  private async run() {
    try {
      while (!this.controller.signal.aborted) {
        const revision = this.files.changes.revision;
        const groups = new Map<string, FileBoardBinding[]>();
        for (const binding of this.files.active()) {
          const key = JSON.stringify([binding.userId, binding.connectionId, binding.authority]);
          const list = groups.get(key) ?? []; list.push(binding); groups.set(key, list);
        }
        for (const [key, entry] of this.groups) {
          const ids = groups.get(key)?.map(b => b.bindingId).sort().join(',');
          if (ids !== entry.ids) { entry.controller.abort(); await entry.task; this.groups.delete(key); }
        }
        for (const [key, bindings] of groups) {
          if (this.groups.has(key) || this.controller.signal.aborted) continue;
          const controller = new AbortController();
          this.groups.set(key, { ids: bindings.map(b => b.bindingId).sort().join(','), controller,
            task: this.follow(bindings, AbortSignal.any([this.controller.signal, controller.signal])).catch(() => { this.healthy = false; }) });
        }
        await this.files.changes.wait(revision, this.controller.signal);
      }
    } finally {
      for (const group of this.groups.values()) group.controller.abort();
      await Promise.all([...this.groups.values()].map(group => group.task)); this.groups.clear();
    }
  }
  private async follow(bindings: FileBoardBinding[], signal: AbortSignal) {
    const indexed = new Map(bindings.map(b => [b.bindingId, b])), delay = new ChangeSignal(); let backoff = 1000;
    while (!signal.aborted) {
      try {
        const allowed: string[] = []; let target: FileBoardTarget | undefined;
        for (const binding of bindings) {
          try { const current = this.target(binding); allowed.push(binding.bindingId); target ??= current; }
          catch { /* One session losing permission cannot block the other boards. */ }
        }
        if (!target || !allowed.length) throw new Error('No authorized file board');
        for await (const frame of this.protocol.events(target.client, allowed, signal)) {
          target.valid(); signal.throwIfAborted();
          if (frame.event === 'heartbeat') { backoff = 1000; continue; }
          if (![`${this.protocol.eventPrefix}.snapshot`, `${this.protocol.eventPrefix}.closed`].includes(frame.event ?? '')) continue;
          const data: unknown = JSON.parse(frame.data);
          if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string') throw new Error('Invalid file board frame');
          const binding = indexed.get(data.id); if (!binding || !allowed.includes(data.id)) throw new Error('Unrequested file board frame');
          if (frame.event === `${this.protocol.eventPrefix}.closed`) { this.files.revoke(binding.userId, binding.bindingId); continue; }
          if (!('snapshot' in data)) throw new Error('Missing file board snapshot');
          const result = this.apply(binding.userId, binding.bindingId, data.snapshot as WorkspaceFileSnapshot<T>);
          if (result === 'invalid' || result === 'limit') this.apply(binding.userId, binding.bindingId, { state: 'unavailable' });
          backoff = 1000;
        }
      } catch { /* Bounded reconnect; imports always revalidate durable authority. */ }
      if (signal.aborted) break;
      for (const binding of bindings) this.apply(binding.userId, binding.bindingId, { state: 'unavailable' });
      await delay.wait(delay.revision, signal, backoff); backoff = Math.min(30_000, backoff * 2);
    }
  }
  async close() {
    this.controller.abort(); await this.runner;
    while (this.operations) await this.drained.wait(this.drained.revision, new AbortController().signal);
  }
}

/** Existing task-file API retains its wire format and authorization boundary. */
export class HubFileBoardService extends HubWorkspaceFileService<BoardContent> {
  constructor(files: WorkspaceBoardFiles, boards: WorkspaceBoards, resolve: (owner: string, sessionId: string) => FileBoardTarget) {
    super(files, boards, resolve, {
      base: '/workspace/board-files', mode: 'whole-board-file', eventPrefix: 'board-file',
      validResource: validBoardId, validWrite: validBoardWrite,
      content: ({ title, tasks }) => ({ title, tasks }),
      events: (client, ids, signal) => client.fileBoardEvents(ids, signal),
    });
  }
}

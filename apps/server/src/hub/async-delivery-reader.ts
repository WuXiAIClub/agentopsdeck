import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { Worker } from 'node:worker_threads';
import { observeReadonlyOwner, type ReadonlyOwnerFailureCode } from '../storage/readonly-owner-observation.js';
import { createReadonlyWorkerStop } from '../storage/readonly-worker-stop.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createReadonlyFailureReceiver } from '../storage/readonly-failure-relay.js';
import { validConnectionRows } from './connection-read-protocol.js';
import type { HubConnection } from './hub-store.js';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { validWorkspacePreferences } from './workspace-preference-read.js';
import { validWorkspaceLayout } from './workspace-layout-read.js';
import type { LayoutDocument, LayoutKind } from './workspace-layouts.js';
import { validCompletionSummaryRead, validCompletionSummaryRows, type CompletionSummaryRead, type CompletionSummaryRow } from './completion-summary-read.js';
import { validWorkspaceBoardRead, validWorkspaceBoardResult, type WorkspaceBoardRead, type WorkspaceBoardReadResult } from './workspace-board-snapshot-read.js';
import { validNotebookSnapshotRead, validNotebookSnapshot, type NotebookSnapshotRead, type NotebookSnapshot } from './notebook-snapshot-read.js';
import { deliveryReadUnavailable, DeliverySnapshotReadRejected, isDeliverySnapshotReadRejected, deliveryReadMetadataBytes, validDeliveryRead, validDeliveryPage, validPreferenceRows,
  validWorkspaceRevisions, WORKSPACE_REVISION_TYPES, type WorkspaceRevisions,
  validUserRead, validUserRows, type UserRead, type UserRows,
  type DeliveryReaderConfig, type DeliveryRead, type DeliveryPage, type PreferenceRows } from './delivery-reader-protocol.js';

type ReadKind = 'page' | 'preferences' | 'users' | 'revisions' | 'connections' | 'workspace' | 'layout-current' | 'layout-saved' | 'completions' | 'boards' | 'notebooks';
type ReadResult = DeliveryPage | PreferenceRows | UserRows | WorkspaceRevisions | HubConnection[] | WorkspacePreferences | LayoutDocument | CompletionSummaryRow[] | WorkspaceBoardReadResult | NotebookSnapshot;
type Waiter = { kind: ReadKind; scope?: UserRead; connectionOwner?: string; completionRead?: CompletionSummaryRead; boardRead?: WorkspaceBoardRead; notebookRead?: NotebookSnapshotRead; resolve(value: ReadResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const operationFor = (kind: ReadKind) => kind === 'page' ? 'hub-delivery-read' : kind === 'preferences' ? 'hub-preference-read'
  : kind === 'revisions' ? 'hub-workspace-revisions-read' : kind === 'connections' ? 'hub-connections-read'
  : kind === 'workspace' ? 'hub-workspace-preferences-read' : kind === 'boards' ? 'hub-workspace-board-read'
  : kind === 'notebooks' ? 'hub-notebook-snapshot-read'
  : kind === 'layout-current' || kind === 'layout-saved' ? 'hub-workspace-layout-read'
  : kind === 'completions' ? 'hub-completion-summary-read' : 'hub-users-read';
const METADATA_BUDGET = 8 * 1024 * 1024;
// Each preference/users reply can contain 8 MiB. Reserve at most four original
// requests, including startup waiters, rather than 256 potentially large replies.
const SNAPSHOT_PENDING_LIMIT = 4;

/** Only browser replay and visibility reads. Cannot mutate facts/receipts, acknowledge an
 * upstream cursor, decide permission, or replace the shared Hub writer. */
export class AsyncHubDeliveryReader {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private readonly originalStop: ReturnType<typeof createReadonlyWorkerStop>;
  private sequence = 0;
  private failed = false;
  private failureCode: ReadonlyOwnerFailureCode | undefined;
  private exitConfirmed = false;
  private readyReceived = false;
  private closeRequested = false;
  private closeId: number | undefined;
  private closeAcknowledged = false;
  private closing: Promise<void> | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private readonly pending = new Map<number, Waiter>();
  private readonly accepted = new Set<Promise<ReadResult>>();
  private acceptedMetadataBytes = 0;
  private acceptedSnapshotReads = 0;
  get recoveryState() { return { unavailable: this.failed, exitConfirmed: this.exitConfirmed }; }
  constructor(config: DeliveryReaderConfig, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    launch?: () => Worker, private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw deliveryReadUnavailable();
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    const entry = new URL(source ? './delivery-reader-worker.ts' : './delivery-reader-worker.js', import.meta.url);
    this.worker = launch ? launch() : new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
      ...config, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
    this.originalStop = createReadonlyWorkerStop(this.worker,
      () => observeReadonlyOwner(this.diagnostics, 'hub-delivery-read', 8, this.accepted.size, 9));
    this.exited = new Promise<void>(resolve => this.worker.once('exit', code => {
      this.exitConfirmed = true;
      this.originalStop.confirmExit();
      if (!this.closing || !this.closeAcknowledged || code !== 0) this.fail(3);
      observeReadonlyOwner(this.diagnostics, 'hub-delivery-read', 7, this.accepted.size, this.failureCode);
      resolve();
    }));
    this.ready = new Promise<void>((resolve, reject) => {
      const receiveFailure = createReadonlyFailureReceiver('hub', this.diagnostics);
      this.rejectReady = reject;
      const timer = setTimeout(() => {
        this.fail(1);
        const trace = guardedTrace(this.diagnostics, 'hub-delivery-read'); trace.add('step', 0); trace.add('timedOut', 1); trace.finish(true);
        reject(deliveryReadUnavailable());
      }, timeoutMs); timer.unref();
      this.worker.once('error', () => { clearTimeout(timer); reject(deliveryReadUnavailable()); this.fail(2); });
      this.worker.once('exit', () => { clearTimeout(timer); reject(deliveryReadUnavailable()); });
      this.worker.on('message', (message: unknown) => {
        if (receiveFailure(message)) return;
        const r = message as { id?: unknown; kind?: unknown; ok?: unknown; value?: unknown } | null;
        if (r && typeof r === 'object' && !Array.isArray(r) && r.kind === 'ready' && Object.keys(r).length === 1) {
          if (this.readyReceived || this.failed) { this.fail(4); return; }
          this.readyReceived = true; clearTimeout(timer); resolve(); return;
        }
        if (!r || typeof r !== 'object' || Array.isArray(r) || !Number.isSafeInteger(r.id)
          || Object.keys(r).some(key => !['id', 'kind', 'ok', 'value'].includes(key))) { this.fail(4); return; }
        if (this.readyReceived && !this.closeAcknowledged && r.id === this.closeId && r.kind === 'close'
          && r.ok === true && Object.keys(r).length === 3) { this.closeAcknowledged = true; return; }
        const waiter = this.pending.get(r.id as number);
        if (waiter && waiter.kind !== 'page' && r.kind === waiter.kind && r.ok === false && Object.keys(r).length === 3) {
          // A completed bounded-metadata rejection affects only this original
          // display read. Malformed packets and SQL/owner faults remain fatal.
          clearTimeout(waiter.timer); this.pending.delete(r.id as number); waiter.reject(new DeliverySnapshotReadRejected()); return;
        }
        if (!waiter || r.kind !== waiter.kind || r.ok !== true || !Object.hasOwn(r, 'value')
          || !(waiter.kind === 'page' ? validDeliveryPage(r.value) : waiter.kind === 'preferences'
            ? validPreferenceRows(r.value) : waiter.kind === 'revisions' ? validWorkspaceRevisions(r.value)
            : waiter.kind === 'connections' ? validConnectionRows(r.value, waiter.connectionOwner)
            : waiter.kind === 'workspace' ? validWorkspacePreferences(r.value)
            : waiter.kind === 'layout-current' ? validWorkspaceLayout(r.value, 'current')
            : waiter.kind === 'layout-saved' ? validWorkspaceLayout(r.value, 'saved')
            : waiter.kind === 'completions' ? !!waiter.completionRead && validCompletionSummaryRows(r.value, waiter.completionRead)
            : waiter.kind === 'boards' ? !!waiter.boardRead && validWorkspaceBoardResult(r.value, waiter.boardRead)
            : waiter.kind === 'notebooks' ? !!waiter.notebookRead && validNotebookSnapshot(r.value, waiter.notebookRead)
            : validUserRows(r.value, waiter.scope))) { this.fail(4); return; }
        clearTimeout(waiter.timer); this.pending.delete(r.id as number); waiter.resolve(r.value as ReadResult);
      });
    });
    void this.ready.catch(() => {});
  }
  private fail(code: ReadonlyOwnerFailureCode) {
    if (this.failed) return;
    this.failed = true; this.failureCode = code; this.rejectReady?.(deliveryReadUnavailable());
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(deliveryReadUnavailable()); }
    this.pending.clear();
    observeReadonlyOwner(this.diagnostics, 'hub-delivery-read', 6, this.accepted.size, code);
    if (!this.exitConfirmed) this.originalStop.request();
  }
  read(read: DeliveryRead): Promise<DeliveryPage> {
    return this.enqueue(read, 'page') as Promise<DeliveryPage>;
  }
  preferences(owner: string): Promise<PreferenceRows> {
    return this.enqueue({ owner, domains: [] }, 'preferences') as Promise<PreferenceRows>;
  }
  users(read: UserRead): Promise<UserRows> {
    return this.enqueue(read, 'users') as Promise<UserRows>;
  }
  revisions(owner: string): Promise<WorkspaceRevisions> {
    return this.enqueue({ owner, domains: [] }, 'revisions') as Promise<WorkspaceRevisions>;
  }
  connections(owner: string): Promise<HubConnection[]> {
    return this.enqueue({ owner, domains: [] }, 'connections') as Promise<HubConnection[]>;
  }
  workspace(owner: string): Promise<WorkspacePreferences> {
    return this.enqueue({ owner, domains: [] }, 'workspace') as Promise<WorkspacePreferences>;
  }
  layout(owner: string, kind: LayoutKind): Promise<LayoutDocument> {
    if (kind !== 'current' && kind !== 'saved') return Promise.reject(deliveryReadUnavailable());
    return this.enqueue({ owner, domains: [] }, kind === 'current' ? 'layout-current' : 'layout-saved') as Promise<LayoutDocument>;
  }
  completions(owner: string, targets: string[]): Promise<CompletionSummaryRow[]> {
    return this.enqueue({ owner, targets }, 'completions') as Promise<CompletionSummaryRow[]>;
  }
  boards(read: WorkspaceBoardRead): Promise<WorkspaceBoardReadResult> {
    return this.enqueue(read, 'boards') as Promise<WorkspaceBoardReadResult>;
  }
  notebooks(read: NotebookSnapshotRead): Promise<NotebookSnapshot> { return this.enqueue(read, 'notebooks') as Promise<NotebookSnapshot>; }
  private enqueue(read: DeliveryRead | UserRead | CompletionSummaryRead | WorkspaceBoardRead | NotebookSnapshotRead, kind: ReadKind): Promise<ReadResult> {
    const operation = operationFor(kind);
    if (this.failed || this.closeRequested || this.accepted.size >= 256
      || (kind !== 'page' && this.acceptedSnapshotReads >= SNAPSHOT_PENDING_LIMIT)
      || !(kind === 'users' ? validUserRead(read) : kind === 'completions' ? validCompletionSummaryRead(read)
        : kind === 'boards' ? validWorkspaceBoardRead(read) : kind === 'notebooks' ? validNotebookSnapshotRead(read) : validDeliveryRead(read))) {
      const trace = guardedTrace(this.diagnostics, operation); trace.add('deferred', 1);
      if (kind !== 'page' && this.acceptedSnapshotReads >= SNAPSHOT_PENDING_LIMIT) {
        trace.add('step', 6); trace.add('pending', this.acceptedSnapshotReads);
      }
      trace.finish(true);
      return Promise.reject(deliveryReadUnavailable());
    }
    // Snapshot caller-owned metadata before the first await. A mutated Map or
    // array cannot widen the broker's admitted visibility while startup waits.
    let request: DeliveryRead | UserRead | CompletionSummaryRead | WorkspaceBoardRead | NotebookSnapshotRead | undefined, bytes: number | undefined;
    try {
      if (kind === 'users') {
        const scope = read as UserRead;
        request = { owner: scope.owner, admin: scope.admin };
        if (validUserRead(request)) bytes = Buffer.byteLength(JSON.stringify(request));
      } else if (kind === 'notebooks') {
        const source = read as NotebookSnapshotRead;
        request = { owner: source.owner, mode: source.mode, resourceId: source.resourceId, after: source.after, query: source.query, includeArchive: source.includeArchive };
        if (validNotebookSnapshotRead(request)) bytes = Buffer.byteLength(JSON.stringify(request));
      } else if (kind === 'boards') {
        const source = read as WorkspaceBoardRead;
        request = { owner: source.owner, mode: source.mode, resourceId: source.resourceId };
        if (validWorkspaceBoardRead(request)) bytes = Buffer.byteLength(JSON.stringify(request));
      } else if (kind === 'completions') {
        const source = read as CompletionSummaryRead, sourceTargets = source.targets, length = sourceTargets.length;
        if (!Array.isArray(sourceTargets) || !Number.isSafeInteger(length) || length < 0 || length > 256)
          throw deliveryReadUnavailable();
        const targets: string[] = [];
        for (let i = 0; i < length; i++) targets.push(sourceTargets[i]!);
        request = { owner: source.owner, targets };
        if (validCompletionSummaryRead(request)) bytes = Buffer.byteLength(JSON.stringify(request));
      } else {
        // Do not invoke caller-owned map/species hooks to create our snapshot.
        // Capture and bound length once, including a domains getter/proxy that
        // changed after validation. Every admitted pair is a fresh plain array.
        const page = read as DeliveryRead, sourceDomains = page.domains, length = sourceDomains.length;
        if (!Array.isArray(sourceDomains) || !Number.isSafeInteger(length) || length < 0 || length > 4096)
          throw deliveryReadUnavailable();
        const domains: [string, string][] = [];
        for (let i = 0; i < length; i++) {
          const pair = sourceDomains[i]!;
          domains.push([pair[0], pair[1]]);
        }
        request = { owner: page.owner, cursor: page.cursor, domains };
        bytes = deliveryReadMetadataBytes(request);
      }
    } catch { bytes = undefined; }
    // Caller property inspection can reenter read/close or deliver a failure.
    // Recheck lifetime/count at the final admission point, after every hook
    // and before reserving any capacity for this request.
    if (!request || bytes === undefined || this.failed || this.closeRequested || this.accepted.size >= 256
      || (kind !== 'page' && this.acceptedSnapshotReads >= SNAPSHOT_PENDING_LIMIT)) {
      const trace = guardedTrace(this.diagnostics, operation); trace.add('deferred', 1);
      if (kind !== 'page' && this.acceptedSnapshotReads >= SNAPSHOT_PENDING_LIMIT) {
        trace.add('step', 6); trace.add('pending', this.acceptedSnapshotReads);
      }
      trace.finish(true);
      return Promise.reject(deliveryReadUnavailable());
    }
    if (this.acceptedMetadataBytes > METADATA_BUDGET - bytes) {
      const trace = guardedTrace(this.diagnostics, operation); trace.add('step', 5);
      trace.add('pending', this.accepted.size); trace.add('snapshotBytes', this.acceptedMetadataBytes);
      trace.add('deferred', 1); trace.finish(true);
      return Promise.reject(deliveryReadUnavailable());
    }
    // Count the exact owned snapshot, including reads waiting for readiness.
    // Rejection is backpressure, not worker failure or permission to replay.
    // Restore capacity only when this accepted read's original Promise settles;
    // disconnect/deadline/close ACK never releases a separate writer owner.
    this.acceptedMetadataBytes += bytes;
    if (kind !== 'page') this.acceptedSnapshotReads++;
    // Register the original accepted Promise before dispatch invokes injected
    // diagnostics. A reentrant clock must see this request's occupied slot;
    // close also drains this same Promise, not a later replacement.
    const work = Promise.resolve().then(() => this.dispatch(request, kind)); this.accepted.add(work);
    const settledBytes = bytes;
    const release = () => {
      if (this.accepted.delete(work)) {
        this.acceptedMetadataBytes -= settledBytes;
        if (kind !== 'page') this.acceptedSnapshotReads--;
      }
    };
    void work.then(release, release);
    return work;
  }
  private async dispatch(read: DeliveryRead | UserRead | CompletionSummaryRead | WorkspaceBoardRead | NotebookSnapshotRead, kind: ReadKind) {
    const trace = guardedTrace(this.diagnostics, operationFor(kind)); trace.add('step', 1);
    const at = performance.now(); let failed = true, admitted = false, refused = false;
    try {
      await this.ready;
      if (this.failed) throw deliveryReadUnavailable();
      if (this.sequence === Number.MAX_SAFE_INTEGER) { this.fail(7); throw deliveryReadUnavailable(); }
      const id = ++this.sequence; trace.add('queueMs', performance.now() - at); admitted = true;
      const result = await new Promise<ReadResult>((resolve, reject) => {
        const timer = setTimeout(() => { this.fail(5); trace.add('timedOut', 1); }, this.timeoutMs); timer.unref();
        this.pending.set(id, { kind, ...(kind === 'users' ? { scope: read as UserRead } : {}),
          ...(kind === 'connections' ? { connectionOwner: read.owner } : {}),
          ...(kind === 'completions' ? { completionRead: read as CompletionSummaryRead } : {}), resolve, reject, timer });
        if (kind === 'boards') this.pending.get(id)!.boardRead = read as WorkspaceBoardRead;
        if (kind === 'notebooks') this.pending.get(id)!.notebookRead = read as NotebookSnapshotRead;
        try { this.worker.postMessage({ id, kind, read: kind !== 'page' && kind !== 'users' && kind !== 'completions' && kind !== 'boards' && kind !== 'notebooks' ? { owner: read.owner } : read }); } catch { this.fail(6); }
      });
      trace.add('records', kind === 'revisions' ? WORKSPACE_REVISION_TYPES.reduce((n, type) => n + (result as WorkspaceRevisions)[type].length, 0)
        : kind === 'workspace' ? Object.keys((result as WorkspacePreferences).sessions).length
        : kind === 'notebooks' ? (result as NotebookSnapshot).versions.length
        : kind === 'layout-current' || kind === 'layout-saved' || kind === 'boards' && !Array.isArray(result) ? 1
        : Array.isArray(result) ? result.length : (result as DeliveryPage).events.length); failed = false; return result;
    } catch (error) {
      refused = isDeliverySnapshotReadRejected(error);
      throw error;
    } finally {
      trace.add(admitted ? failed && !refused ? 'unknown' : 'settled' : 'deferred', 1);
      if (refused) trace.add('deferred', 1);
      trace.finish(failed);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closeRequested = true;
    return this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.accepted]);
      const trace = guardedTrace(this.diagnostics, 'hub-delivery-read'); trace.add('step', 3);
      const warning = setTimeout(() => {
        this.fail(8); trace.reportPending({ pending: 1, unknown: 1 });
      }, this.timeoutMs); warning.unref();
      try {
        try { await this.ready; } catch { this.fail(2); }
        if (!this.failed && !this.exitConfirmed) {
          if (this.sequence === Number.MAX_SAFE_INTEGER) this.fail(7);
          else { this.closeId = ++this.sequence; try { this.worker.postMessage({ id: this.closeId, kind: 'close' }); } catch { this.fail(6); } }
        }
        // A deadline reports pending, never latches a failed consumer drain.
        // A stalled readonly worker may be stopped, but only actual exit can
        // release the original writer. No second signal/ad-hoc unlock needed.
        await this.exited; trace.add('settled', 1); trace.finish();
      } finally { clearTimeout(warning); }
    });
  }
}

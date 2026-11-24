import { synchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { ConnectorUpdateStatus } from '@agentopsdeck/shared';
import type { ServerConfig } from '../config.js';
import { CommandConflict, MAX_COMMAND_RESULT_BYTES, type CommandReceipt } from '../commands/receipts.js';
import { ARTIFACT_DOWNLOAD, MANIFEST_DOWNLOAD, downloadUpdate } from './update-download.js';
import { syncUpdateDirectory, syncUpdateJournal, syncUpdateParents, writeUpdateJournal } from './update-journal.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { AsyncMaintenancePause } from './async-maintenance-lifecycle.js';
import { AsyncUpdateLockCleanup, AsyncUpdateLockRecovery, AsyncUpdateLockOwner, UpdateLockBusy,
  type OriginalUpdateLockOwner } from './async-update-lock.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { startupOwnerPathKey } from '../storage/startup-owner.js';
import type { UpdatePersistence } from './update-persistence.js';

type ManifestEntry = { version: string; revision?: string; artifactUrl: string; sha256: string; size?: number; channel?: 'stable' | 'candidate' | 'manual'; entrypoint?: string };
type ReleaseIdentity = { version: string; revision?: string | undefined; entrypoint?: string | undefined };
type UpdateCommand = { scope: string; key: string; id: string };
type MaintenanceOperation = 'pause' | 'resume';
export type MaintenanceFence = {
  version: 1; nodeId: string; actorId: string; id: string;
  state: 'paused' | 'resuming' | 'released';
  resumeInterrupted?: true;
  command: UpdateCommand & { operation: MaintenanceOperation };
};
type ApplyRequest = { version?: unknown; revision?: unknown; manifestSha256?: unknown; idempotencyKey?: unknown };
type StableState = ConnectorUpdateStatus & { maintenance?: MaintenanceFence | undefined; updateCommand?: UpdateCommand | undefined; selectedRelease?: (ReleaseIdentity & { path: string }) | undefined; previousSymlinkTarget?: string | undefined; previousRelease?: ReleaseIdentity | undefined; lastIdempotencyKey?: string | undefined };
type Selection = { version: 1; link: string; temporaryLink: string; before: string | null; after: string; completed: StableState };
type State = StableState & { selection?: Selection | undefined };
class UpdateBusyError extends Error { constructor() { super('connector update operation already in progress'); } }
export class UpdateAuthorizationError extends Error { constructor() { super('update authorization changed'); } }
type Authorize = () => unknown;

export class ConnectorUpdateService {
  private static readonly locks = new Set<string>();
  // Reservation identity only. Never pass a case-folded or namespace-folded
  // Windows key to filesystem APIs or to the original SQLite lock owner.
  private static readonly lockPathKey = startupOwnerPathKey;
  private static readonly lockRecovery = new AsyncUpdateLockRecovery();
  private static readonly lockContext = new AsyncLocalStorage<readonly OriginalUpdateLockOwner[]>();
  private static createLockOwner(file: string): OriginalUpdateLockOwner { return new AsyncUpdateLockOwner(file); }
  private assertLock() { for (const owner of ConnectorUpdateService.lockContext.getStore() ?? []) owner.assertHeld(); }
  private maintenanceLifecycle: (() => AdmissionPause | AsyncMaintenancePause) | undefined;
  constructor(private readonly config: ServerConfig, private readonly commands?: UpdatePersistence) {}
  maintenanceAtStartup(): MaintenanceFence | undefined {
    if (this.commands?.asynchronous) throw new Error('async maintenance startup inspection required');
    let text: string;
    try { text = readFileSync(this.config.connector.updateStateFile, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { lstatSync(this.config.connector.updateStateFile); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return; }
      }
      throw new Error('cannot inspect maintenance journal before startup', { cause: error });
    }
    let state: unknown;
    try { state = JSON.parse(text); } catch { throw new Error('invalid maintenance journal before startup'); }
    if (!isUpdateState(state) || !isSelection((state as State).selection)) throw new Error('invalid maintenance journal before startup');
    const fence = state.maintenance;
    const original = fence ? this.commands?.receipts.get(fence.command.scope, fence.command.key) : undefined;
    if (original && typeof (original as Promise<CommandReceipt>).then === 'function') throw new Error('async maintenance startup inspection required');
    const receipt = original as CommandReceipt | undefined;
    if (fence && (fence.nodeId !== this.commands?.nodeId
      || fence.command.scope !== this.maintenanceScope(fence.actorId, fence.command.operation)
      || receipt?.id !== fence.command.id)) throw new Error('maintenance journal identity mismatch; reconcile before startup or mutation');
    return fence?.state === 'released' && receipt?.state !== 'accepted' ? { ...fence, state: 'resuming' } : fence;
  }
  async maintenanceAtStartupAsync(): Promise<MaintenanceFence | undefined> {
    const state = await this.readState(false);
    await this.requireMaintenance(state);
    return this.effectiveMaintenance(state.maintenance);
  }
  bindMaintenanceLifecycle(pause: () => AdmissionPause, restored?: MaintenanceFence) {
    if (this.maintenanceLifecycle) throw new Error('maintenance lifecycle already bound');
    this.maintenanceLifecycle = pause;
    if (restored && restored.state !== 'released') pause();
  }
  bindAsyncMaintenanceLifecycle(pause: () => AsyncMaintenancePause, restored?: MaintenanceFence) {
    if (!this.commands?.asynchronous) throw new Error('async maintenance lifecycle requires async persistence');
    if (this.maintenanceLifecycle) throw new Error('maintenance lifecycle already bound');
    this.maintenanceLifecycle = pause;
    if (restored && restored.state !== 'released') pause();
  }
  async maintenanceStatus(authorize?: Authorize) {
    await this.checkAuthority(authorize);
    const state = await this.readState(false);
    await this.checkAuthority(authorize);
    await this.requireMaintenance(state);
    return this.publicMaintenance(await this.effectiveMaintenance(state.maintenance));
  }
  /** Permit a bounded business projection probe while execution stays fenced.
   * Hold the same cross-process lock as resume/update, so a probe cannot race
   * the release of its original actor's fence. This does NOT release admission.
   */
  async withMaintenanceProbe<T>(actor: string, fenceId: string, authorize: Authorize, probe: () => Promise<T>): Promise<T> {
    this.maintenanceScope(actor, 'pause');
    if (typeof fenceId !== 'string' || !/^[a-f0-9-]{36}$/.test(fenceId)) throw new CommandConflict('Invalid maintenance fence');
    return this.withMutationLock('maintenance', async () => {
      const state = await this.readState(false);
      await this.checkAuthority(authorize); await this.requireMaintenance(state);
      const fence = await this.effectiveMaintenance(state.maintenance);
      if (!fence || fence.state !== 'paused' || fence.id !== fenceId || fence.actorId !== actor
        || (await this.commands!.receipts.get(fence.command.scope, fence.command.key))?.state !== 'accepted'
        || !this.maintenanceLifecycle) throw new CommandConflict('Original paused maintenance fence required');
      await this.maintenanceLifecycle().drained;
      await this.checkAuthority(authorize);
      const result = await probe();
      await this.checkAuthority(authorize);
      return result;
    }, authorize);
  }
  async maintenanceCommand(actor: string, operation: MaintenanceOperation, key: string, authorize?: Authorize) {
    await this.checkAuthority(authorize);
    const scope = this.maintenanceScope(actor, operation);
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new CommandConflict('Invalid command key');
    const receipt = (await this.commands!.receipts.get(scope, key));
    if (!receipt || receipt.state !== 'outcome_unknown') return receipt;
    try {
      await this.withMutationLock('maintenance', async () => {
        const state = await this.readState(false);
        await this.checkAuthority(authorize);
        await this.requireMaintenance(state);
        const fence = await this.effectiveMaintenance(state.maintenance);
        if (!fence || fence.command.scope !== scope || fence.command.key !== key || fence.command.id !== receipt.id) return;
        if (fence.state !== 'released') {
          if (!this.maintenanceLifecycle) return;
          await this.maintenanceLifecycle().drained;
        }
        await this.checkAuthority(authorize);
        if (fence.state === 'resuming') {
          fence.state = 'paused';
          fence.resumeInterrupted = true;
          await this.savePrivate({ ...state, maintenance: fence });
        }
        await syncUpdateJournal(this.config.connector.updateStateFile);
        await this.checkAuthority(authorize);
        await this.settleMaintenance(fence);
      }, authorize);
    } catch (error) { if (!(error instanceof UpdateBusyError)) throw error; }
    await this.checkAuthority(authorize);
    return (await this.commands!.receipts.get(scope, key));
  }
  async changeMaintenance(actor: string, operation: MaintenanceOperation, key: unknown, expectedFence?: unknown, authorize?: Authorize) {
    const scope = this.maintenanceScope(actor, operation);
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)
      || (operation === 'resume' && (typeof expectedFence !== 'string' || !/^[a-f0-9-]{36}$/.test(expectedFence)))
      || (operation === 'pause' && expectedFence !== undefined)) throw new CommandConflict('Invalid maintenance request');
    if (!this.maintenanceLifecycle) throw new Error('maintenance lifecycle is unavailable');
    await this.checkAuthority(authorize);
    const payload = operation === 'pause' ? {} : { fenceId: expectedFence };
    if ((await this.commands!.receipts.get(scope, key))) {
      await this.commands!.receipts.claim(scope, key, payload);
      return (await this.maintenanceCommand(actor, operation, key, authorize))!;
    }
    return this.withMutationLock('maintenance', async () => {
      const state = await this.readState(true, authorize);
      await this.checkAuthority(authorize);
      await this.requireMaintenance(state);
      const previous = await this.effectiveMaintenance(state.maintenance);
      if (operation === 'pause' ? previous && previous.state !== 'released'
        : !previous || previous.state === 'released' || previous.id !== expectedFence || previous.actorId !== actor) {
        throw new CommandConflict('Maintenance fence identity or state conflict');
      }
      if (previous && (await this.commands!.receipts.get(previous.command.scope, previous.command.key))?.state !== 'accepted') {
        throw new CommandConflict('Original maintenance command must be reconciled first');
      }
      const { fresh, receipt } = await this.commands!.receipts.claimAsync(scope, key, payload,
        false, undefined, undefined, undefined, false, this.transactionGuard(authorize));
      this.assertLock();
      await this.checkAuthority(authorize); // Recheck the caller's Promise delivery before changing the maintenance fence.
      if (!fresh) return receipt;
      const fence: MaintenanceFence = { version: 1, nodeId: this.commands!.nodeId, actorId: actor,
        id: operation === 'pause' ? receipt.id : previous!.id, state: operation === 'pause' ? 'paused' : 'resuming',
        command: { scope, key, id: receipt.id, operation } };
      const pending = { ...state, maintenance: fence };
      try { await this.savePrivate(pending, authorize); }
      catch (error) { this.maintenanceLifecycle!(); throw error; }
      const lease = this.maintenanceLifecycle!();
      await lease.drained;
      await this.checkAuthority(authorize);
      if (operation === 'resume') {
        fence.state = 'released';
        try {
          await this.savePrivate({ ...pending, maintenance: fence }, authorize);
          // In worker mode settlement yields. Keep admission fenced until the
          // release intent is durable, then recheck the original operator.
          if (this.commands?.asynchronous) await this.settleMaintenance(fence);
          await this.checkAuthority(authorize);
          this.assertLock();
          const resumed = 'asynchronous' in lease
            ? await lease.resume(() => this.checkAuthority(authorize), () => this.assertLock())
            : lease.resume();
          if (resumed !== true) throw new Error('Maintenance cannot resume during shutdown');
          if (!this.commands?.asynchronous) await this.settleMaintenance(fence);
        } catch (error) {
          if (this.commands?.asynchronous) {
            // A settled release intent is not proof that local admission was
            // released. Restore the conservative fence without replaying it.
            let drainFailure: unknown;
            try { await this.maintenanceLifecycle!().drained; }
            catch (failure) { drainFailure = failure; }
            fence.state = 'paused'; fence.resumeInterrupted = true;
            await this.savePrivate({ ...pending, maintenance: fence });
            if (drainFailure !== undefined) throw new AggregateError([error, drainFailure],
              'Maintenance resume failed; recovery fence persisted but drain remains unconfirmed');
          } else if ((await this.commands!.receipts.get(scope, key))?.state !== 'accepted') this.maintenanceLifecycle!();
          throw error;
        }
      } else await this.settleMaintenance(fence);
      await this.checkAuthority(authorize);
      return (await this.commands!.receipts.get(scope, key))!;
    }, authorize);
  }
  private maintenanceScope(actor: string, operation: MaintenanceOperation) {
    if (!this.commands) throw new Error('maintenance command receipts are not configured');
    if (typeof actor !== 'string' || !actor || !['pause', 'resume'].includes(operation)) throw new CommandConflict('Invalid maintenance actor or operation');
    const scope = JSON.stringify(['maintenance', JSON.stringify([this.commands.nodeId, actor, operation])]);
    if (Buffer.byteLength(scope) > 4096) throw new CommandConflict('Invalid command scope');
    return scope;
  }
  private async requireMaintenance(state: StableState) {
    this.assertLock();
    const fence = state.maintenance;
    if (!fence) return;
    if (fence.nodeId !== this.commands?.nodeId || fence.command.scope !== this.maintenanceScope(fence.actorId, fence.command.operation)
      || (await this.commands?.receipts.get(fence.command.scope, fence.command.key))?.id !== fence.command.id) {
      throw new Error('maintenance journal identity mismatch; reconcile before startup or mutation');
    }
  }
  private publicMaintenance(fence?: MaintenanceFence) {
    return { state: fence?.state ?? 'released', ...(fence ? { fenceId: fence.id } : {}),
      boundary: 'admission_only', nativeQuiescent: false };
  }
  private async effectiveMaintenance(fence?: MaintenanceFence): Promise<MaintenanceFence | undefined> {
    if (fence?.state === 'released'
      && (await this.commands!.receipts.get(fence.command.scope, fence.command.key))?.state !== 'accepted') {
      return { ...fence, state: 'resuming' };
    }
    return fence;
  }
  private async settleMaintenance(fence: MaintenanceFence) {
    this.assertLock();
    if (fence.state === 'resuming') return;
    const receipt = await this.commands!.receipts.settle(fence.command.scope, fence.command.key,
      { status: 200, body: { ...this.publicMaintenance(fence),
        ...(fence.resumeInterrupted ? { resumeInterrupted: true } : {}) } });
    if (receipt.state !== 'accepted') throw new Error('maintenance result could not be persisted');
  }
  async applyCommand(actor: string, body: ApplyRequest, authorize?: Authorize) {
    if (typeof body.version !== 'string' || !safeSegment(body.version)
      || (body.revision !== undefined && (typeof body.revision !== 'string' || !safeSegment(body.revision)))
      || typeof body.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.manifestSha256)) throw new CommandConflict('Invalid update request');
    const payload = { version: body.version, ...(body.revision === undefined ? {} : { revision: body.revision }), manifestSha256: body.manifestSha256 };
    return this.executeCommand(actor, 'apply', body.idempotencyKey, payload, state => this.applyLocked(payload, state, authorize), authorize);
  }
  async rollbackCommand(actor: string, key: unknown, authorize?: Authorize) {
    return this.executeCommand(actor, 'rollback', key, {}, state => this.rollbackLocked(state, authorize), authorize);
  }
  async command(actor: string, operation: 'apply' | 'rollback', key: string, authorize?: Authorize) {
    await this.checkAuthority(authorize);
    const scope = this.commandScope(actor, operation);
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new CommandConflict('Invalid command key');
    const receipt = (await this.commands!.receipts.get(scope, key));
    if (!receipt || receipt.state !== 'outcome_unknown' || !this.config.connector.updateEnabled) return receipt;
    try {
      await this.withMutationLock('status', async () => {
        const state = await this.readState(false);
        await this.checkAuthority(authorize);
        if (state.updateCommand?.scope === scope && state.updateCommand.key === key && state.updateCommand.id === receipt.id
          && (state.selection || !isInProgress(state))) await this.readState(true, authorize);
      }, authorize);
    } catch (error) { if (!(error instanceof UpdateBusyError)) throw error; }
    await this.checkAuthority(authorize);
    return (await this.commands!.receipts.get(scope, key));
  }
  private commandScope(actor: string, operation: 'apply' | 'rollback') {
    if (!this.commands) throw new Error('update command receipts are not configured');
    if (typeof actor !== 'string' || !actor || !['apply', 'rollback'].includes(operation)) throw new CommandConflict('Invalid update actor or operation');
    const scope = JSON.stringify(['update', JSON.stringify([this.commands.nodeId, actor, operation])]);
    if (Buffer.byteLength(scope) > 4096) throw new CommandConflict('Invalid command scope');
    return scope;
  }
  private async executeCommand(actor: string, operation: 'apply' | 'rollback', key: unknown, payload: unknown, run: (state: State) => Promise<ConnectorUpdateStatus>, authorize?: Authorize) {
    const scope = this.commandScope(actor, operation);
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new CommandConflict('Invalid command key');
    if (Buffer.byteLength(JSON.stringify(payload)) > 8192) throw new CommandConflict('Update request is too large');
    if (!this.config.connector.updateEnabled) throw new Error('connector updates are disabled');
    const guard = this.mutationAuthority(authorize);
    await guard();
    if ((await this.commands!.receipts.get(scope, key))) {
      await this.commands!.receipts.claim(scope, key, payload); // Check the original fingerprint, even while a writer owns the release lock.
      return (await this.command(actor, operation, key, guard))!;
    }
    return this.withMutationLock(operation, async () => {
      const { fresh, receipt } = await this.commands!.receipts.claimAsync(scope, key, payload,
        false, undefined, undefined, undefined, false, this.transactionGuard(authorize));
      await guard(); // A committed claim alone never authorizes journal writes or release selection.
      if (!fresh) {
        // Only the original journal may complete this receipt. Never redispatch unknown work.
        if (receipt.state === 'outcome_unknown') {
          const state = await this.readState(false);
          await guard();
          if (state.updateCommand?.scope === scope && state.updateCommand.key === key && state.updateCommand.id === receipt.id
            && (state.selection || !isInProgress(state))) await this.readState(true, guard);
        }
        return (await this.commands!.receipts.get(scope, key))!;
      }
      let previous: State;
      try { previous = await this.readState(true, guard); await guard(); }
      catch (error) {
        if (!(error instanceof UpdateAuthorizationError)) throw error;
        return await this.commands!.receipts.settle(scope, key, { status: 403, body: { error: error.message } });
      }
      const state = { ...previous, updateCommand: { scope, key, id: receipt.id } };
      // Claim precedes every side effect; correlate before downloads and selection.
      await this.savePrivate({ ...state, state: 'checking' }, guard);
      await run(state);
      return (await this.commands!.receipts.get(scope, key))!;
    }, guard);
  }
  async status(recover = true, authorize?: Authorize): Promise<ConnectorUpdateStatus> {
    await this.checkAuthority(authorize);
    const state = await this.readState(false);
    await this.checkAuthority(authorize);
    if (!recover || !this.config.connector.updateEnabled || (!state.selection && !isInProgress(state)
      && !ConnectorUpdateService.lockRecovery.hasPending())) return this.publicState(state);
    // Polls may read progress, but must not recover a selection while its writer is active.
    try { return await this.withMutationLock('status', async () => this.publicState(await this.readState(this.config.connector.updateEnabled, authorize)), authorize); }
    catch (error) {
      if (!(error instanceof UpdateBusyError)) throw error;
      const latest = await this.readState(false);
      await this.checkAuthority(authorize);
      return this.publicState(latest);
    }
  }
  async check(channel: 'stable' | 'candidate' = this.config.connector.updateChannel === 'candidate' ? 'candidate' : 'stable', authorize?: Authorize) {
    const guard = this.mutationAuthority(authorize);
    return this.withMutationLock('check', async () => {
    const state = await this.readState(true, guard);
    await guard();
    if (!this.config.connector.updateEnabled || !this.config.connector.updateManifestUrl) return this.save({ ...state, supported: false, state: 'failed', lastError: 'update manifest is not configured', updatedAt: Date.now() });
    const { manifest, hash } = await this.fetchManifest();
    await guard();
    const entry = manifest.find((item) => (item.channel ?? 'stable') === channel) ?? manifest[0];
    if (!entry) return this.save({ ...state, state: 'idle', updatedAt: Date.now() });
    return this.save({ ...state, supported: true, channel, state: entry.version === state.currentVersion && (!entry.revision || entry.revision === state.currentRevision) ? 'idle' : 'available', targetVersion: entry.version, targetRevision: entry.revision, manifestSha256: hash, updatedAt: Date.now() });
    }, guard);
  }
  async apply(body: ApplyRequest, authorize?: Authorize) {
    const payload = { ...body };
    const guard = this.mutationAuthority(authorize);
    return this.withMutationLock('apply', async () => this.applyLocked(payload, await this.readState(true, guard), guard), guard);
  }
  private async applyLocked(body: ApplyRequest, state: State, authorize?: Authorize) {
    const { targetVersion: _version, targetRevision: _revision, ...previous } = state;
    const denied: State = { ...previous, ...(typeof body.version === 'string' ? { targetVersion: body.version } : {}),
      ...(typeof body.revision === 'string' ? { targetRevision: body.revision } : {}) };
    return this.authorizedOperation(denied, authorize, guard => this.install(body, state, guard));
  }
  private async install(body: ApplyRequest, state: State, guard: Authorize) {
    const version = typeof body.version === 'string' ? body.version : '';
    const revision = typeof body.revision === 'string' ? body.revision : undefined;
    const expectedHash = typeof body.manifestSha256 === 'string' ? body.manifestSha256 : '';
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
    if (!state.updateCommand && idempotencyKey && state.lastIdempotencyKey === idempotencyKey && state.targetVersion === version) return this.publicState(state);
    if (!safeSegment(version) || (revision && !safeSegment(revision))) return this.save({ ...state, state: 'failed', lastError: 'invalid release identifier', updatedAt: Date.now() });
    if (!this.config.connector.installRoot || !this.config.connector.currentSymlink) return this.save({ ...state, state: 'failed', lastError: 'install root/current symlink is not configured', updatedAt: Date.now() });
    let downloaded: Awaited<ReturnType<ConnectorUpdateService['fetchManifest']>>;
    try { downloaded = await this.fetchManifest(); }
    catch (error) {
      if (!state.updateCommand) throw error;
      return this.save({ ...state, state: 'failed', lastError: 'manifest download failed', updatedAt: Date.now() });
    }
    const { manifest, hash } = downloaded;
    await guard();
    if (hash !== expectedHash) return this.save({ ...state, state: 'failed', lastError: 'manifest hash mismatch', updatedAt: Date.now(), lastAttemptAt: Date.now() });
    const entry = manifest.find((item) => item.version === version && (revision ? item.revision === revision : true));
    if (!entry) return this.save({ ...state, state: 'failed', lastError: 'requested version is not in trusted manifest', updatedAt: Date.now(), lastAttemptAt: Date.now() });
    if (state.currentVersion === version && (!revision || state.currentRevision === revision)) return this.save({ ...state, state: 'succeeded', targetVersion: version, targetRevision: revision, lastSuccessAt: Date.now(), updatedAt: Date.now() });
    state = await this.savePrivate({ ...state, state: 'downloading', targetVersion: version, targetRevision: revision, lastIdempotencyKey: idempotencyKey, lastAttemptAt: Date.now(), updatedAt: Date.now() }, guard);
    await guard();
    let buffer: Buffer;
    try {
      if (entry.size !== undefined && (entry.size < 0 || entry.size > ARTIFACT_DOWNLOAD.maxBytes)) throw new Error();
      buffer = await downloadUpdate(entry.artifactUrl, { ...ARTIFACT_DOWNLOAD, maxBytes: entry.size ?? ARTIFACT_DOWNLOAD.maxBytes });
    } catch {
      return this.save({ ...state, state: 'failed', lastError: 'artifact download failed', updatedAt: Date.now() });
    }
    await guard();
    if (typeof entry.size === 'number' && buffer.length !== entry.size) return this.save({ ...state, state: 'failed', lastError: 'artifact size mismatch', updatedAt: Date.now() });
    state = await this.savePrivate({ ...state, state: 'verifying', updatedAt: Date.now() }, guard);
    if (createHash('sha256').update(buffer).digest('hex') !== entry.sha256) return this.save({ ...state, state: 'failed', lastError: 'artifact hash mismatch', updatedAt: Date.now() });
    state = await this.savePrivate({ ...state, state: 'installing', updatedAt: Date.now() }, guard);
    const releaseDir = resolve(this.config.connector.installRoot, `releases/${version}-${revision ?? 'no-rev'}`);
    let created = false;
    let selectionAttempted = false;
    try {
      const previous = await readCurrentTarget(this.config.connector.currentSymlink);
      if (previous === releaseDir) throw new Error('refusing to replace active release path');
      await guard();
      await mkdir(dirname(releaseDir), { recursive: true });
      await guard();
      // Exclusive reservation: never remove or replace an existing release, even an empty one.
      await mkdir(releaseDir);
      created = true;
      const directories = await extractTar(buffer, releaseDir, guard);
      await validateReleaseLayout(releaseDir, entry.entrypoint);
      for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
        await guard();
        await syncUpdateDirectory(directory);
      }
      await guard();
      await syncUpdateParents(releaseDir);
      await guard();
      selectionAttempted = true;
      const previousRelease = state.selectedRelease?.path === previous ? state.selectedRelease : undefined;
      const result = await this.selectRelease(state, previous, releaseDir, { ...state, state: 'succeeded', currentVersion: version, currentRevision: revision, selectedRelease: { path: releaseDir, version, revision, ...(entry.entrypoint === undefined ? {} : { entrypoint: entry.entrypoint }) }, previousSymlinkTarget: previous, previousRelease, rollbackAvailable: Boolean(previousRelease), restartRequired: true, lastError: undefined, lastSuccessAt: Date.now(), updatedAt: Date.now() }, guard);
      if (result.state === 'failed') { this.assertLock(); await rm(releaseDir, { recursive: true, force: true }); }
      return result;
    } catch (error) {
      // An unresolved selection must keep both its journal and release for recovery.
      if (selectionAttempted) throw error;
      if (created) {
        // Owner loss must not turn a stale updater into an unlocked cleanup
        // writer. Retain the unselected release and original journal instead.
        try { this.assertLock(); await rm(releaseDir, { recursive: true, force: true }); } catch { /* Retain for inspection. */ }
      }
      return this.save({ ...state, state: 'failed', lastError: error instanceof Error ? error.message : 'install failed', updatedAt: Date.now() });
    }
  }
  async rollback(authorize?: Authorize) {
    const guard = this.mutationAuthority(authorize);
    return this.withMutationLock('rollback', async () => this.rollbackLocked(await this.readState(true, guard), guard), guard);
  }
  private async rollbackLocked(state: State, authorize?: Authorize) {
    return this.authorizedOperation(state, authorize, guard => this.revert(state, guard));
  }
  private async revert(state: State, guard: Authorize) {
    if (state.state === 'rolled_back' && !state.rollbackAvailable) return this.save(state);
    if (!state.previousSymlinkTarget || !this.config.connector.currentSymlink) return this.save({ ...state, state: 'failed', lastError: 'no previous known-good release', updatedAt: Date.now() });
    if (!state.previousRelease) throw new Error('previous release version is unknown; reconcile before rollback');
    const before = await readCurrentTarget(this.config.connector.currentSymlink);
    if (!before || state.selectedRelease?.path !== before) throw new Error('current release differs from recorded selection; reconcile before rollback');
    const after = resolve(dirname(this.config.connector.currentSymlink), state.previousSymlinkTarget);
    return this.selectRelease(state, before, after, { ...state, state: 'rolled_back', currentVersion: state.previousRelease.version, currentRevision: state.previousRelease.revision, selectedRelease: { ...state.previousRelease, path: after }, previousRelease: undefined, previousSymlinkTarget: undefined, rollbackAvailable: false, restartRequired: true, lastError: undefined, updatedAt: Date.now() }, guard);
  }
  private async checkAuthority(authorize?: Authorize): Promise<void> {
    if (!this.commands?.asynchronous) synchronousEffectAuthority(authorize, () => new UpdateAuthorizationError());
    else {
      if (!authorize) throw new UpdateAuthorizationError();
      await authorize();
    }
    this.assertLock();
  }
  private transactionGuard(authorize?: Authorize): () => void {
    return () => {
      this.assertLock();
      if (!this.commands?.asynchronous) synchronousEffectAuthority(authorize, () => new UpdateAuthorizationError());
    };
  }
  private mutationAuthority(authorize?: Authorize): Authorize {
    if (this.commands?.asynchronous) return async () => {
      if (!this.config.connector.updateEnabled) throw new UpdateAuthorizationError();
      this.assertLock();
      try { await this.checkAuthority(authorize); } catch { throw new UpdateAuthorizationError(); }
    };
    return () => {
      if (!this.config.connector.updateEnabled) throw new UpdateAuthorizationError();
      this.assertLock();
      try { synchronousEffectAuthority(authorize, () => new UpdateAuthorizationError()); } catch { throw new UpdateAuthorizationError(); }
    };
  }
  private async authorizedOperation(state: State, authorize: Authorize | undefined, run: (guard: Authorize) => Promise<ConnectorUpdateStatus>) {
    const guard = this.mutationAuthority(authorize);
    try { await guard(); return await run(guard); }
    catch (error) {
      if (!(error instanceof UpdateAuthorizationError)) throw error;
      // Revocation stops future selection, not recording the original request's known failure.
      return this.save({ ...state, state: 'failed', lastError: error.message, updatedAt: Date.now() });
    }
  }
  private async withMutationLock<T>(operation: string, fn: () => Promise<T>, authorize?: Authorize): Promise<T> {
    if (operation !== 'status' && operation !== 'maintenance' && !this.config.connector.updateEnabled) throw new Error('connector updates are disabled');
    const guard = operation === 'status' || operation === 'maintenance' ? () => this.checkAuthority(authorize) : this.mutationAuthority(authorize);
    await guard();
    const paths = [this.config.connector.updateStateFile + '.lock'];
    if (this.config.connector.installRoot) paths.push(join(this.config.connector.installRoot, '.agentopsdeck-update.lock'));
    const held: string[] = [];
    const databases: OriginalUpdateLockOwner[] = [];
    const trace = guardedTrace(performanceDiagnostics, 'update-mutation-lock');
    let completed = false, failed = true, step = 1, admitted = false, unknown = false;
    const queuedAt = performance.now();
    const warning = setTimeout(() => trace.reportPending({ pending: 1, step, records: held.length, admitted: Number(admitted) }), 30_000);
    warning.unref();
    try {
      for (const file of paths.sort()) {
        await guard();
        await mkdir(dirname(file), { recursive: true });
        const canonical = join(await realpath(dirname(file)), basename(file));
        const key = ConnectorUpdateService.lockPathKey(canonical);
        if (held.includes(key)) continue;
        // Retry only cleanup of quiescent original owners, never the update.
        if (!await ConnectorUpdateService.lockRecovery.recover(key)) throw new Error('connector update lock cleanup pending; inspect the original update journal');
        await guard();
        // Do not open a second same-process fd: closing it can release POSIX locks.
        if (ConnectorUpdateService.locks.has(key)) throw new UpdateBusyError();
        const existing = await lstat(canonical).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
        await guard();
        if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('update lock must be a private regular file, not an alias');
        // lstat awaited above; another local updater may have acquired this path meanwhile.
        if (ConnectorUpdateService.locks.has(key)) throw new UpdateBusyError();
        ConnectorUpdateService.locks.add(key); held.push(key);
        const db = ConnectorUpdateService.createLockOwner(canonical); databases.push(db);
        // Lock-only files: no schema, domain facts, lease expiry, or extra dependency.
        // Keep these files in place; replacing/unlinking a lock inode breaks exclusion.
        await db.acquire();
        db.assertHeld();
      }
      await guard();
      for (const db of databases) db.assertHeld();
      trace.add('queueMs', performance.now() - queuedAt);
      step = 2; admitted = true;
      const bodyAt = performance.now();
      let result: T;
      try {
        result = await ConnectorUpdateService.lockContext.run(databases, fn);
        for (const db of databases) db.assertHeld();
      }
      finally { trace.add('bodyMs', performance.now() - bodyAt); }
      completed = true;
      failed = false;
      return result;
    } catch (error) {
      // A body failure is not pre-admission contention: upper layers may ignore
      // busy errors. Preserve its identity and unknown effect without inspecting
      // arbitrary rejection values (including revoked proxies).
      if (admitted) unknown = true;
      else {
        let busy = false, ownBusy = false;
        try {
          ownBusy = error instanceof UpdateBusyError;
          if (ownBusy || error instanceof UpdateLockBusy) busy = true;
          else if (error && typeof error === 'object' && 'code' in error) {
            const code = error.code;
            if (code === 'ERR_SQLITE_ERROR' && 'errcode' in error) {
              const result = error.errcode;
              busy = typeof result === 'number' && Number.isSafeInteger(result) && result >= 0
                && ((result & 255) === 5 || (result & 255) === 6);
            }
          }
        } catch { trace.add('classificationUnknown', 1); }
        if (busy) {
          trace.add('busy', 1);
          if (!ownBusy) throw new UpdateBusyError();
        }
      }
      throw error;
    } finally {
      step = 3;
      const releaseAt = performance.now();
      try {
        const cleanup = new AsyncUpdateLockCleanup(databases, () => {
          for (const key of held) ConnectorUpdateService.locks.delete(key);
        });
        const closed = await cleanup.run();
        if (!closed) {
          failed = true; unknown = true;
          ConnectorUpdateService.lockRecovery.retain(held, cleanup);
        } else trace.add('settled', 1);
        // Preserve an original failure. A completed callback followed by unknown
        // cleanup must not be presented as an entirely clean operation.
        if (!closed && completed) throw new Error('connector update lock owner unavailable; inspect the original update journal');
      } catch (error) { failed = true; throw error; }
      finally {
        if (!admitted) trace.add('queueMs', performance.now() - queuedAt);
        if (unknown) trace.add('unknown', 1);
        trace.add('records', held.length); trace.add('admitted', Number(admitted)); trace.add('step', step);
        trace.add('releaseMs', performance.now() - releaseAt);
        clearTimeout(warning); trace.finish(failed);
      }
    }
  }
  private async fetchManifest(): Promise<{ manifest: ManifestEntry[]; hash: string }> {
    if (!this.config.connector.updateManifestUrl) throw new Error('update manifest is not configured');
    const bytes = await downloadUpdate(this.config.connector.updateManifestUrl, MANIFEST_DOWNLOAD);
    const text = new TextDecoder().decode(bytes);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('invalid update manifest'); }
    const entries = Array.isArray(parsed?.releases) ? parsed.releases : Array.isArray(parsed) ? parsed : [];
    return { manifest: entries.filter(isManifestEntry), hash: createHash('sha256').update(text).digest('hex') };
  }
  private async readState(recover = true, authorize?: Authorize): Promise<State> {
    const base: State = { supported: this.config.connector.updateEnabled, currentVersion: this.config.connector.version, currentRevision: this.config.connector.revision, channel: this.config.connector.updateChannel, state: 'idle', rollbackAvailable: false, updatedAt: Date.now() };
    let text: string;
    try { text = await readFile(this.config.connector.updateStateFile, 'utf8'); }
    catch (error) {
      // Only a missing file is a first install; dangling links and read failures need repair.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && await lstat(this.config.connector.updateStateFile).then(() => false, (failure: NodeJS.ErrnoException) => failure.code === 'ENOENT')) return base;
      throw new Error('cannot read connector update state; repair it before updating', { cause: error });
    }
    let stored: unknown;
    try { stored = JSON.parse(text); } catch (error) { throw new Error('invalid connector update state; repair it before updating', { cause: error }); }
    if (!isUpdateState(stored) || !isSelection((stored as State).selection)) throw new Error('invalid connector update state; repair it before updating');
    // A persisted selection owns its metadata; an absent revision is not the running binary's revision.
    const state = stored as State;
    if (!recover || !this.config.connector.updateEnabled) return state;
    await this.checkAuthority(authorize);
    await this.requireCommand(state);
    if (!state.selection) {
      if (isInProgress(state)) throw new Error('incomplete update has no selection record; reconcile before updating');
      if (state.updateCommand && !['succeeded', 'failed', 'rolled_back'].includes(state.state)) throw new Error('update command has no terminal result; reconcile before updating');
      if (state.updateCommand) {
        await syncUpdateJournal(this.config.connector.updateStateFile);
        await this.checkAuthority(authorize);
      }
      await this.settleCommand(state);
      return { ...state, updateCommand: undefined };
    }
    const selection = state.selection;
    if (!this.config.connector.currentSymlink || resolve(this.config.connector.currentSymlink) !== selection.link) throw new Error('pending selection belongs to a different current link; reconcile before updating');
    let current: string | undefined;
    try { current = await readCurrentTarget(selection.link); }
    catch (error) { throw new Error('cannot inspect pending release selection; reconcile before updating', { cause: error }); }
    if (current === selection.after) {
      await validateReleaseLayout(selection.after, selection.completed.selectedRelease?.entrypoint);
      await this.checkAuthority(authorize);
      if (!this.config.connector.updateEnabled) return state;
      await cleanSelectionLink(selection, () => this.assertLock());
      await syncUpdateDirectory(dirname(selection.link));
      await this.checkAuthority(authorize);
      if (!this.config.connector.updateEnabled) return state;
      await this.savePrivate(selection.completed);
      return { ...selection.completed, updateCommand: undefined };
    }
    if ((current ?? null) !== selection.before) throw new Error('current release differs from pending selection; reconcile before updating');
    await this.checkAuthority(authorize);
    if (!this.config.connector.updateEnabled) return state;
    await cleanSelectionLink(selection, () => this.assertLock());
    await syncUpdateDirectory(dirname(selection.link));
    await this.checkAuthority(authorize);
    if (!this.config.connector.updateEnabled) return state;
    const failed: State = { ...state, selection: undefined, state: 'failed', lastError: 'update interrupted before release selection; unselected release retained for inspection', updatedAt: Date.now() };
    await this.savePrivate(failed);
    return { ...failed, updateCommand: undefined };
  }
  private async selectRelease(state: State, before: string | undefined, after: string, completed: StableState, guard: Authorize) {
    const link = resolve(this.config.connector.currentSymlink!);
    await validateReleaseLayout(after, completed.selectedRelease?.entrypoint);
    await guard();
    const tmpLink = `${link}.next-${randomUUID()}`;
    const selection: Selection = { version: 1, link, temporaryLink: tmpLink, before: before ?? null, after, completed };
    // Persist the intended outcome before any link switch. Recovery observes; it never replays.
    await this.savePrivate({ ...state, state: 'installing', selection }, guard);
    let linkCreated = false;
    let selected = false;
    try {
      await guard();
      await symlink(after, tmpLink);
      linkCreated = true;
      if (await readCurrentTarget(link) !== before) throw new Error('current release changed before selection');
      await guard(); // Last authority check, immediately before dispatching the atomic switch.
      await rename(tmpLink, link);
      selected = true;
      await syncUpdateDirectory(dirname(link));
      return await this.save(completed);
    } catch (error) {
      this.assertLock(); // A lost owner cannot discard another owner's recovery evidence.
      if (selected || await readCurrentTarget(link) !== before) throw error;
      this.assertLock();
      if (linkCreated) { await unlink(tmpLink); linkCreated = false; }
      return this.save({ ...state, state: 'failed', lastError: error instanceof Error ? error.message : 'selection failed', updatedAt: Date.now() });
    } finally {
      if (linkCreated) {
        try { this.assertLock(); await unlink(tmpLink); }
        catch { /* Preserve the original selection evidence when ownership is unknown. */ }
      }
    }
  }
  private async save(state: State): Promise<ConnectorUpdateStatus> { await this.savePrivate(state); return this.publicState(state); }
  private async requireCommand(state: State) {
    this.assertLock();
    const command = state.updateCommand;
    const completed = state.selection?.completed.updateCommand;
    if (state.selection && (completed?.scope !== command?.scope || completed?.key !== command?.key || completed?.id !== command?.id)) throw new Error('selection command identity mismatch; reconcile before updating');
    if (!command) return;
    let identity: unknown;
    try { identity = JSON.parse(JSON.parse(command.scope)[1]); } catch { /* reject below */ }
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== this.commands?.nodeId
      || typeof identity[1] !== 'string' || !['apply', 'rollback'].includes(identity[2])
      || this.commandScope(identity[1], identity[2]) !== command.scope
      || (await this.commands?.receipts.get(command.scope, command.key))?.id !== command.id) throw new Error('update command identity mismatch; reconcile before updating');
    const result = state.selection?.completed ?? state;
    if (['succeeded', 'failed', 'rolled_back'].includes(result.state)
      && Buffer.byteLength(JSON.stringify({ status: 200, body: this.publicState(result) })) > MAX_COMMAND_RESULT_BYTES) throw new Error('update result exceeds receipt capacity; reconcile before updating');
  }
  private async settleCommand(state: State) {
    this.assertLock();
    if (!state.updateCommand || state.selection || !['succeeded', 'failed', 'rolled_back'].includes(state.state)) return;
    await this.requireCommand(state);
    const { scope, key } = state.updateCommand;
    // Accepted means the maintenance request has a durable result, not a healthy running version.
    if ((await this.commands!.receipts.settle(scope, key, { status: 200, body: { ...this.publicState(state) } })).state !== 'accepted') throw new Error('update result could not be persisted');
  }
  private async savePrivate(state: State, authorize?: Authorize): Promise<State> {
    this.assertLock();
    await this.requireMaintenance(state);
    await this.requireCommand(state);
    // Receipt reads cross the worker boundary. Recheck authority for new
    // intents, but never require it to record already known effects/failures.
    if (this.commands?.asynchronous && authorize) await this.checkAuthority(authorize);
    this.assertLock();
    await writeUpdateJournal(this.config.connector.updateStateFile, JSON.stringify(state, null, 2), () => this.assertLock());
    await this.settleCommand(state);
    return state;
  }
  private publicState(state: State): ConnectorUpdateStatus {
    const { maintenance: _m, updateCommand: _u, selectedRelease: _c, previousSymlinkTarget: _p,
      previousRelease: _r, lastIdempotencyKey: _i, selection: _s, ...safe } = state;
    // The original HTTP/journal JSON boundary omitted cleared optional fields.
    // Materialize that public wire shape BEFORE sending the result to the strict
    // worker port; do not relax authority/receipt serialization to allow undefined.
    return { ...Object.fromEntries(Object.entries(safe).filter(([, value]) => value !== undefined)),
      supported: this.config.connector.updateEnabled && safe.supported } as ConnectorUpdateStatus;
  }
}

function isManifestEntry(value: any): value is ManifestEntry { return value && typeof value.version === 'string' && typeof value.artifactUrl === 'string' && /^https:\/\//.test(value.artifactUrl) && typeof value.sha256 === 'string' && (value.size === undefined || Number.isSafeInteger(value.size)); }
function safeSegment(value: string) { return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..'); }
function isInProgress(state: State) { return ['checking', 'downloading', 'verifying', 'installing', 'restarting'].includes(state.state); }

async function requireReleaseDirectory(target: string) {
  if (!await lstat(target).then((stat) => stat.isDirectory(), () => false)) throw new Error('selection target is not an available release directory');
}

async function cleanSelectionLink(selection: Selection, assertOwner: () => void) {
  const target = await readCurrentTarget(selection.temporaryLink);
  assertOwner();
  if (target === undefined) return;
  if (target !== selection.after) throw new Error('temporary selection link changed; reconcile before updating');
  await unlink(selection.temporaryLink);
}

async function readCurrentTarget(link: string): Promise<string | undefined> {
  try { return resolve(dirname(link), await readlink(link)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function isUpdateState(value: unknown): value is StableState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.maintenance !== undefined && !isMaintenanceFence(state.maintenance)) return false;
  if (typeof state.supported !== 'boolean' || typeof state.currentVersion !== 'string' || typeof state.rollbackAvailable !== 'boolean' || typeof state.updatedAt !== 'number' || !Number.isFinite(state.updatedAt)) return false;
  if (!['idle', 'checking', 'available', 'downloading', 'verifying', 'installing', 'restarting', 'succeeded', 'failed', 'rolled_back'].includes(state.state as string)) return false;
  if (state.channel !== undefined && !['stable', 'candidate', 'manual'].includes(state.channel as string)) return false;
  if (state.restartRequired !== undefined && typeof state.restartRequired !== 'boolean') return false;
  if (state.updateCommand !== undefined) {
    const command = state.updateCommand as UpdateCommand | null;
    if (!command || typeof command.scope !== 'string' || Buffer.byteLength(command.scope) > 4096
      || typeof command.key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(command.key)
      || typeof command.id !== 'string' || !/^[a-f0-9-]{36}$/.test(command.id)) return false;
  }
  if (state.previousRelease !== undefined && !isReleaseIdentity(state.previousRelease)) return false;
  if (state.selectedRelease !== undefined) {
    if (!isReleaseIdentity(state.selectedRelease) || !('path' in state.selectedRelease) || typeof state.selectedRelease.path !== 'string' || !isAbsolute(state.selectedRelease.path)) return false;
    if (state.selectedRelease.version !== state.currentVersion || state.selectedRelease.revision !== state.currentRevision) return false;
  }
  if (['currentRevision', 'targetVersion', 'targetRevision', 'lastError', 'previousSymlinkTarget', 'lastIdempotencyKey', 'manifestSha256'].some((key) => state[key] !== undefined && typeof state[key] !== 'string')) return false;
  return ['lastAttemptAt', 'lastSuccessAt'].every((key) => state[key] === undefined || (typeof state[key] === 'number' && Number.isFinite(state[key])));
}

function isMaintenanceFence(value: unknown): value is MaintenanceFence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fence = value as MaintenanceFence;
  return fence.version === 1 && typeof fence.nodeId === 'string' && Boolean(fence.nodeId)
    && typeof fence.actorId === 'string' && Boolean(fence.actorId)
    && typeof fence.id === 'string' && /^[a-f0-9-]{36}$/.test(fence.id)
    && ['paused', 'resuming', 'released'].includes(fence.state)
    && Boolean(fence.command) && typeof fence.command.scope === 'string' && Buffer.byteLength(fence.command.scope) <= 4096
    && typeof fence.command.key === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(fence.command.key)
    && typeof fence.command.id === 'string' && /^[a-f0-9-]{36}$/.test(fence.command.id)
    && (fence.resumeInterrupted === undefined || fence.resumeInterrupted === true)
    && (fence.command.operation === 'pause' ? fence.state === 'paused' && fence.command.id === fence.id && !fence.resumeInterrupted
      : fence.command.operation === 'resume' && (fence.resumeInterrupted ? fence.state === 'paused' : ['resuming', 'released'].includes(fence.state)));
}

function isReleaseIdentity(value: unknown): value is ReleaseIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const release = value as Record<string, unknown>;
  return typeof release.version === 'string' && (release.revision === undefined || typeof release.revision === 'string')
    && (release.entrypoint === undefined || isReleaseEntrypoint(release.entrypoint));
}

function isSelection(value: unknown): value is Selection | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const selection = value as Selection;
  return selection.version === 1 && typeof selection.link === 'string' && isAbsolute(selection.link)
    && typeof selection.temporaryLink === 'string' && selection.temporaryLink.startsWith(`${selection.link}.next-`)
    && /^[a-f0-9-]{36}$/.test(selection.temporaryLink.slice(`${selection.link}.next-`.length))
    && (selection.before === null || (typeof selection.before === 'string' && isAbsolute(selection.before)))
    && typeof selection.after === 'string' && isAbsolute(selection.after)
    && isUpdateState(selection.completed) && (selection.completed as State).selection === undefined
    && selection.completed.selectedRelease?.path === selection.after
    && ['succeeded', 'rolled_back'].includes(selection.completed.state);
}

async function extractTar(buffer: Buffer, root: string, authorize: Authorize) {
  let files = 0;
  let totalBytes = 0;
  let ended = false;
  const directories = new Set([root]);
  const rememberDirectory = (directory: string) => {
    while (!directories.has(directory)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  };
  for (let offset = 0; offset + 512 <= buffer.length;) {
    await authorize();
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) { ended = true; break; }
    if (!validTarChecksum(header)) throw new Error('artifact tar header checksum mismatch');
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const fullName = normalize(prefix ? `${prefix}/${name}` : name);
    const sizeText = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim() || '0';
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('artifact tar entry has invalid size');
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('artifact tar entry has invalid size');
    const type = header.toString('utf8', 156, 157) || '0';
    offset += 512;
    if (offset + size > buffer.length) throw new Error('artifact tar payload is truncated');
    const target = resolve(root, fullName);
    if (relative(root, target).startsWith('..') || resolve(root) === target) throw new Error('artifact contains unsafe path');
    if (type === '2' || type === '1') throw new Error('artifact contains links');
    if (type === '5') {
      await mkdir(target, { recursive: true });
      rememberDirectory(target);
    }
    else if (type === '0' || type === '\0') {
      files += 1;
      totalBytes += size;
      if (files > 2000 || size > 100 * 1024 * 1024 || totalBytes > 250 * 1024 * 1024) throw new Error('artifact exceeds supported size limits');
      const data = buffer.subarray(offset, offset + size);
      await mkdir(dirname(target), { recursive: true });
      rememberDirectory(dirname(target));
      await authorize();
      const handle = await open(target, 'wx');
      try {
        await authorize();
        await handle.writeFile(data);
        await authorize();
        await handle.sync();
      } finally { await handle.close(); }
    } else throw new Error('artifact contains unsupported tar entry');
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) throw new Error('artifact tar payload is truncated');
  return directories;
}

function validTarChecksum(header: Buffer) {
  const raw = header.toString('utf8', 148, 156).replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(raw)) return false;
  const expected = Number.parseInt(raw, 8);
  let actual = 0;
  for (let i = 0; i < 512; i += 1) actual += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
  return actual === expected;
}

async function validateReleaseLayout(root: string, entrypoint?: string) {
  const expected = entrypoint === undefined ? 'dist/index.js' : entrypoint;
  if (!isReleaseEntrypoint(expected)) throw new Error('invalid entrypoint or entrypoint escapes release root');
  await requireReleaseDirectory(root);
  for (const [file, label] of [['package.json', 'package.json'], [expected, 'required entrypoint']] as const) {
    const segments = file.split('/');
    let target = root;
    for (const [index, segment] of segments.entries()) {
      target = join(target, segment);
      const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') throw new Error(`release is missing ${label}`);
        throw error;
      });
      if (index < segments.length - 1) {
        if (!stat.isDirectory()) throw new Error('release entrypoint parent must be a directory, not a link');
      } else if (!stat.isFile() || stat.nlink !== 1) throw new Error(`release ${label} must be a regular file without aliases`);
    }
  }
}

function isReleaseEntrypoint(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4096 && !/[\\\0]/.test(value)
    && value.split('/').every(segment => Boolean(segment) && segment !== '.' && segment !== '..')
    && !/^[A-Za-z]:/.test(value);
}

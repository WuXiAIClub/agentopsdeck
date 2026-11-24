import type { CommandReceipt, CompactSessionResponse, SendMessageResponse } from '@agentopsdeck/shared';
import { createCommandKey, readSessionSettingsResult, type SessionSettingsResult } from '@agentopsdeck/shared';
import { readConnectorAdmissionStatus, type ConnectorMaintenanceResult } from './maintenance-controls.js';

export class CommandOutcomeUnknownError extends Error {
  constructor(readonly commandKey: string) {
    super(`Delivery outcome unknown. The agent may already be running; this message was not resent. Command: ${commandKey}`);
  }
}
export class CommandRejectedError extends Error {}
export class CommandNotSubmittedError extends Error {}
export type QueueMutation = { messageId: string; action: 'edit' | 'cancel' };
export type CreationTarget = { connectionId: string; agentId: string; ownerUserId?: string };
export type MaintenanceTarget = { connectionId: string; operation: 'apply' | 'rollback' | 'pause' | 'resume' };
export type LifecycleTarget = { connectionId: string; operation: 'restart' | 'upgrade' };
export type PendingCommand = { scope: string; key: string; createdAt: number; state: 'outcome_unknown' | 'accepted' | 'rejected'; compact?: true; settingsStartReleased?: true } & (
  { sessionKey: string; queue?: QueueMutation; deletion?: true; settings?: true; creation?: never; maintenance?: never; lifecycle?: never }
  | { creation: CreationTarget; sessionKey?: never; queue?: never; deletion?: never; settings?: never; maintenance?: never; lifecycle?: never }
  | { maintenance: MaintenanceTarget; sessionKey?: never; queue?: never; deletion?: never; settings?: never; creation?: never; lifecycle?: never }
  | { lifecycle: LifecycleTarget; sessionKey?: never; queue?: never; deletion?: never; settings?: never; creation?: never; maintenance?: never });
type JournalStorage = Pick<Storage, 'getItem' | 'setItem'>;
const JOURNAL_KEY = 'agentopsdeck.command-recovery.v1';
const MAX_RECORDS = 128;
const MAX_BYTES = 1024 * 1024;

// Per-tab sessionStorage survives refresh without competing whole-ledger writes
// from other tabs. No input text, uploads, credentials or receipt bodies stored.
export class CommandJournal {
  constructor(private readonly storage: JournalStorage) {}

  private read(): PendingCommand[] {
    const raw = this.storage.getItem(JOURNAL_KEY);
    if (raw === null) return [];
    if (raw.length * 2 > MAX_BYTES) throw new Error('Saved command records exceed the size limit');
    let rows: unknown;
    try { rows = JSON.parse(raw); } catch { throw new Error('Saved command records are damaged; submission was not attempted'); }
    if (!Array.isArray(rows) || rows.length > MAX_RECORDS || rows.some((row) => !validRecord(row))) {
      throw new Error('Saved command records are invalid; submission was not attempted');
    }
    const identities = rows.map(commandIdentity);
    if (new Set(identities).size !== identities.length) throw new Error('Duplicate saved command records');
    return rows;
  }

  private write(rows: PendingCommand[]) {
    const raw = JSON.stringify(rows);
    if (rows.length > MAX_RECORDS || raw.length * 2 > MAX_BYTES) throw new Error('Command recovery storage is full; check existing deliveries before submitting');
    this.storage.setItem(JOURNAL_KEY, raw);
  }

  list(scope: string, sessionKey?: string, kind: 'message' | 'all' | 'creation' | 'maintenance' | 'lifecycle' = 'message') {
    return this.read().filter((row) => row.scope === scope && (sessionKey === undefined || row.sessionKey === sessionKey)
      && (kind === 'all' || (kind === 'lifecycle' ? !!row.lifecycle : kind === 'maintenance' ? !!row.maintenance : kind === 'creation' ? !!row.creation : !row.lifecycle && !row.maintenance && !row.creation && !row.queue && !row.deletion && !row.settings && !row.compact)));
  }

  begin(scope: string, sessionKey: string, key: string, control?: QueueMutation | 'delete' | 'settings' | 'compact') {
    const row: PendingCommand = { scope, sessionKey, key, createdAt: Date.now(), state: 'outcome_unknown',
      ...(control === 'compact' ? { compact: true as const } : control === 'delete' ? { deletion: true as const } : control === 'settings' ? { settings: true as const } : control ? { queue: control } : {}) };
    return this.append(row);
  }

  beginCreation(scope: string, creation: CreationTarget, key: string) {
    const row: PendingCommand = { scope, creation: { ...creation }, key, createdAt: Date.now(), state: 'outcome_unknown' };
    if (this.list(scope, undefined, 'creation').some(item => item.state === 'outcome_unknown'
      && item.creation?.connectionId === creation.connectionId && item.creation.agentId === creation.agentId
      && item.creation.ownerUserId === creation.ownerUserId)) {
      throw new Error('This agent has an unresolved session creation; check its receipt before creating another');
    }
    return this.append(row);
  }

  beginMaintenance(scope: string, maintenance: MaintenanceTarget, key: string) {
    if (this.list(scope, undefined, 'maintenance').some(item => item.state === 'outcome_unknown'
      && item.maintenance?.connectionId === maintenance.connectionId)) {
      throw new Error('This Connector has an unresolved maintenance command; check its original receipt first');
    }
    return this.append({ scope, maintenance: { ...maintenance }, key, createdAt: Date.now(), state: 'outcome_unknown' });
  }

  beginLifecycle(scope: string, lifecycle: LifecycleTarget, key: string) {
    // Accepted means admitted, not completed. Keep blocking until the UI has
    // observed terminal completion and explicitly dismissed the saved record.
    if (this.list(scope, undefined, 'lifecycle').some(row => row.lifecycle?.connectionId === lifecycle.connectionId)) {
      throw new Error('This Connector has an unresolved maintenance command; check its original receipt first');
    }
    return this.append({ scope, lifecycle: { ...lifecycle }, key, createdAt: Date.now(), state: 'outcome_unknown' });
  }

  private append(row: PendingCommand) {
    if (!validRecord(row)) throw new Error('Cannot safely identify this command; reload before submitting');
    const rows = this.read();
    if (rows.some((item) => sameCommand(item, row))) throw new Error('This command is already recorded; check its receipt instead of resending');
    this.write([...rows, row]); // Must succeed before the only mutation.
    return row;
  }

  settle(row: PendingCommand, state: 'accepted' | 'rejected') {
    this.write(this.read().map((item) => {
      if (!sameCommand(item, row)) return item;
      const { settingsStartReleased: _release, ...saved } = item;
      return { ...saved, state };
    }));
  }

  releaseSettingsStart(row: PendingCommand) {
    this.write(this.read().map(item => sameCommand(item, row) && item.settings && item.state === 'outcome_unknown'
      ? { ...item, settingsStartReleased: true as const } : item));
  }

  forget(row: PendingCommand) {
    this.write(this.read().filter((item) => !sameCommand(item, row)));
  }
}

function sameCommand(a: PendingCommand, b: PendingCommand) {
  return commandIdentity(a) === commandIdentity(b);
}

export function commandIdentity(row: PendingCommand) {
  return JSON.stringify([row.scope, row.lifecycle ? ['lifecycle', row.lifecycle.connectionId, row.lifecycle.operation]
    : row.maintenance ? ['maintenance', row.maintenance.connectionId, row.maintenance.operation]
    : row.creation ? ['create', row.creation.ownerUserId, row.creation.connectionId, row.creation.agentId] : row.sessionKey, row.key]);
}

export function lifecyclePath(target: LifecycleTarget) {
  if (!target || Object.keys(target).length !== 2 || !['restart', 'upgrade'].includes(target.operation)
    || typeof target.connectionId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(target.connectionId)) throw new Error('Invalid lifecycle target');
  return `/api/hub/v1/connections/${encodeURIComponent(target.connectionId)}/lifecycle/commands/${target.operation}`;
}

export function maintenancePath(target: MaintenanceTarget) {
  if (!target || Object.keys(target).length !== 2 || !['apply', 'rollback', 'pause', 'resume'].includes(target.operation)
    || typeof target.connectionId !== 'string' || !target.connectionId || target.connectionId.length > 512
    || target.connectionId === '.' || target.connectionId === '..' || /[\u0000-\u001f\u007f]/.test(target.connectionId)) throw new Error('Invalid maintenance target');
  return `/api/hub/v1/connections/${encodeURIComponent(target.connectionId)}/${['pause', 'resume'].includes(target.operation) ? 'maintenance' : 'update'}/commands/${target.operation}`;
}

export function creationPath(target: CreationTarget) {
  if (!target || Object.keys(target).some(key => !['connectionId', 'agentId', 'ownerUserId'].includes(key))
    || ![target.connectionId, target.agentId, ...(Object.hasOwn(target, 'ownerUserId') ? [target.ownerUserId] : [])].every(value =>
    typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '.' && value !== '..' && !/[\u0000-\u001f\u007f]/.test(value))
    || target.connectionId.includes(':')) throw new Error('Invalid session creation target');
  if (target.ownerUserId && target.agentId !== 'codex') throw new Error('Only Codex shared creation is supported');
  return `/api/hub/v1/${target.ownerUserId ? `shared/${encodeURIComponent(target.ownerUserId)}/` : ''}connections/${encodeURIComponent(target.connectionId)}/agents/${encodeURIComponent(target.agentId)}/sessions`;
}

function validRecord(value: unknown): value is PendingCommand {
  if (!value || typeof value !== 'object') return false;
  const row = value as PendingCommand;
  if (row.settingsStartReleased !== undefined && (row.settingsStartReleased !== true || row.settings !== true || row.state !== 'outcome_unknown')) return false;
  if (row.compact !== undefined && (row.compact !== true || row.queue || row.settings || row.deletion || row.creation || row.maintenance || row.lifecycle)) return false;
  if (row.lifecycle !== undefined) {
    try { lifecyclePath(row.lifecycle); } catch { return false; }
    return Object.keys(row).length === 5 && row.sessionKey === undefined && row.creation === undefined && row.maintenance === undefined
      && row.queue === undefined && row.deletion === undefined && row.settings === undefined && validBase(row);
  }
  if (row.maintenance !== undefined) {
    try { maintenancePath(row.maintenance); } catch { return false; }
    return Object.keys(row).length === 5 && row.sessionKey === undefined && row.creation === undefined
      && row.queue === undefined && row.deletion === undefined && row.settings === undefined && validBase(row);
  }
  if (row.creation !== undefined) {
    try { creationPath(row.creation); } catch { return false; }
    return Object.keys(row).length === 5 && row.sessionKey === undefined && row.queue === undefined && row.deletion === undefined && row.settings === undefined && validBase(row);
  }
  return Object.keys(row).length === (row.queue || row.deletion || row.settings || row.compact ? 6 : 5) + (row.settingsStartReleased ? 1 : 0)
    && (row.settings === undefined || (row.settings === true && row.queue === undefined && row.deletion === undefined))
    && (row.deletion === undefined || (row.deletion === true && row.queue === undefined))
    && (row.queue === undefined || (typeof row.queue === 'object' && row.queue !== null
    && Object.keys(row.queue).length === 2 && typeof row.queue.messageId === 'string' && row.queue.messageId.length > 0 && row.queue.messageId.length <= 512
    && ['edit', 'cancel'].includes(row.queue.action)))
    && typeof row.sessionKey === 'string' && row.sessionKey.length > 0 && row.sessionKey.length <= 4096
    && validBase(row);
}

function validBase(row: PendingCommand) {
  return typeof row.scope === 'string' && /^[a-f0-9]{64}$/.test(row.scope)
    && typeof row.key === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(row.key)
    && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0
    && ['outcome_unknown', 'accepted', 'rejected'].includes(row.state);
}

export async function sendWithJournal(journal: CommandJournal, scope: string, sessionKey: string, key: string,
  send: (key: string) => Promise<SendMessageResponse>, query: (key: string) => Promise<CommandReceipt>) {
  let row: PendingCommand;
  try { row = journal.begin(scope, sessionKey, key); }
  catch (error) { throw new CommandNotSubmittedError(error instanceof Error ? error.message : 'Recovery storage unavailable; submission was not attempted'); }
  try {
    const response = await sendWithReceiptRecovery(key, send, query);
    try { journal.forget(row); } catch { /* Definitive admission must not become a submission failure. A later GET can settle the saved record. */ }
    return response;
  } catch (error) {
    if (error instanceof CommandRejectedError) {
      try { journal.settle(row, 'rejected'); } catch { /* Preserve the original known rejection. */ }
    }
    throw error;
  }
}

// Refresh recovery deliberately has no send callback and cannot execute a POST.
export async function recoverSavedCommand(journal: CommandJournal, row: PendingCommand,
  query: () => Promise<CommandReceipt>, onPersistenceFailure?: (state: CommandReceipt['state']) => void) {
  // Lifecycle admission is not completion; only its dedicated observer may
  // reconcile this record, never generic session delivery recovery.
  if (row.lifecycle) throw new CommandOutcomeUnknownError(row.key);
  const receipt = await query();
  if (row.maintenance && !maintenanceReceiptState(receipt, row.key, row.maintenance)) throw new MaintenanceOutcomeUnknownError(row.key);
  if (receipt.key !== row.key) throw new CommandOutcomeUnknownError(row.key);
  if (row.creation && !creationReceiptState(receipt, row.key, row.creation)) throw new CreationOutcomeUnknownError(row.key);
  if (row.settings && !settingsReceiptState(receipt, row.key, row.sessionKey)) throw new SettingsOutcomeUnknownError(row.key);
  if (row.compact && !compactReceiptState(receipt, row.key)) throw new CompactOutcomeUnknownError(row.key);
  if ((row.queue || row.deletion) && !controlReceiptState(receipt, row.key, row.deletion)) {
    throw row.deletion ? new DeletionOutcomeUnknownError(row.key) : new QueueOutcomeUnknownError(row.key);
  }
  if (!row.creation && !row.queue && !row.deletion && !row.settings && !row.compact && !row.maintenance
    && !messageReceiptState(row, receipt)) throw new CommandOutcomeUnknownError(row.key);
  try {
    // An exact, accepted send receipt resolves delivery, not execution. Match
    // the successful POST path: retire its local hint rather than leaving a
    // permanent amber "may be queued/running" banner. Control fences and
    // creation shortcuts have their own completion semantics and stay intact.
    if (messageReceiptResponse(row, receipt)) journal.forget(row);
    else if (receipt.state === 'accepted' || receipt.state === 'rejected') journal.settle(row, receipt.state);
    else if (row.settings && receipt.settingsStartReleased === true) journal.releaseSettingsStart(row);
  } catch (error) {
    // A known server outcome must not become unknown merely because browser
    // persistence failed. Callers opting into this path must display a warning.
    if (!onPersistenceFailure) throw error;
    onPersistenceFailure(receipt.state);
  }
  return receipt.state;
}

export function messageReceiptResponse(row: Pick<PendingCommand, 'key' | 'creation' | 'queue' | 'deletion' | 'settings' | 'compact' | 'maintenance' | 'lifecycle'>,
  receipt: CommandReceipt): SendMessageResponse | undefined {
  if (row.creation || row.queue || row.deletion || row.settings || row.compact || row.maintenance || row.lifecycle
    || receipt.key !== row.key || receipt.state !== 'accepted' || !receipt.result
    || !Number.isInteger(receipt.result.status) || receipt.result.status < 200 || receipt.result.status >= 300
    || !receipt.result.body || typeof receipt.result.body !== 'object' || Array.isArray(receipt.result.body)) return;
  const status = receipt.result.body.status;
  if (!['started', 'in_flight', 'ok', 'queued', 'stopped', 'interrupt_requested'].includes(status as string)) return;
  return { ...receipt.result.body, status, command: receipt } as SendMessageResponse;
}

export function messageReceiptState(row: Pick<PendingCommand, 'key' | 'creation' | 'queue' | 'deletion' | 'settings' | 'compact' | 'maintenance' | 'lifecycle'>,
  receipt: CommandReceipt | undefined): CommandReceipt['state'] | undefined {
  if (row.creation || row.queue || row.deletion || row.settings || row.compact || row.maintenance || row.lifecycle
    || receipt?.key !== row.key) return;
  if (receipt.state === 'outcome_unknown') return 'outcome_unknown';
  if (receipt.state === 'accepted') return messageReceiptResponse(row, receipt) ? 'accepted' : undefined;
  if (receipt.state !== 'rejected' || !receipt.result || !Number.isInteger(receipt.result.status)
    || receipt.result.status < 400 || receipt.result.status >= 500
    || !receipt.result.body || typeof receipt.result.body !== 'object' || Array.isArray(receipt.result.body)) return;
  return 'rejected';
}

export function isUnresolvedSettingsFence(row: PendingCommand) {
  return row.state === 'outcome_unknown' && (row.deletion || row.settings && !row.settingsStartReleased);
}

export class QueueOutcomeUnknownError extends Error {
  constructor(readonly commandKey: string) { super('Queue modification not confirmed. Check its saved receipt; do not repeat the modification.'); }
}
export class DeletionOutcomeUnknownError extends Error {
  constructor(readonly commandKey: string) { super('Deletion outcome is unknown. Check its saved receipt; do not delete again.'); }
}

export class CreationOutcomeUnknownError extends Error {
  constructor(readonly commandKey: string) { super('Session creation outcome is unknown. Check its saved receipt; do not create again.'); }
}

export class SettingsOutcomeUnknownError extends Error {
  constructor(readonly commandKey: string) { super('Settings outcome is unknown. Check the saved receipt; the change was not resent.'); }
}

export class CompactOutcomeUnknownError extends Error {
  constructor(readonly commandKey: string) { super('Compaction outcome is unknown. Check the saved receipt; compaction was not repeated.'); }
}

function compactReceiptState(receipt: CommandReceipt | undefined, key: string) {
  if (receipt?.key !== key) return undefined;
  if (receipt.state === 'outcome_unknown') return 'outcome_unknown';
  const result = receipt.result;
  if (receipt.state === 'accepted' && result?.status === 200 && result.body?.ok === true
    && result.body.status === 'compacting' && typeof result.body.runId === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result.body.runId)) return 'accepted';
  if (receipt.state === 'rejected' && result && Number.isInteger(result.status) && result.status >= 400 && result.status < 500) return 'rejected';
  return undefined;
}

// Admission is not native completion. Persist before POST; all recovery is GET-only.
export async function compactWithJournal(journal: CommandJournal, scope: string, sessionKey: string, key: string,
  send: () => Promise<CompactSessionResponse>, query: () => Promise<CommandReceipt>): Promise<CompactSessionResponse> {
  let row: PendingCommand;
  try {
    if (journal.list(scope, sessionKey, 'all').some(item => isUnresolvedSettingsFence(item) || item.state === 'outcome_unknown' && item.compact)) {
      throw new Error('This session has an unresolved control; check its saved receipt first');
    }
    row = journal.begin(scope, sessionKey, key, 'compact');
  } catch (error) { throw new CommandNotSubmittedError(error instanceof Error ? error.message : 'Recovery storage unavailable'); }
  let receipt: CommandReceipt | undefined;
  try {
    const response = await send();
    if (response.command) receipt = { ...response.command, result: { status: 200, body: response } };
  } catch { /* A disconnected request may already be durably admitted. */ }
  if (compactReceiptState(receipt, key) !== 'accepted') {
    try { receipt = await query(); } catch { /* Never resend. */ }
  }
  const state = compactReceiptState(receipt, key);
  if (state === 'accepted') {
    try { journal.forget(row); } catch { /* Preserve accepted admission. */ }
    return receipt!.result!.body as CompactSessionResponse;
  }
  if (state === 'rejected') {
    try { journal.settle(row, 'rejected'); } catch { /* Preserve rejection. */ }
    throw new CommandRejectedError('Compaction rejected; refresh the session before trying again');
  }
  throw new CompactOutcomeUnknownError(key);
}

export class MaintenanceOutcomeUnknownError extends Error {
  constructor(readonly commandKey: string) { super('Maintenance outcome unknown. The Connector may already have changed state; query the original receipt. No command was resent.'); }
}

// A receipt is command completion, not evidence that a new process is healthy.
// Only final update states qualify; a generic ACK or an intermediate status cannot clear the journal.
export function maintenanceReceiptState(receipt: CommandReceipt | undefined, key: string, target: MaintenanceTarget) {
  if (receipt?.key !== key) return undefined;
  if (receipt.state === 'outcome_unknown') return 'outcome_unknown';
  const result = receipt.result;
  if (receipt.state === 'rejected' && result && Number.isInteger(result.status) && result.status >= 400 && result.status < 500) return 'rejected';
  const body = result?.body;
  if (target.operation === 'pause' || target.operation === 'resume') {
    const status = readConnectorAdmissionStatus(body);
    if (receipt.state !== 'accepted' || result?.status !== 200 || !status?.fenceId) return undefined;
    return (target.operation === 'pause' ? status.state === 'paused' && !status.resumeInterrupted
      : status.state === 'released' || (status.state === 'paused' && status.resumeInterrupted)) ? 'accepted' : undefined;
  }
  if (receipt.state !== 'accepted' || result?.status !== 200 || !body || typeof body.supported !== 'boolean'
    || typeof body.currentVersion !== 'string' || !body.currentVersion || typeof body.rollbackAvailable !== 'boolean'
    || !Number.isSafeInteger(body.updatedAt) || Number(body.updatedAt) < 0
    || !['failed', target.operation === 'apply' ? 'succeeded' : 'rolled_back'].includes(String(body.state))
    || (body.restartRequired !== undefined && typeof body.restartRequired !== 'boolean')
    || (body.lastError !== undefined && typeof body.lastError !== 'string')) return undefined;
  return 'accepted';
}

export async function maintenanceWithJournal(journal: CommandJournal, scope: string, target: MaintenanceTarget, key: string,
  send: () => Promise<CommandReceipt | undefined>, query: () => Promise<CommandReceipt>) {
  let row: PendingCommand;
  try { row = journal.beginMaintenance(scope, target, key); }
  catch (error) { throw new CommandNotSubmittedError(error instanceof Error ? error.message : 'Recovery storage unavailable'); }
  const original = row.maintenance!;
  let receipt: CommandReceipt | undefined;
  try { receipt = await send(); } catch { /* A failed response can follow an actual release switch. */ }
  if (!maintenanceReceiptState(receipt, key, original) || receipt?.state === 'outcome_unknown') {
    try { receipt = await query(); } catch { /* Only original GET, never another POST. */ }
  }
  const state = maintenanceReceiptState(receipt, key, original);
  if (state === 'accepted' || state === 'rejected') {
    // Keep the receipt key until explicit dismissal so failed/restart-required
    // results remain queryable after refresh without storing the result body.
    try { journal.settle(row, state); } catch { /* Known completion survives a storage failure. */ }
    if (state === 'rejected') throw new CommandRejectedError('Maintenance command rejected; review its receipt before a new request');
    return receipt!.result!.body as ConnectorMaintenanceResult;
  }
  throw new MaintenanceOutcomeUnknownError(key);
}

export function settingsReceiptState(receipt: CommandReceipt | undefined, key: string, sessionKey: string) {
  if (receipt?.key !== key) return undefined;
  if (receipt.settingsStartReleased !== undefined && (receipt.settingsStartReleased !== true || receipt.state !== 'outcome_unknown'
    || typeof receipt.id !== 'string' || !receipt.id || receipt.id.length > 200
    || !Number.isSafeInteger(receipt.createdAt) || receipt.createdAt < 0
    || !Number.isSafeInteger(receipt.updatedAt) || receipt.updatedAt < receipt.createdAt)) return undefined;
  if (receipt.state === 'outcome_unknown') return 'outcome_unknown';
  const result = receipt.result;
  if (receipt.state === 'accepted' && result?.status === 200 && readSessionSettingsResult(result.body, sessionKey)) return 'accepted';
  if (receipt.state === 'rejected' && result && Number.isInteger(result.status) && result.status >= 400 && result.status < 500) return 'rejected';
  return undefined;
}

export async function settingsWithJournal(journal: CommandJournal, scope: string, sessionKey: string, key: string,
  send: () => Promise<Partial<SessionSettingsResult> & { command?: CommandReceipt }>, query: () => Promise<CommandReceipt>) {
  let row: PendingCommand;
  try {
    if (journal.list(scope, sessionKey, 'all').some(isUnresolvedSettingsFence)) {
      throw new Error('This session has an unresolved settings change or deletion; check its receipt first');
    }
    row = journal.begin(scope, sessionKey, key, 'settings');
  } catch (error) { throw new CommandNotSubmittedError(error instanceof Error ? error.message : 'Recovery storage unavailable'); }
  let receipt: CommandReceipt | undefined;
  try {
    const response = await send();
    if (response.command) receipt = { ...response.command, result: { status: 200, body: response } };
  } catch { /* Failure is not proof that no write occurred. */ }
  if (settingsReceiptState(receipt, key, sessionKey) !== 'accepted') {
    try { receipt = await query(); } catch { /* GET-only recovery. */ }
  }
  const state = settingsReceiptState(receipt, key, sessionKey);
  if (state === 'accepted') {
    try { journal.forget(row); } catch { /* ACK remains valid even if local storage fails. */ }
    return readSessionSettingsResult(receipt!.result!.body, sessionKey)!;
  }
  if (state === 'rejected') {
    try { journal.settle(row, 'rejected'); } catch { /* Preserve known rejection. */ }
    throw new CommandRejectedError('Settings rejected; review before trying a new change');
  }
  throw new SettingsOutcomeUnknownError(key);
}

// A creation has a target, not a fabricated session ID. Neither title nor the
// returned receipt body is stored in the existing bounded per-tab journal.
export async function createWithJournal(journal: CommandJournal, scope: string, target: CreationTarget, key: string,
  send: () => Promise<{ command?: CommandReceipt }>, query: () => Promise<CommandReceipt>, prepare?: () => Promise<void>) {
  try { await prepare?.(); }
  catch { throw new CommandNotSubmittedError('Connector identity could not be verified; session creation was not attempted'); }
  let row: PendingCommand;
  try { row = journal.beginCreation(scope, target, key); }
  catch (error) { throw new CommandNotSubmittedError(error instanceof Error ? error.message : 'Recovery storage unavailable'); }
  let receipt: CommandReceipt | undefined;
  try { receipt = (await send()).command; } catch { /* Delivery may have committed. */ }
  if (!creationReceiptState(receipt, key, target) || receipt?.state === 'outcome_unknown') {
    try { receipt = await query(); } catch { /* GET only, never recreate. */ }
  }
  const state = creationReceiptState(receipt, key, target);
  if (state === 'accepted') {
    // Keep the target/key until explicit dismissal: native ACK does not prove
    // the session list projection exists, even after another page reload.
    try { journal.settle(row, 'accepted'); } catch { /* ACK survives storage failure. */ }
    return { key: receipt!.result!.body.key as string };
  }
  if (state === 'rejected') {
    try { journal.settle(row, 'rejected'); } catch { /* Preserve known rejection. */ }
    throw new CommandRejectedError('Session creation rejected; review before trying a new command');
  }
  throw new CreationOutcomeUnknownError(key);
}

export function creationReceiptState(receipt: CommandReceipt | undefined, key: string, target: CreationTarget) {
  if (receipt?.key !== key) return undefined;
  if (receipt.state === 'outcome_unknown') return 'outcome_unknown';
  const result = receipt.result;
  if (receipt.state === 'rejected' && result && Number.isInteger(result.status) && result.status >= 400 && result.status < 500) return 'rejected';
  if (receipt.state !== 'accepted' || result?.status !== 201 || typeof result.body?.key !== 'string') return undefined;
  const id = result.body.key, prefix = `${target.connectionId}:`, encoded = id.slice(prefix.length);
  if (!id.startsWith(prefix) || id.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const native = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!native || native === 'codex:' || /[\u0000-\u001f\u007f]/.test(native)
      || btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== encoded) return undefined;
    return 'accepted';
  } catch { return undefined; }
}

// Reuse the same bounded, account-partitioned journal. Queue records contain
// only a target ID/action, never edited text, credentials or attachments.
export async function mutateQueueWithJournal(journal: CommandJournal, scope: string, sessionKey: string, key: string, queue: QueueMutation,
  send: () => Promise<{ ok?: boolean; command?: CommandReceipt }>, query: () => Promise<CommandReceipt>) {
  return mutateControlWithJournal(journal, scope, sessionKey, key, queue, send, query);
}

export async function deleteWithJournal(journal: CommandJournal, scope: string, sessionKey: string, key: string,
  send: () => Promise<{ ok?: boolean; status?: string; command?: CommandReceipt }>, query: () => Promise<CommandReceipt>) {
  return mutateControlWithJournal(journal, scope, sessionKey, key, 'delete', send, query);
}

async function mutateControlWithJournal(journal: CommandJournal, scope: string, sessionKey: string, key: string, control: QueueMutation | 'delete',
  send: () => Promise<{ ok?: boolean; status?: string; command?: CommandReceipt }>, query: () => Promise<CommandReceipt>) {
  const deletion = control === 'delete';
  let row: PendingCommand;
  try {
    if (journal.list(scope, sessionKey, 'all').some(item => item.state === 'outcome_unknown'
      && (deletion ? item.deletion : item.queue?.messageId === control.messageId))) {
      throw new Error(deletion ? 'This session has an unresolved deletion; check its receipt first'
        : 'This queued message has an unresolved modification; check its receipt first');
    }
    row = journal.begin(scope, sessionKey, key, control);
  } catch (error) { throw new CommandNotSubmittedError(error instanceof Error ? error.message : 'Recovery storage unavailable'); }
  try {
    const response = await send();
    if (response.ok === true && response.command?.key === key && response.command.state === 'accepted'
      && (!deletion || response.status === 'delete_accepted')) {
      try { journal.forget(row); } catch { /* A saved accepted receipt can be checked later. */ }
      return;
    }
  } catch { /* Even a failed HTTP request may already have committed. Query only. */ }
  let receipt: CommandReceipt | undefined;
  try { receipt = await query(); } catch { /* Keep uncertainty durable. */ }
  const state = controlReceiptState(receipt, key, deletion);
  if (state === 'accepted') {
    try { journal.forget(row); } catch { /* Preserve the confirmed result. */ }
    return;
  }
  if (state === 'rejected') {
    try { journal.settle(row, 'rejected'); } catch { /* Preserve the confirmed rejection. */ }
    throw new CommandRejectedError(deletion ? 'Deletion rejected; review before trying a new command'
      : receipt!.result!.status === 412 ? 'Queue version changed; refresh and review before editing' : 'Queue modification rejected');
  }
  throw deletion ? new DeletionOutcomeUnknownError(key) : new QueueOutcomeUnknownError(key);
}

function controlReceiptState(receipt: CommandReceipt | undefined, key: string, deletion = false) {
  if (receipt?.key !== key) return undefined;
  if (receipt.state === 'outcome_unknown') return 'outcome_unknown';
  const result = receipt.result;
  if (receipt.state === 'accepted' && result?.status === 200 && result.body?.ok === true
    && (!deletion || result.body.status === 'delete_accepted')) return 'accepted';
  if (receipt.state === 'rejected' && result && Number.isInteger(result.status) && result.status >= 400 && result.status < 500) return 'rejected';
  return undefined;
}
export function newCommandKey(): string {
  const nonce = globalThis.crypto.randomUUID?.() ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return createCommandKey(nonce);
}

// One submission only. Recovery is a receipt GET, never a second side effect.
export async function sendWithReceiptRecovery(key: string, send: (key: string) => Promise<SendMessageResponse>,
  query: (key: string) => Promise<CommandReceipt>, receiptDelayMs = 1_500): Promise<SendMessageResponse> {
  // Slow response delivery is not slow admission. One bounded read may settle
  // an already persisted command while its sole POST is still in flight.
  // Pending/missing/failed reads never imply success and never trigger a POST.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const earlyReceipt = new Promise<SendMessageResponse>((resolve, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve().then(() => query(key)).then(receipt => {
        const state = messageReceiptState({ key }, receipt);
        if (state === 'rejected') reject(new CommandRejectedError('Command rejected'));
        else if (state === 'accepted') resolve(messageReceiptResponse({ key }, receipt)!);
        else if (receipt.key === key && (receipt.state === 'accepted' || receipt.state === 'rejected')) {
          reject(new CommandOutcomeUnknownError(key));
        }
      }, () => { /* The original request remains authoritative until settled. */ });
    }, receiptDelayMs);
  });
  try {
    const response = await Promise.race([Promise.resolve().then(() => send(key)), earlyReceipt]);
    if (response && typeof response === 'object' && !Array.isArray(response)
      && ['started', 'in_flight', 'ok', 'queued', 'stopped', 'interrupt_requested'].includes(response.status)) return response;
  } catch (error) {
    if (error instanceof CommandRejectedError) throw error;
  } finally { clearTimeout(timer); }
  try {
    const receipt = await query(key);
    if (receipt.key !== key) throw new Error('Receipt identity mismatch');
    const state = messageReceiptState({ key }, receipt);
    if (state === 'rejected') throw new CommandRejectedError('Command rejected');
    if (state === 'accepted') return messageReceiptResponse({ key }, receipt)!;
  } catch (error) {
    if (error instanceof CommandRejectedError) throw error;
  }
  throw new CommandOutcomeUnknownError(key);
}

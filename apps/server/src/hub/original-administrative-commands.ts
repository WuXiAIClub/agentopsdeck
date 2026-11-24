import { AuthRoutePersistence, type AuthPersistenceStep } from '../auth/route-persistence.js';
import { matchesWeixinBindingEffectReply, type WeixinBindingEffectOwner } from './member-weixin-domain.js';
import { matchesWeixinBackgroundReply, type WeixinBackgroundOwner } from './weixin-background-domain.js';
import { matchesConnectionControlSettlement, type ConnectionControlSettlementOwner } from './member-connection-control-domain.js';
import { nativeFileExpectation, validHubNativeFileReply } from './member-native-file-domain.js';
import { notebookMachineExpectation, validHubNotebookMachineReply } from './member-notebook-machine-domain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson } from './async-member-owner.js';
import { executeHubMemberCommand, hubMemberCommandBytes, hubMemberCommandNodes, hubMemberCommandArrayLength, hubMemberCommandBudget,
  hubMemberResultBytes, hubMemberResultBudget, validHubMemberInput, validHubMemberOutput,
  HubMemberOwnerUnavailable, type HubMemberCommands, type HubMemberKind } from './member-owner-domain.js';
import type { HubStore } from './hub-store.js';
import { matchesContentBackgroundReply, type ContentBackgroundOwner } from './content-background-domain.js';
import {matchesNativeFileBackgroundReply, type NativeFileBackgroundOwner} from './native-file-background-domain.js';
import { executionLeaseOwnerSteps } from './member-execution-lease-domain.js';
import { validEventFeedOwner, validHubEventFeedReply, type HubEventFeedInput, type HubEventFeedOwner } from './event-feed-domain.js';

// Fixed administrative domains only. In particular no raw SQL, dynamic method
// name, caller-supplied principal, legacy Auth writer or remote execution.
const steps: Readonly<Partial<Record<HubMemberKind, AuthPersistenceStep | 107 | 108 | 109>>> = Object.freeze({
  taskSession: 109,
  notebookMachine: 108,
  storageMaintenance: 107,
  weixin: 105, weixinBindingEffect: 105, weixinBackground: 106,
  connectionControl: 104, connectionControlSettlement: 104,
  nativeFile: 103,
  nativeFileBackground: 103,
  delegation: 101,
  contentDocument: 102, contentBackground: 102,
  boardBinding: 100,
  usageManifest: 99,
  quickChatExecution: 97, quickChatEffect: 98,
  memberSnapshot: 6, memberIdentity: 12, memberActivity: 30, boardMachine: 69, notebookControl: 71, workspaceVisual: 75, workspaceConfiguration: 77, workspaceProjection: 79, workspaceReport: 80,
  userChange: 32, memberKeysRead: 2, memberKeyIssue: 24, memberKeyRevoke: 25,
  roleRead: 35, roleSet: 36, accessDirectory: 37, membershipRead: 38, membershipSet: 39,
  grantRead: 40, grantChange: 41,
  userDirectory: 86,
  issuerManagement: 96,
  executionLease: 52, executionIssuer: 87, executionCommand: 89, lifecycleCommand: 90, maintenanceCommand: 91, eventReplay: 92, eventFeed: 93, sharedRead: 94, sharedCreation: 95,
  sessionStateSnapshot: 84, sessionStateCheck: 85,
  connectionDirectoryVersion: 82, completionSummary: 26,
  connectionDirectory: 82, connectionDirectoryCheck: 83, connectionSnapshot: 31, connectionTarget: 33, connectionChange: 34,
  receivedGrants: 42, creationEnvironments: 43, sessionCollaborators: 44, sessionSharing: 45, ownedSessionSharing: 46,
  sessionGuidance: 47, quickChatState: 49, quickChatCleanup: 50,
  connectorAccess: 63, ownerControl: 64, sharedDirectory: 74, workspaceBoard: 65, boardCapability: 67, personalNotebook: 72,
  fileBindingRead: 81, workspaceGet: 20, workspaceSave: 21, layoutGet: 22, layoutSave: 23,
  completionObserve: 27, completionRead: 28, sessionPreferenceSet: 29,
  memberSessionCreate: 8, memberSessionDelete: 11,
  loginLimiterCheck: 17, loginLimiterFailure: 18, loginLimiterSuccess: 19,
  auditAppend: 14, auditPage: 15, auditList: 16,
});

/** Transitional production CALLER port, not a new database owner and not
 * off-thread SQL. Reuses the ONE original HubStore and its transaction-local
 * credential proof while actual HTTP callers become awaitable. Never start a
 * worker next to this writer. Closing the port drains commands, NOT the store.
 * It can later be replaced by the typed worker only when ALL shared callers
 * have migrated. There is no fallback, retry, cached grant or second writer. */
export class OriginalHubAdministrativeCommands {
  private readonly persistence: AuthRoutePersistence;
  private closed = false;
  private bytes = 0;
  private resultBytes = 0;
  constructor(private readonly store: HubStore, diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly limiter?: ReturnType<HubStore['createLoginLimiter']>) {
    this.persistence = new AuthRoutePersistence(diagnostics);
  }
  get pending() { return this.persistence.pending; }
  close(): Promise<void> { this.closed = true; return this.persistence.close(); }

  command<K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']): Promise<HubMemberCommands[K]['output']> {
    if (kind === 'weixinBackground' || kind === 'weixinBindingEffect' || kind === 'connectionControlSettlement' || kind === 'eventFeed' || kind === 'contentBackground' || kind === 'nativeFileBackground') return Promise.reject(new HubMemberOwnerUnavailable());
    return this.run(kind, input);
  }
  eventFeed(ownerUserId: string): HubEventFeedOwner {
    if (!validEventFeedOwner(ownerUserId)) throw new HubMemberOwnerUnavailable();
    return Object.freeze({ command: (command: HubEventFeedInput['command']) => this.run('eventFeed', { ownerUserId, command }) });
  }
  connectionControlSettlement(): ConnectionControlSettlementOwner {
    return Object.freeze({command: async (input: HubMemberCommands['connectionControlSettlement']['input']) => {
      const result = await this.run('connectionControlSettlement', input);
      if (!matchesConnectionControlSettlement(input, result)) throw new HubMemberOwnerUnavailable();
      return result;
    }});
  }
  weixinBindingEffect(): WeixinBindingEffectOwner {
    return Object.freeze({command: async (input: HubMemberCommands['weixinBindingEffect']['input']) => {
      const result = await this.run('weixinBindingEffect', input);
      if (!matchesWeixinBindingEffectReply(input, result)) throw new HubMemberOwnerUnavailable();
      return result;
    }});
  }
  weixinBackground(): WeixinBackgroundOwner {
    return Object.freeze({command: async (input: HubMemberCommands['weixinBackground']['input']) => {
      const result = await this.run('weixinBackground', input);
      if (!matchesWeixinBackgroundReply(input,result)) throw new HubMemberOwnerUnavailable();
      return result;
    }});
  }
  nativeFileBackground(): NativeFileBackgroundOwner {
    return Object.freeze({command: async (command: HubMemberCommands['nativeFileBackground']['input']) => {
      const result = await this.run('nativeFileBackground', command);
      if (!matchesNativeFileBackgroundReply(command, result)) throw new HubMemberOwnerUnavailable();
      return result;
    }});
  }
  contentBackground(): ContentBackgroundOwner {
    return Object.freeze({ command: async (command: HubMemberCommands['contentBackground']['input']) => {
      const result = await this.run('contentBackground',command);
      if (!matchesContentBackgroundReply(command,result)) throw new HubMemberOwnerUnavailable();
      return result;
    } });
  }
  private run<K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']): Promise<HubMemberCommands[K]['output']> {
    let copied: HubMemberCommands[K]['input'], size: number, resultSize: number, step: AuthPersistenceStep | 107 | 108 | 109;
    try {
      const selected = Object.hasOwn(steps, kind) ? steps[kind] : undefined;
      if (this.closed || selected === undefined || this.pending >= 256
        || this.bytes >= hubMemberCommandBudget(kind)
        || this.resultBytes + (kind === 'eventReplay' || kind === 'eventFeed' || kind === 'delegation' || kind === 'contentDocument' || kind === 'contentBackground' ? 0 : hubMemberResultBytes(kind)) > hubMemberResultBudget(kind)) throw new HubMemberOwnerUnavailable();
      step = selected;
      const body = encodeHubMemberJson(input, hubMemberCommandBytes(kind), hubMemberCommandNodes(kind), hubMemberCommandArrayLength(kind));
      copied = JSON.parse(body);
      size = Buffer.byteLength(body); resultSize = hubMemberResultBytes(kind, copied);
      if (!validHubMemberInput(kind, copied) || this.closed
        || this.bytes + size > hubMemberCommandBudget(kind)
        || this.resultBytes + resultSize > hubMemberResultBudget(kind)) throw new HubMemberOwnerUnavailable();
      if (kind === 'executionLease') step = executionLeaseOwnerSteps[(copied as HubMemberCommands['executionLease']['input']).action];
      if (kind === 'executionIssuer' && (copied as HubMemberCommands['executionIssuer']['input']).action === 'check') step = 88;
      // Inspect only the already copied and validated DTO, never an accessor
      // on caller input. An update's original ACK must be logged as a write.
      if (kind === 'boardMachine' && (copied as HubMemberCommands['boardMachine']['input']).action === 'update') step = 70;
      if (kind === 'workspaceBoard' && (copied as HubMemberCommands['workspaceBoard']['input']).command.action === 'save') step = 66;
      if (kind === 'workspaceConfiguration' && (copied as HubMemberCommands['workspaceConfiguration']['input']).command.action === 'save') step = 78;
      if (kind === 'workspaceVisual' && (copied as HubMemberCommands['workspaceVisual']['input']).command.action === 'save') step = 76;
      if (kind === 'boardCapability') {
        const action = (copied as HubMemberCommands['boardCapability']['input']).command.action;
        if (action === 'issue' || action === 'revoke') step = 68;
      }
      if (kind === 'notebookControl') {
        const action = (copied as HubMemberCommands['notebookControl']['input']).command.action;
        if (action === 'move' || action === 'issue' || action === 'revoke') step = 72;
      }
      // Fixed saves/snapshots and original session proof checks only. Generic
      // get/save still bypass the production transaction contract and are forbidden.
      if (kind === 'personalNotebook'
        && !['savePrivate', 'saveSession', 'snapshotPrivate', 'snapshotSession', 'resolveSession', 'checkSession'].includes((copied as HubMemberCommands['personalNotebook']['input']).command.action)) throw new HubMemberOwnerUnavailable();
    } catch { return Promise.reject(new HubMemberOwnerUnavailable()); }
    // Reserve before any diagnostic callback can reenter or close this port.
    this.bytes += size; this.resultBytes += resultSize;
    const work = this.persistence.run(step, () => {
      const value = executeHubMemberCommand(this.store, kind, copied, this.limiter);
      const finish = (value: unknown) => {
        // Serialize the trusted original result just as the worker does. Keep
        // result/admission ownership until the original ACK and validation,
        // not merely until an async storage-admission Promise is returned.
        const body = JSON.stringify(value);
        if (typeof body !== 'string' || Buffer.byteLength(body) > resultSize) throw new HubMemberOwnerUnavailable();
        const result: unknown = JSON.parse(body);
        if (!validHubMemberOutput(kind, result)) throw new HubMemberOwnerUnavailable();
        if (kind === 'storageMaintenance' && result && typeof result === 'object' && 'action' in result
          && result.action !== (copied as HubMemberCommands['storageMaintenance']['input']).command.action) throw new HubMemberOwnerUnavailable();
        if (kind === 'nativeFile' && !validHubNativeFileReply(nativeFileExpectation((copied as HubMemberCommands['nativeFile']['input']).command), result)) throw new HubMemberOwnerUnavailable();
        if (kind === 'notebookMachine' && !validHubNotebookMachineReply(notebookMachineExpectation(copied as HubMemberCommands['notebookMachine']['input']), result)) throw new HubMemberOwnerUnavailable();
        if (kind === 'eventFeed' && !validHubEventFeedReply(copied as HubEventFeedInput, result)) throw new HubMemberOwnerUnavailable();
        return result as HubMemberCommands[K]['output'];
      };
      // These domains can retain original asynchronous owner work. Keep
      // ownership until the actual ACK and validation, including on close.
      return kind === 'storageMaintenance' || kind === 'connectionControl' || kind === 'ownerControl' || kind === 'executionLease' || kind === 'executionIssuer' || kind === 'executionCommand' || kind === 'lifecycleCommand' || kind === 'maintenanceCommand' || kind === 'sharedCreation' || kind === 'usageManifest' || kind === 'contentDocument' || kind === 'contentBackground'
        ? Promise.resolve(value).then(finish) : finish(value);
    });
    return work.then(result => result.value).finally(() => { this.bytes -= size; this.resultBytes -= resultSize; });
  }
}

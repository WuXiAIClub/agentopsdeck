import { AsyncHubFileBindingReads } from './async-file-binding-reads.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberRequests } from './async-member-request.js';
import { AsyncHubMemberRoles } from './async-member-roles.js';
import { AsyncHubMemberMemberships } from './async-member-memberships.js';
import { AsyncHubMemberDirectory } from './async-member-directory.js';
import { AsyncHubMemberGrants } from './async-member-grants.js';
import { AsyncHubReceivedGrants } from './async-received-grants.js';
import { AsyncHubSessionCollaborators } from './async-session-collaborators.js';
import { AsyncHubSessionSharing } from './async-session-sharing.js';
import { AsyncHubOwnedSessionSharing } from './async-owned-session-sharing.js';
import { AsyncHubMemberGuidance } from './async-member-guidance.js';
import { AsyncHubMemberQuickChatRecovery } from './async-member-quick-chat-recovery.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { AsyncHubWorkspacePreferences } from './async-workspace-preferences.js';
import { AsyncHubWorkspaceLayouts } from './async-workspace-layouts.js';
import { AsyncHubCompletions } from './async-completions.js';
import { AsyncHubSessionPreferences } from './async-session-preferences.js';
import { AsyncHubAuthIdentity } from './async-auth-identity.js';
import { AsyncHubMemberSessions } from './async-member-session.js';
import { AsyncHubLoginLimiter } from './async-login-limiter.js';
import { AsyncHubAuditLog } from './async-audit-log.js';
import { AsyncHubMemberActivity } from './async-member-activity.js';
import { AsyncHubWorkspaceBoardMachine } from './async-workspace-board-machine.js';
import { AsyncHubWorkspaceBoards } from './async-workspace-boards.js';
import { AsyncHubWorkspaceBoardCapabilities } from './async-workspace-board-capabilities.js';
import { AsyncHubSessionNotebooks } from './async-session-notebooks.js';
import { AsyncHubNotebookControl } from './async-notebook-control.js';
import { AsyncWorkspaceNotebookMachine } from './async-workspace-notebook-machine.js';
import { AsyncHubWorkspaceReports } from './async-workspace-reports.js';
import { AsyncHubWorkspaceProjections } from './async-workspace-projections.js';
import { AsyncHubWorkspaceConfigurations } from './async-workspace-configurations.js';
import { AsyncHubWorkspaceVisuals } from './async-workspace-visuals.js';
import { HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { AsyncQuickChatExecution } from './async-quick-chat-execution.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubConnectionProxyAccess } from './async-connection-proxy-access.js';
import { AsyncHubUsageManifests } from './async-usage-manifests.js';
import { AsyncHubBoardBindings } from './async-board-bindings.js';
import { AsyncHubTaskSessions } from './async-task-sessions.js';
import { AsyncHubOwnerControls } from './async-owner-control.js';
import { AsyncHubDelegations } from './async-delegations.js';
import { AsyncHubContentDocuments } from './async-content-documents.js';
import { AsyncContentBackgroundAccess } from './async-content-background-access.js';
import { AsyncNativeFileBackgroundAccess } from './async-native-file-background-access.js';
import { AsyncHubNativeFiles } from './async-native-files.js';
import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import { AsyncHubWeixinAccess } from './async-weixin-access.js';
import { AsyncWeixinBackgroundAccess } from './async-weixin-background-access.js';

/** One group of production caller lifetimes, independent of the SQL owner.
 * Freeze ALL lanes synchronously before awaiting their original commands. */
export function createHubAdministrativeServices(originalOwner: Pick<AsyncHubMemberOwner, 'command'> & Partial<Pick<AsyncHubMemberOwner, 'contentBackground' | 'nativeFileBackground' | 'connectionControlSettlement' | 'weixinBindingEffect' | 'weixinBackground'>>,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
  let closed = false;
  // Freeze the whole group BEFORE diagnostics can reenter another lane.
  // Existing commands keep their original ownership; this gate never closes
  // the shared SQL owner, grants authority, replaces a flight or replays work.
  const owner: Pick<AsyncHubMemberOwner, 'command'> = { command(kind, input) {
    if (closed) return Promise.reject(new HubMemberOwnerUnavailable());
    return originalOwner.command(kind, input);
  } };
  const members = new AsyncHubMemberRequests(owner), roles = new AsyncHubMemberRoles(owner),
    memberships = new AsyncHubMemberMemberships(owner), directory = new AsyncHubMemberDirectory(owner),
    grants = new AsyncHubMemberGrants(owner), received = new AsyncHubReceivedGrants(owner),
    collaborators = new AsyncHubSessionCollaborators(owner), sharing = new AsyncHubSessionSharing(owner),
    ownedSharing = new AsyncHubOwnedSessionSharing(owner), guidance = new AsyncHubMemberGuidance(owner),
    quickChatRecovery = new AsyncHubMemberQuickChatRecovery(owner),
    workspace = new AsyncHubWorkspacePreferences(owner), layouts = new AsyncHubWorkspaceLayouts(owner),
    completions = new AsyncHubCompletions(owner, diagnostics), sessionPreferences = new AsyncHubSessionPreferences(owner),
    authIdentity = new AsyncHubAuthIdentity(owner), authSessions = new AsyncHubMemberSessions(owner),
    loginLimiter = new AsyncHubLoginLimiter(owner), audit = new AsyncHubAuditLog(owner),
    activity = new AsyncHubMemberActivity(owner), boardMachine = new AsyncHubWorkspaceBoardMachine(owner),
    boards = new AsyncHubWorkspaceBoards(owner), boardCapabilities = new AsyncHubWorkspaceBoardCapabilities(owner),
    privateNotebooks = new AsyncHubSessionNotebooks(owner, diagnostics),
    notebookControl = new AsyncHubNotebookControl(owner, diagnostics),
    visuals = new AsyncHubWorkspaceVisuals(owner, diagnostics),
    configurations = new AsyncHubWorkspaceConfigurations(owner, diagnostics),
    projections = new AsyncHubWorkspaceProjections(owner, diagnostics),
    reports = new AsyncHubWorkspaceReports(owner, diagnostics),
    fileBindingReads = new AsyncHubFileBindingReads(owner, diagnostics);
  const drain = createIndependentDrain([() => members.close(), () => roles.close(),
    () => memberships.close(), () => directory.close(), () => grants.close(), () => received.close(),
    () => collaborators.close(), () => sharing.close(), () => ownedSharing.close(),
    () => guidance.close(), () => quickChatRecovery.close(), () => workspace.close(), () => layouts.close(),
    () => completions.close(), () => sessionPreferences.close(), () => authIdentity.close(),
    () => authSessions.close(), () => loginLimiter.close(), () => audit.close(), () => activity.close(),
    () => boardMachine.close(), () => boards.close(), () => boardCapabilities.close(),
    () => privateNotebooks.close(), () => notebookControl.close(), () => visuals.close(), () => configurations.close(), () => projections.close(), () => reports.close(), () => fileBindingReads.close()], 'hub-route-drain', diagnostics);
  const close = () => { closed = true; return drain(); };
  const createQuickChatExecution = () => {
    if (closed) throw new HubMemberOwnerUnavailable();
    return new AsyncQuickChatExecution(originalOwner, diagnostics);
  };
  // External workspace/HTTP work must drain before its identity and audit lanes;
  // administrative.close() may run concurrently with that original work.
  const createWorkspaceAccess = () => {
    if (closed) throw new HubMemberOwnerUnavailable();
    let retired = false;
    const remoteOwner: Pick<AsyncHubMemberOwner, 'command'> = { command(kind, input) {
      if (retired) return Promise.reject(new HubMemberOwnerUnavailable());
      return originalOwner.command(kind, input);
    } };
    const requests = new AsyncHubMemberRequests(remoteOwner, diagnostics);
    const audit = new AsyncHubAuditLog(remoteOwner, diagnostics);
    const drain = createIndependentDrain([() => requests.close(), () => audit.close()], 'hub-route-drain', diagnostics);
    return { requests, audit, close: () => { retired = true; return drain(); } };
  };
  // HTTP transport owns this private authority lane until its original work
  // drains. Administrative group shutdown must not retire it ahead of that.
  const createConnectionProxyAccess = () => {
    if (closed) throw new HubMemberOwnerUnavailable();
    return new AsyncHubConnectionProxyAccess(originalOwner, diagnostics);
  };
  const createConnectionVerificationAccess = () => {
    if (closed) throw new HubMemberOwnerUnavailable();
    const requests = new AsyncHubMemberRequests(originalOwner, diagnostics);
    return { requests, close: () => requests.close() };
  };
  const createTerminalAccess = () => {
    if (closed) throw new HubMemberOwnerUnavailable();
    const access = new AsyncHubConnectionProxyAccess(originalOwner, diagnostics);
    const audit = new AsyncHubAuditLog(originalOwner, diagnostics);
    return { access, audit, close: createIndependentDrain([() => access.close(), () => audit.close()], 'hub-route-drain', diagnostics) };
  };
  return { members, roles, memberships, directory, grants, received, collaborators, sharing, ownedSharing, guidance,
    createPermissionAccess: () => {
      if (closed) throw new HubMemberOwnerUnavailable();
      return new AsyncHubMemberRequests(originalOwner, diagnostics);
    },
    createGovernanceAccess: () => {
      if (closed) throw new HubMemberOwnerUnavailable();
      return new AsyncHubMemberRequests(originalOwner, diagnostics);
    },
    createWeixinBackgroundAccess: () => {
      if (closed || !originalOwner.weixinBackground) throw new HubMemberOwnerUnavailable();
      return new AsyncWeixinBackgroundAccess(originalOwner, originalOwner.weixinBackground(), diagnostics);
    },
    createWeixinAccess: () => {
      if (closed || !originalOwner.weixinBindingEffect) throw new HubMemberOwnerUnavailable();
      return new AsyncHubWeixinAccess(originalOwner, originalOwner.weixinBindingEffect(), diagnostics);
    },
    createConnectionControlAccess: () => {
      if (closed || !originalOwner.connectionControlSettlement) throw new HubMemberOwnerUnavailable();
      return {access: new AsyncHubConnectionProxyAccess(originalOwner, diagnostics), settlement: originalOwner.connectionControlSettlement()};
    },
    createNativeFiles: (resolve: AsyncConnectorClientResolver) => {
      if (closed) throw new HubMemberOwnerUnavailable();
      return new AsyncHubNativeFiles(originalOwner, resolve, diagnostics);
    },
    createNotebookMachine: (native: Pick<AsyncHubNativeFiles, 'beginNotebookMachine'>) => {
      if (closed) throw new HubMemberOwnerUnavailable();
      // Private lifetime: the route drains original effects before retiring
      // the owner, rather than closing a shared authority during settlement.
      return new AsyncWorkspaceNotebookMachine(originalOwner, native, diagnostics);
    },
    createNativeFileBackgroundAccess: () => {
      if (closed || !originalOwner.nativeFileBackground) throw new HubMemberOwnerUnavailable();
      return new AsyncNativeFileBackgroundAccess(originalOwner.nativeFileBackground());
    },
    createContentBackgroundAccess: () => {
      if (closed || !originalOwner.contentBackground) throw new HubMemberOwnerUnavailable();
      return new AsyncContentBackgroundAccess(originalOwner.contentBackground());
    },
    createUsageManifestAccess: () => { if (closed) throw new HubMemberOwnerUnavailable(); return new AsyncHubUsageManifests(originalOwner, diagnostics); },
    createBoardBindingAccess: () => { if (closed) throw new HubMemberOwnerUnavailable(); return new AsyncHubBoardBindings(originalOwner, diagnostics); },
    createGuidanceAccess: () => {
      if (closed) throw new HubMemberOwnerUnavailable();
      return new AsyncHubMemberGuidance(originalOwner, diagnostics);
    },
    createTaskSessionServices: (connector:AsyncConnectorClientResolver) => {
      if(closed)throw new HubMemberOwnerUnavailable();
      // Private lanes: the route first drains original external effects, then
      // closes these. Administrative shutdown cannot retire their late ACKs.
      return {access:new AsyncHubTaskSessions(originalOwner,diagnostics),controls:new AsyncHubOwnerControls(originalOwner,connector,diagnostics)};
    },
    createOwnerControlAccess: (connector: AsyncConnectorClientResolver) => {
      if (closed) throw new HubMemberOwnerUnavailable();
      return new AsyncHubOwnerControls(originalOwner, connector, diagnostics);
    },
    createDelegationAccess: () => { if (closed) throw new HubMemberOwnerUnavailable(); return new AsyncHubDelegations(originalOwner, diagnostics); },
    createContentDocumentAccess: () => { if (closed) throw new HubMemberOwnerUnavailable(); return new AsyncHubContentDocuments(originalOwner, diagnostics); },
    createDiscoveryAccess: () => {
      if (closed) throw new HubMemberOwnerUnavailable();
      const requests = new AsyncHubMemberRequests(originalOwner, diagnostics);
      const preferences = new AsyncHubSessionPreferences(originalOwner, diagnostics);
      return { requests, preferences, close: createIndependentDrain([() => requests.close(), () => preferences.close()], 'hub-route-drain', diagnostics) };
    },
    createSystemAccess: createConnectionVerificationAccess,
    createConnectionProxyAccess, createConnectionVerificationAccess, createTerminalAccess, createWebsiteActionAccess: createTerminalAccess, createWebsiteAccess: createTerminalAccess,
    createQuickChatExecution, createWorkspaceRemoteAccess: createWorkspaceAccess, createWorkspaceResearchAccess: createWorkspaceAccess, createWorkspaceBrowserAccess: createWorkspaceAccess,
    quickChatRecovery, workspace, layouts, completions, sessionPreferences, authIdentity, authSessions, loginLimiter, audit, activity, boardMachine, boards, boardCapabilities, privateNotebooks, notebookControl, visuals, configurations, projections, reports, fileBindingReads, close };
}
export type HubAdministrativeServices = ReturnType<typeof createHubAdministrativeServices>;

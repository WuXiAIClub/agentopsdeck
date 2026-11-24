import { CodexAppServer, type CodexAppServerOptions } from '../codex/app-server.js';
import { AsyncCodexCatalog } from './async-codex-catalog.js';
import { AsyncCodexSettings } from './async-codex-settings.js';
import { AsyncCodexDeletion } from './async-codex-deletion.js';
import { AsyncCodexPublicUsage } from './async-codex-public-usage.js';
import { AsyncCodexFiles } from './async-codex-files.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { EventSnapshotRead } from '../routes/events.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { ConnectorAgentLifecycle } from './agent-runtimes.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { AsyncCodexProjection } from './async-codex-projection.js';
import { AsyncCodexStartup, codexStartupDeckPublisher } from './async-codex-startup.js';
import { AsyncCodexScheduling } from './async-codex-scheduling.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { AsyncCodexQueue } from './async-codex-queue.js';
import { AsyncCodexPreparation } from './async-codex-preparation.js';
import { AsyncCodexDispatch } from './async-codex-dispatch.js';
import { AsyncCodexTools } from './async-codex-tools.js';
import { AsyncCodexInteractions } from './async-codex-interactions.js';
import { AsyncCodexCreation } from './async-codex-creation.js';
import { createAsyncCodexMessageIngress } from './async-codex-message-ingress.js';
import { AsyncAutomationBackground } from './async-automation-background.js';
import { AsyncAutomationConfiguration } from './async-automation-configuration.js';
import type { CodexMaintenanceRecoveryAuthority } from '../codex/app-server.js';
import { checkMaintenanceLocal } from './maintenance-local-guard.js';
import { persistUploadedMedia } from '../messages/send-message.js';

export type AsyncCodexNativeConfig = Pick<CodexAppServerOptions,
  'enabled' | 'command' | 'homeDirectory' | 'defaultCwd' | 'defaultModel' | 'modelProvider'
  | 'autoCompactTokenLimit' | 'disableRemoteCompaction' | 'toolImageCompatibility' | 'approvalPolicy' | 'historyCache'
  | 'boardToolsDirectory' | 'projectAssistant' | 'requestTimeoutMs' | 'runtimeOverridesFile'>;
export type AsyncCodexRuntimeState = 'new' | 'opening' | 'ready' | 'failed' | 'closing' | 'closed';

/** Full original Codex dependency graph. The application owns the sole worker
 * and closes it AFTER this runtime. No SQL handles, alternate scheduler, new
 * database or fallback to legacy send/create/authorization is installed here. */
export function createAsyncCodexRuntime(options: {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  deck: DeckStore;
  nodeId: string;
  native: AsyncCodexNativeConfig;
  snapshot: EventSnapshotRead;
  diagnostics?: PerformanceDiagnostics;
  timeoutMs?: number;
  modelChoices?: readonly string[];
  inboundDir?: string;
}) {
  const diagnostics = options.diagnostics ?? performanceDiagnostics;
  const inboundDir = options.inboundDir;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!options.nodeId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new TypeError('Original node identity and finite deadline required');
  // Copy only original native configuration, never spread caller SQL ports or
  // permission callbacks into the owned constructor (including JS callers).
  const c = options.native;
  const native: AsyncCodexNativeConfig = {
    enabled: c.enabled, command: c.command, homeDirectory: c.homeDirectory,
    defaultCwd: c.defaultCwd, defaultModel: c.defaultModel, modelProvider: c.modelProvider,
    autoCompactTokenLimit: c.autoCompactTokenLimit, disableRemoteCompaction: c.disableRemoteCompaction,
    toolImageCompatibility: c.toolImageCompatibility,
    approvalPolicy: c.approvalPolicy, boardToolsDirectory: c.boardToolsDirectory,
    ...(c.historyCache === undefined ? {} : { historyCache: c.historyCache }),
    ...(c.projectAssistant === undefined ? {} : { projectAssistant: c.projectAssistant }),
    ...(c.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: c.requestTimeoutMs }),
    ...(c.runtimeOverridesFile === undefined ? {} : { runtimeOverridesFile: c.runtimeOverridesFile }),
  };
  let state: AsyncCodexRuntimeState = 'new';
  let runtime: CodexAppServer;
  let opening: Promise<void> | undefined, openingDrain = Promise.resolve();
  let closing: Promise<void> | undefined;
  let paused: AdmissionPause | undefined;
  const operations = new Set<Promise<void>>();
  const readable = () => state === 'ready' && runtime.messageAdmissionReady;
  const available = () => !paused && readable();
  const operating = () => { if (state !== 'ready') throw new ConnectorOwnerUnavailable(); };
  const maintenanceAuthority = (authority: CodexMaintenanceRecoveryAuthority): CodexMaintenanceRecoveryAuthority => {
    const { authorize, local } = authority;
    return { authorize, local: () => { operating(); checkMaintenanceLocal(local); }, resumes: { ...authority.resumes } };
  };
  const local = () => { if (!available()) throw new ConnectorOwnerUnavailable(); };
  function retain<T>(run: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(() => { operating(); return run(); });
    // Capture physical ownership before returning the publicly mutable Promise.
    const done = () => { operations.delete(drain); };
    const drain = task.then(done, done); operations.add(drain);
    return task;
  }
  const projection = new AsyncCodexProjection({ owner: options.owner, deck: options.deck,
    bind: false, connectionId: () => runtime?.stopConnectionId ?? undefined, diagnostics });
  const startup = new AsyncCodexStartup({ owner: options.owner, projection,
    publish: codexStartupDeckPublisher(options.deck), diagnostics });
  const scheduling = new AsyncCodexScheduling(options.owner);
  const history = new AsyncCodexHistory(options.owner, diagnostics);
  const settings = new AsyncCodexSettings({ owner: options.owner, deck: options.deck, local: operating, writable: available,
    runtime: { readGoalControl: (...args) => runtime.readGoalControl(...args),
      changeGoalOwned: (...args) => runtime.changeGoalOwned(...args),
      updateSessionRuntimeOwned: (...args) => runtime.updateSessionRuntimeOwned(...args) }, diagnostics });
  const deletion = new AsyncCodexDeletion({ owner: options.owner, writable: available,
    local: key => { local(); if (!options.deck.getSession(key)) throw new ConnectorOwnerUnavailable(); },
    runtime: { removeOwned: (...args) => runtime.removeOwned(...args) }, diagnostics });
  const catalog = new AsyncCodexCatalog({ owner: options.owner, local: operating,
    runtime: { get enabled() { return native.enabled; }, listModels: () => runtime.listModels(),
      listSessionSkills: key => runtime.listSessionSkills(key) },
    sessionExists: key => !!options.deck.getSession(key), defaultModel: native.defaultModel ?? '',
    ...(native.modelProvider === undefined ? {} : { modelProvider: native.modelProvider }),
    ...(options.modelChoices === undefined ? {} : { modelChoices: options.modelChoices }), diagnostics });
  const publicUsage = new AsyncCodexPublicUsage({ owner: options.owner,
    local: () => { if (!readable()) throw new ConnectorOwnerUnavailable(); },
    sessionExists: key => !!options.deck.getSession(key), timeoutMs, diagnostics });
  const files = new AsyncCodexFiles({ owner: options.owner,
    local: () => { if (!readable()) throw new ConnectorOwnerUnavailable(); },
    sessionExists: key => !!options.deck.getSession(key), timeoutMs, diagnostics });
  // Closures run only after construction/open; the original executor is the
  // one physical native owner for preparation, dispatch, tools and creation.
  const preparation = new AsyncCodexPreparation({ owner: options.owner,
    runtime: {
      get stopConnectionId() { return runtime.stopConnectionId; },
      compactOwnedPreparation: (...args) => runtime.compactOwnedPreparation(...args),
      recoverOwnedPreparation: (...args) => runtime.recoverOwnedPreparation(...args),
    }, local, diagnostics });
  const tools = new AsyncCodexTools({ owner: options.owner, runtime: {
    get stopConnectionId() { return runtime.stopConnectionId; },
    bindOwnedBoardTools: (...args) => runtime.bindOwnedBoardTools(...args),
  } });
  const interactions = new AsyncCodexInteractions({ owner: options.owner, diagnostics,
    changed: key => { options.deck.append('interaction.updated', {}, { sessionKey: key }); }, runtime: {
    get stopConnectionId() { return runtime.stopConnectionId; },
    get interactionReady() { return readable() && runtime.interactionReady; },
    installOwnedInteractions: (...args) => runtime.installOwnedInteractions(...args),
  } });
  const dispatch = new AsyncCodexDispatch({ owner: options.owner, tools, interactions, local, diagnostics,
    runtime: {
      get stopConnectionId() { return runtime.stopConnectionId; },
      startOwnedTurn: (...args) => runtime.startOwnedTurn(...args),
    },
    settled(input, runId) {
      // Original ACK, never a new effect. Do not regress newer native history.
      const ids = new Set(input.claim.batch?.members.map(m => m.id) ?? [input.claim.commandId]);
      for (const message of options.deck.getMessages(input.claim.sessionKey)) {
        if (!ids.has(message.id) || message.role !== 'user' || message.status !== 'queued') continue;
        options.deck.addMessage({ ...message, turnId: runId, status: 'sent',
          queueVersion: undefined, queueDisposition: undefined });
      }
    },
  });
  const queue = new AsyncCodexQueue({ owner: options.owner, dispatch, local, diagnostics,
    // This consumer receives the original worker-authorized FIFO plan only.
    // Its fresh native proof permits input to a blocked Goal, not blanket
    // history readiness or compaction. Claim/effect recheck the exact FIFO.
    recovery: { consumer: preparation, observe: plan => runtime.observeOwnedQueue(plan.sessionKey, true) },
    async prepare(plan, entries, context) {
      local();
      const text = entries.map(e => e.payload.text).join(plan.batch?.separator ?? '');
      const credentials = await runtime.prepareOwnedCredentials(plan.sessionKey, text, plan.commandId);
      // Return the original resource owner even when close raced preparation.
      // Queue's post-await fence calls finish(not_started), not ad-hoc deletion.
      return { connectionId: credentials.connectionId, interactive: false, blockedGoalInput: true,
        input: [
          ...(text.trim() ? [{ type: 'text', text: context
            ? `[Recovered context from the oversized failed turn]\n${context}\n\n[Current request]\n${credentials.text}`
            : credentials.text }] : []),
          ...entries.flatMap(e => e.payload.images).map(image => ({ type: 'localImage', path: image.filePath })),
        ], dispatching: () => credentials.dispatching(), finish: outcome => credentials.finish(outcome) };
    },
  });
  runtime = new CodexAppServer({ ...native, store: options.deck, nativeJournal: projection.nativeJournal(),
    startup, scheduling, queuedConsumer: queue, historyReader: history,
    credentialExecutionReader: { get: async sessionKey =>
      (await options.owner.command('codexExecutionRead', { sessionKey })) ?? undefined },
    ownedInteractions: { nodeId: options.nodeId },
    authorizeTurn() { throw new ConnectorOwnerUnavailable(); },
  });
  const ingress = createAsyncCodexMessageIngress({ owner: options.owner, timeoutMs, diagnostics,
    persist: (items, settings) => persistUploadedMedia(items, { ...settings, inboundDir }),
    prepareSession: key => retain(() => runtime.refreshSession(key, { readOnly: true, fresh: true })),
    runtime: {
      get messageAdmissionReady() { return available(); },
      messageAdmissionState: key => { const original = runtime.messageAdmissionState(key);
        return { ...original, ready: available() && original.ready }; },
      publishMessageAdmission: (...args) => {
        runtime.publishMessageAdmission(...args); scheduling.notifyAdmission();
      },
    }, stopRuntime: runtime, stopAvailable: readable,
    reads: { projection: options.deck, snapshot: options.snapshot, diagnostics, allowRecentProjection: true,
      requestRecovery: (key, runId) => retain(() => runtime.requestSessionRecovery(key, runId)),
      refresh: (key, settings) => retain(() => runtime.refreshSession(key, settings)),
      display: key => state === 'ready' ? retain(() => runtime.prepareSessionDisplay(key)) : Promise.resolve(undefined),
      historyReady: key => state === 'ready' && runtime.isSessionHistoryReady(key) },
  });
  const creation = new AsyncCodexCreation({ owner: options.owner, deadlineMs: timeoutMs, diagnostics,
    native: { available, createSessionOwned: (...args) => runtime.createSessionOwned(...args) } });
  const automationConfiguration = new AsyncAutomationConfiguration(options.owner, options.nodeId, diagnostics);
  const automation = new AsyncAutomationBackground({ owner: options.owner, runtime, deck: options.deck,
    scheduling, available, diagnostics });

  function pauseQueueWorker(): AdmissionPause {
    if (state === 'closing' || state === 'closed' || state === 'failed') throw new ConnectorOwnerUnavailable();
    if (paused) return paused;
    const original = runtime.pauseQueueWorker();
    const background = automation.pause();
    let settled = false;
    const physical = Promise.allSettled([original.drained, background.drained, ingress.drainAdmissions(), creation.drain(), queue.drain(), settings.drain(), deletion.drain(), ...operations]);
    const lease: AdmissionPause = {
      drained: physical.then(results => {
        if (results.some(result => result.status === 'rejected')) throw new ConnectorOwnerUnavailable();
        settled = true;
      }),
      resume: () => {
        if (paused !== lease || !settled || state !== 'ready') return false;
        if (original.resume() !== true) return false;
        if (background.resume() !== true) {
          const fenced = runtime.pauseQueueWorker(); void fenced.drained.catch(() => {});
          return false;
        }
        paused = undefined; return true;
      },
    };
    paused = lease;
    // A caller may ignore a failed drain; execution must still remain paused.
    void lease.drained.catch(() => {});
    return lease;
  }

  function open(): Promise<void> {
    if (state === 'closing' || state === 'closed' || state === 'failed') return Promise.reject(new ConnectorOwnerUnavailable());
    if (opening) return opening;
    state = 'opening';
    const work = Promise.resolve().then(async () => {
      try {
        // Disabled native execution still participates in maintenance and
        // global projection reads. Open its read-only durable view without
        // running startup recovery, importing queues or starting native work.
        if (!native.enabled) await projection.open();
        await runtime.ready();
        if (state !== 'opening') throw new ConnectorOwnerUnavailable();
        state = 'ready';
      } catch {
        if (state === 'opening') state = 'failed';
        throw new ConnectorOwnerUnavailable();
      }
    });
    // Internal physical drain cannot be replaced by a caller's Promise method.
    openingDrain = work.then(() => {}, () => {});
    return opening = work;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    state = 'closing';
    ingress.freeze();
    interactions.freeze();
    catalog.freeze();
    settings.freeze();
    const paused = runtime.pauseQueueWorker();
    // Freeze each external producer synchronously before yielding to callers.
    const created = creation.close(), queued = queue.close();
    const configured = automationConfiguration.close(), automated = automation.close();
    const catalogued = catalog.close(), settingsClosed = settings.close(), deletionClosed = deletion.close(), usageClosed = publicUsage.close();
    const filesClosed = files.close();
    closing = Promise.resolve().then(async () => {
      const trace = guardedTrace(diagnostics, 'codex-startup'); trace.add('step', 6);
      let failed = false;
      const drain = async (work: () => Promise<unknown>) => {
        try { await work(); } catch { failed = true; }
      };
      await drain(async () => {
        const results = await Promise.allSettled([openingDrain, paused.drained, ingress.drain(), created, queued, configured, automated, catalogued, settingsClosed, deletionClosed, usageClosed, filesClosed, ...operations]);
        if (results.some(result => result.status === 'rejected')) throw new ConnectorOwnerUnavailable();
      });
      await drain(() => dispatch.close());
      await drain(() => preparation.close());
      await drain(() => tools.close());
      await drain(() => interactions.close());
      await drain(() => runtime.close());
      await drain(() => startup.close());
      await drain(() => history.close());
      await drain(() => projection.close());
      state = 'closed'; trace.add('settled', 1); trace.finish(failed);
      if (failed) throw new ConnectorOwnerUnavailable();
    });
    return closing;
  }
  const lifecycle = {
    id: 'codex' as const,
    refreshSession: (sessionKey: string, settings: HistoryRefreshOptions = {}) => {
      const original = { ...settings };
      return retain(() => runtime.refreshSession(sessionKey, original));
    },
    isSessionHistoryReady: (key: string) => state === 'ready' && runtime.isSessionHistoryReady(key),
    pauseQueueWorker, close,
  } satisfies ConnectorAgentLifecycle;
  return {
    ...lifecycle,
    enabled: native.enabled, owns: (key: string) => runtime.owns(key),
    status: () => Object.freeze({ state, available: available() }), open, close,
    // Expose only owned entry points, not runtime.send/create legacy methods.
    codexMessages: ingress.codexMessages, codexReads: ingress.codexReads!,
    codexCreation: { creation, physical: creation, ready: available, timeoutMs, diagnostics }, interactions,
    codexInteractions: { interactions, ready: () => readable() && runtime.interactionReady, timeoutMs, diagnostics },
    codexCatalog: { catalog, timeoutMs },
    codexSettings: { settings, timeoutMs },
    codexDeletion: { deletion, ready: available, timeoutMs, diagnostics },
    codexPublicUsage: { usage: publicUsage, timeoutMs },
    codexFiles: { files, timeoutMs },
    automationConfiguration,
    refreshProjection: () => retain(() => projection.refreshProjection()),
    async startWorkers() {
      await open(); operating(); runtime.startQueueWorker();
      if (native.enabled) automation.start();
    },
    runQueued: (sessionKey: string) => retain(() => { local(); return queue.run(sessionKey); }),
    refreshSessions: (settings: { maxAgeMs?: number } = {}) => {
      const original = { ...settings };
      return retain(() => runtime.refreshSessions(original));
    },
    isSessionListReady: () => state === 'ready' && runtime.isSessionListReady(),
    memoryDiagnostics: () => runtime.memoryDiagnostics(),
    boardToolsAvailable: () => state === 'ready' && runtime.boardToolsAvailable,
    listModels: () => retain(() => runtime.listModels()),
    listSessionSkills: (key: string) => retain(() => runtime.listSessionSkills(key)),
    inspectMaintenance: (check?: () => void, deadline?: number) => retain(async () => {
      const result = await runtime.inspectMaintenance(check, deadline);
      // Closing freezes admission before the original executor is torn down.
      // A previously issued observation must already be invalid at that point.
      return { ...result, assertCurrent() { operating(); result.assertCurrent(); } };
    }),
    inspectMaintenanceAsync: (authorize: () => Promise<void>, assertLocal: () => void, deadline?: number) => retain(async () => {
      const local = () => { operating(); assertLocal(); };
      const result = await runtime.inspectMaintenanceAsync(authorize, local, deadline);
      local();
      return { ...result, assertCurrent() { local(); result.assertCurrent(); } };
    }),
    recoverMaintenanceHistory: (key: string, check: () => void) => retain(() => runtime.recoverMaintenanceHistory(key, check)),
    recoverMaintenanceHistoryAsync: (key: string, authority: CodexMaintenanceRecoveryAuthority) => {
      const original = maintenanceAuthority(authority);
      return retain(() => runtime.recoverMaintenanceHistoryAsync(key, original));
    },
    refreshMaintenanceSessionsAsync: (authority: CodexMaintenanceRecoveryAuthority) => {
      const original = maintenanceAuthority(authority);
      return retain(() => runtime.refreshMaintenanceSessionsAsync(original));
    },
    refreshMaintenanceSessionAsync: (key: string, authority: CodexMaintenanceRecoveryAuthority) => {
      const original = maintenanceAuthority(authority);
      return retain(() => runtime.refreshMaintenanceSessionAsync(key, original));
    },
    maintenanceResumeSettlement: { finishResume: projection.nativeJournal().finishResume },
  };
}

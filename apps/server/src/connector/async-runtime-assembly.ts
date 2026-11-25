import { AsyncNativeQueue } from './async-native-queue.js';
import { AsyncSessionTitle } from './async-session-title.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { EventSnapshotRead } from '../routes/events.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { createAsyncCodexRuntime } from './async-codex-runtime.js';
import { AsyncSdkApplication, type AsyncSdkApplicationOptions, type AsyncSdkApplicationPorts } from './async-sdk-application.js';
import { AsyncHermesApplication, type AsyncHermesApplicationOptions } from './async-hermes-application.js';
import { AsyncOpenClawApplication, type AsyncOpenClawApplicationOptions } from './async-openclaw-application.js';
import { ConnectorAgentRuntimes } from './agent-runtimes.js';
import { createAsyncRuntimeProjection } from './async-runtime-projection.js';
import type { AsyncRuntimeHttp } from './async-runtime-http.js';
import { AsyncSessionMedia } from './async-session-media.js';

export type AsyncRuntimeAssemblyOptions = {
  /** Startup owns this lease. No child may replace, open or close it. */
  owner: Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'>;
  deck: DeckStore; nodeId: string; snapshot: EventSnapshotRead;
  codex: Pick<Parameters<typeof createAsyncCodexRuntime>[0], 'native' | 'modelChoices' | 'timeoutMs' | 'inboundDir'>;
  sdk: Omit<AsyncSdkApplicationOptions, 'owner' | 'projection' | 'diagnostics'>;
  hermes: Omit<AsyncHermesApplicationOptions, 'owner' | 'projection' | 'eventSnapshot' | 'diagnostics'>;
  openclaw: Omit<AsyncOpenClawApplicationOptions, 'owner' | 'deck' | 'diagnostics'>;
  diagnostics?: PerformanceDiagnostics;
  media?: Pick<NonNullable<AsyncRuntimeHttp['sessionMedia']>, 'inboundDir' | 'artifactConfig' | 'artifactRegistry' | 'sourcePreview' | 'refreshMessages'>;
};
export type AsyncRuntimeAssemblyPorts = {
  sdk?: AsyncSdkApplicationPorts;
  hermes?: ConstructorParameters<typeof AsyncHermesApplication>[1];
};

/** One original executor per configured runtime, one shared SQL owner. The
 * original transport/discovery/history/context are supplied by the root.
 * Construction is inert; callers must not create the legacy executors too. */
export async function createAsyncRuntimeAssembly(options: AsyncRuntimeAssemblyOptions, native: AsyncRuntimeAssemblyPorts = {}) {
  const { owner, deck, nodeId, snapshot } = options, diagnostics = options.diagnostics ?? performanceDiagnostics;
  const cleanups: (() => Promise<void>)[] = [];
  const report = (step: number, failed: boolean) => {
    const trace = guardedTrace(diagnostics, 'connector-runtime-assembly');
    trace.add('step', step); trace.finish(failed);
  };
  let cleaning: Promise<boolean> | undefined;
  const cleanup = () => {
    // Freeze synchronously on the first failure; physical drains still own
    // every outstanding preflight. A slow peer must not delay the fence.
    return cleaning ??= Promise.allSettled(cleanups.map(close => {
      try { return close(); } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    })).then(results => results.every(result => result.status === 'fulfilled'));
  };
  try {
    const media = options.media ? new AsyncSessionMedia(owner, diagnostics) : undefined;
    if (media) cleanups.push(() => media.close());
    const codex = createAsyncCodexRuntime({ ...options.codex, owner, deck, nodeId, snapshot, diagnostics });
    cleanups.push(() => codex.close());
    const sdk = new AsyncSdkApplication({ ...options.sdk, owner, projection: deck, diagnostics }, native.sdk);
    cleanups.push(() => sdk.close());
    const hermes = new AsyncHermesApplication({ ...options.hermes, owner, projection: deck, eventSnapshot: snapshot, diagnostics }, native.hermes);
    cleanups.push(() => hermes.close());
    const openclaw = new AsyncOpenClawApplication({ ...options.openclaw, owner, deck, diagnostics });
    cleanups.push(() => openclaw.close());
    const nativeQueue = new AsyncNativeQueue({ owner, diagnostics,
      changed: runtime => runtime === 'codex' ? codex.refreshProjection() : openclaw.refreshProjection() });
    cleanups.push(() => nativeQueue.close());
    const sessionTitles = new AsyncSessionTitle({ owner, deck, diagnostics,
      local: () => { if (state !== 'ready' || pause) throw new ConnectorOwnerUnavailable(); },
      writable: () => state === 'ready' && !pause });
    cleanups.push(() => sessionTitles.close());
    const agents = new ConnectorAgentRuntimes([codex, ...hermes.agents, ...sdk.agents]);
    const projection = createAsyncRuntimeProjection([
      () => codex.refreshProjection(), () => sdk.refreshProjection(),
      () => hermes.refreshProjection(), () => openclaw.refreshProjection(),
    ]);
    const http = {
      sessionTitles: { titles: sessionTitles },
      ...(media && options.media ? { sessionMedia: { ...options.media, access: media, store: deck } } : {}),
      ...sdk.http, ...hermes.http, ...openclaw.http,
      nativeQueue: { queue: nativeQueue, ready: runtime => state === 'ready' && (runtime === 'codex' ? codex.status().available : openclaw.ready), diagnostics },
      codexMessages: codex.codexMessages, codexReads: codex.codexReads, codexCreation: codex.codexCreation,
      codexInteractions: codex.codexInteractions, codexCatalog: codex.codexCatalog,
      codexSettings: codex.codexSettings, codexDeletion: codex.codexDeletion,
      codexPublicUsage: codex.codexPublicUsage, codexFiles: codex.codexFiles,
      automationConfiguration: codex.automationConfiguration,
    } satisfies AsyncRuntimeHttp;
    let state: 'new' | 'starting' | 'ready' | 'failed' | 'closing' | 'closed' = 'new';
    let starting: Promise<void> | undefined, closing: Promise<void> | undefined;
    let pause: AdmissionPause | undefined;
    const pending = new Set<Promise<void>>();
    const retain = <T>(run: () => Promise<T>): Promise<T> => {
      const work = Promise.resolve().then(run);
      const done = () => { pending.delete(drain); };
      const drain = work.then(done, done); pending.add(drain);
      return work;
    };
    const check = () => { if (state !== 'ready') throw new ConnectorOwnerUnavailable(); };
    const close = (): Promise<void> => {
      if (closing) return closing;
      state = 'closing';
      // Freeze EVERY child synchronously, before an in-flight startup resumes.
      // Capture synchronous failures too; do not skip the remaining children.
      const stopping = cleanups.map(stop => { try { return stop(); } catch { return Promise.reject(new ConnectorOwnerUnavailable()); } });
      const projectionClose = projection.close();
      return closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([...stopping, projectionClose, agents.close()]);
        while (pending.size) await Promise.allSettled([...pending]);
        state = 'closed';
        const failed = results.some(result => result.status === 'rejected'); report(4, failed);
        if (failed) throw new ConnectorOwnerUnavailable();
      });
    };
    const start = (): Promise<void> => {
      if (state === 'closing' || state === 'closed' || state === 'failed') return Promise.reject(new ConnectorOwnerUnavailable());
      if (starting) return starting;
      state = 'starting';
      return starting = retain(async () => {
        // Open the durable OpenClaw inventory before sibling native startup
        // can append to the shared causal head. The root's admission gate is
        // still closed: this does not authorize effects or publish readiness.
        // Starting all producers concurrently can exhaust the bounded read
        // barrier on a healthy restart, even when OpenClaw has no facts.
        await openclaw.start();
        if (state !== 'starting') throw new ConnectorOwnerUnavailable();
        // Once the inventory is established, retain every sibling preflight
        // even if another throws; cleanup must drain their physical work.
        const results = await Promise.allSettled([
          () => codex.startWorkers(), () => sdk.prepare(), () => hermes.start(),
        ].map(run => Promise.resolve().then(() => {
          if (state !== 'starting') throw new ConnectorOwnerUnavailable();
          return Promise.resolve().then(run).catch(() => {
            if (state === 'starting') { state = 'failed'; report(1, true); void cleanup(); }
            throw new ConnectorOwnerUnavailable();
          });
        })));
        if (state !== 'starting') { if (state === 'failed') await cleanup(); throw new ConnectorOwnerUnavailable(); }
        if (results.some(result => result.status === 'rejected')) {
          state = 'failed'; report(1, true); await cleanup(); throw new ConnectorOwnerUnavailable();
        }
        await projection.refresh();
        if (state !== 'starting') throw new ConnectorOwnerUnavailable();
        state = 'ready'; report(1, false);
      }).catch(async () => {
        if (state === 'starting') { state = 'failed'; report(1, true); await cleanup(); }
        throw new ConnectorOwnerUnavailable();
      });
    };
    const pauseQueueWorkers = (): AdmissionPause => {
      // Restored maintenance must fence original producers BEFORE start. This
      // is preparation permission only; projection/public readiness remains
      // separately guarded by the completed assembly bootstrap.
      if (state !== 'new' && state !== 'starting' && state !== 'ready') throw new ConnectorOwnerUnavailable();
      if (pause) return pause;
      // Include OpenClaw without changing its deliberately separate registry.
      const leases: AdmissionPause[] = [];
      let failed = false, drained = false, resumed = false;
      for (const stop of [() => agents.pauseQueueWorkers(), () => openclaw.pauseQueueWorker()]) {
        try { const lease = stop(); leases.push(lease); void lease.drained.catch(() => {}); } catch { failed = true; }
      }
      if (failed) { state = 'failed'; report(3, true); void cleanup(); throw new ConnectorOwnerUnavailable(); }
      return pause = {
        drained: Promise.allSettled(leases.map(lease => lease.drained)).then(results => {
          if (results.some(result => result.status === 'rejected')) {
            if (state === 'new' || state === 'starting' || state === 'ready') { state = 'failed'; void cleanup(); }
            report(3, true); throw new ConnectorOwnerUnavailable();
          }
          drained = true;
        }),
        resume: () => {
          if (state !== 'ready' || !drained || resumed) return false;
          resumed = true;
          for (const lease of leases) {
            let ok = false; try { ok = lease.resume(); } catch { /* Remain fenced. */ }
            if (!ok) {
              state = 'failed'; report(3, true);
              for (const stop of [() => agents.pauseQueueWorkers(), () => openclaw.pauseQueueWorker()]) {
                try { void stop().drained.catch(() => {}); } catch { /* Outer state remains failed. */ }
              }
              return false;
            }
          }
          pause = undefined; return true;
        },
      };
    };
    return {
      codex, sdk, hermes, openclaw, media, agents, http, start, close, pauseQueueWorkers,
      gatewayObserver: openclaw.gatewayObserver,
      get state() { return state; },
      get ready() { return state === 'ready' && !pause && (!codex.enabled || codex.status().available)
        && sdk.agents.every(agent => agent.id === 'claude-code' ? sdk.claude?.ready : agent.id === 'ghcp' ? sdk.copilot?.ready : sdk.antigravity?.ready)
        && (!hermes.agents.length || hermes.ready) && openclaw.ready; },
      refreshProjection: (settings: { maxAgeMs?: number } = {}) => {
        try { check(); } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
        return retain(() => projection.refresh(settings));
      },
      assertProjectionCurrent: () => { check(); projection.assertCurrent(); },
    };
  } catch {
    report(0, true); await cleanup(); throw new ConnectorOwnerUnavailable();
  }
}

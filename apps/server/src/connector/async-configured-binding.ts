import { readOpenClawAgentNames } from '../openclaw/cli.js';
import type { ServerConfig } from '../config.js';
import { bridgeArtifactReferences } from '../messages/artifact-receiver.js';
import { AsyncArtifactRegistry } from '../messages/async-artifact-registry.js';
import { MediaLibrary } from '../routes/media-library.js';
import { normalizeMessageText } from '../messages/normalize.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createFallbackAgentCatalog } from './agent-catalog.js';
import { createAsyncOpenClawBinding, type AsyncOpenClawBindingPorts } from './async-openclaw-binding.js';
import type { ConnectorSurfaceBinding, ConnectorSurfaceContext } from './async-connector-surface.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import type { AsyncRuntimeAssemblyPorts } from './async-runtime-assembly.js';
import { AdminRpcClient } from '../gateway/admin-client.js';

type Assembly = Parameters<NonNullable<ConnectorSurfaceBinding['attach']>>[0];
export type AsyncConfiguredBindingPorts = {
  openclaw?: AsyncOpenClawBindingPorts;
  native?: AsyncRuntimeAssemblyPorts;
  /** Original directory I/O only; display names never grant authority. */
  registry?: () => Promise<string[]>;
};

/** Original configured I/O and native factories, not another database root.
 * Inert until the surface attaches and starts its sole assembly. The surface
 * drains that assembly before releasing this binding or its startup SQL owner. */
export async function createAsyncConfiguredBinding(config: ServerConfig, context: ConnectorSurfaceContext,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, ports: AsyncConfiguredBindingPorts = {}): Promise<ConnectorSurfaceBinding> {
  let assembly: Assembly | undefined, closed = false, closing: Promise<void> | undefined;
  const tasks = createTaskDrain();
  const registry = await AsyncArtifactRegistry.open(config.artifactReceiver.indexFile);
  const library = new MediaLibrary({ ...config.mediaLibrary, signingSecret: config.mediaLibrary.signingSecret ?? config.accessKey });
  const media = { inboundDir: config.inboundMediaDir,
    artifactConfig: config.artifactReceiver, artifactRegistry: registry, library };
  const current = () => {
    if (closed || !assembly || assembly.state !== 'starting' && assembly.state !== 'ready') throw new ConnectorOwnerUnavailable();
    return assembly;
  };
  // Do not consult assembly.ready: it includes OpenClaw/Hermes readiness,
  // which deliberately depends on this local lifecycle veto.
  const executionAvailable = () => !closed && !!assembly && (assembly.state === 'starting' || assembly.state === 'ready');
  const report = (step: number, failed: boolean) => {
    const trace = guardedTrace(diagnostics, 'connector-runtime-assembly');
    trace.add('step', step); trace.finish(failed);
  };
  let openclaw: Awaited<ReturnType<typeof createAsyncOpenClawBinding>> | undefined;
  let catalog: ReturnType<typeof createFallbackAgentCatalog> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    const drained = tasks.close();
    // Freeze catalog admission too, retaining its accepted physical read.
    const catalogDrain = catalog?.close();
    return closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([drained, catalogDrain]);
      results.push(...await Promise.allSettled([Promise.resolve().then(() => openclaw?.close())]));
      results.push(...await Promise.allSettled([registry.close()]));
      const failed = results.some(result => result.status === 'rejected'); report(53, failed);
      if (failed) throw new ConnectorOwnerUnavailable();
    });
  };
  try {
    openclaw = await createAsyncOpenClawBinding({ config, deck: context.deck, snapshot: context.snapshot,
      artifactRegistry: registry, diagnostics, admissionAvailable: executionAvailable,
      refreshDirectories: async (settings?: { maxAgeMs?: number }) => {
        const original = current();
        const results = await Promise.allSettled([
          original.sdk.refreshDirectories(),
          ...(original.codex.enabled ? [original.codex.refreshSessions({ maxAgeMs: settings?.maxAgeMs ?? 0 })] : []),
        ]);
        current();
        if (results.some(result => result.status === 'rejected')) throw new ConnectorOwnerUnavailable();
      },
    }, ports.openclaw);
    const original = openclaw;
    catalog = createFallbackAgentCatalog({ diagnostics,
      groups: () => context.deck.getSessionsState().groups,
      ...(config.localOpenClawCli ? { registry: ports.registry ?? (() => readOpenClawAgentNames(config.nativeFileRoots.home)) } : {}),
      ...(config.localOpenClawCli || config.gatewayWsUrl || config.adminRpcUrl ? { defaultAgentId: config.defaultAgentId } : {}),
      runtimes: () => {
        const runtime = current();
        return [
          ...(runtime.codex.enabled ? [{ id: 'codex', label: 'Codex · local harness', status: 'available' }] : []),
          ...(config.hermes?.enabled ? [{ id: 'hermes', label: 'Hermes · dedicated runtime', status: runtime.hermes.ready ? 'available' : 'degraded' }] : []),
          ...(runtime.sdk.claude ? [{ id: 'claude-code', label: 'Claude Code', status: runtime.sdk.claude.ready ? 'available' : 'degraded', readiness: runtime.sdk.claude.status }] : []),
          ...(runtime.sdk.copilot ? [{ id: 'ghcp', label: 'GitHub Copilot', status: runtime.sdk.copilot.ready ? 'available' : 'degraded', readiness: runtime.sdk.copilot.status }] : []),
        ];
      },
    });
    return {
      system: {
        gateway: original.gateway,
        admin: new AdminRpcClient({ url: config.adminRpcUrl, ownerToken: config.ownerToken }),
        memoryDiagnostics: () => {
          try { return { codex: current().codex.memoryDiagnostics() }; }
          catch { return {}; }
        },
      },
      media,
      runtimes: {
        codex: { inboundDir: config.inboundMediaDir, native: { ...config.codex, projectAssistant: async text => {
          const row = { role: 'assistant', text };
          const artifacts = await bridgeArtifactReferences(row, 'assistant', config.artifactReceiver, registry);
          return { text: normalizeMessageText(row, { bridgedRawMediaReferences: artifacts.bridgedReferences }), media: artifacts.media };
        } }, ...(config.codex.modelChoices ? { modelChoices: [...config.codex.modelChoices] } : {}) },
        sdk: {
          ...(config.claude ? { claude: structuredClone(config.claude) } : {}),
          ...(config.copilot ? { copilot: structuredClone(config.copilot) } : {}),
          gateway: () => original.gateway.status().connected ? 'connected' : 'disconnected',
          changed: key => { if (!closed) context.deck.append('interaction.updated', {}, { sessionKey: key }); },
        },
        hermes: { ...(config.hermes ? { config: structuredClone(config.hermes) } : {}), executionAvailable,
          // Original queue events are committed by worker commands. This is
          // display notification after the original history projection only.
          queueChanged: key => { if (!closed) context.deck.append('session.updated', {}, { sessionKey: key }); } },
        openclaw: original.runtimes,
        media: { inboundDir: config.inboundMediaDir,
          artifactConfig: media.artifactConfig, artifactRegistry: registry,
          ...(config.sourcePreview ? { sourcePreview: config.sourcePreview } : {}),
          refreshMessages: original.refreshMessages },
      },
      ...(ports.native ? { native: ports.native } : {}),
      attach(value) {
        if (closed || assembly || value.state !== 'new') throw new ConnectorOwnerUnavailable();
        original.attach(value); assembly = value; report(51, false);
      },
      refreshSessions: (settings: { maxAgeMs?: number } = {}) => tasks.run(async () => {
        current(); await original.refreshSessions({ maxAgeMs: settings.maxAgeMs ?? 0 }); current(); report(52, false);
      }),
      agents: () => tasks.run(async () => { current(); const rows = await catalog!.list(); current(); return rows; }),
      close,
    };
  } catch {
    report(50, true); await close().catch(() => {}); throw new ConnectorOwnerUnavailable();
  }
}

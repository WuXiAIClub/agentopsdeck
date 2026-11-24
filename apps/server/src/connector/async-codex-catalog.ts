import type { SessionSkills } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorCodexCatalogOutput, type CodexCatalogScope, type CodexCatalogFailure } from './connector-codex-catalog-domain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Models = Array<{ id: string; label: string }>;
type Reply<T> = { value: T } | CodexCatalogFailure;
export class AsyncCodexCatalog {
  private readonly pending = new Set<Promise<void>>();
  private frozen = false;
  private closing?: Promise<void>;
  private readonly deps: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: { readonly enabled: boolean; listModels(): Promise<Models>; listSessionSkills(key: string): Promise<SessionSkills> };
    local(): void;
    sessionExists(key: string): boolean;
    defaultModel: string;
    modelProvider?: string;
    modelChoices?: readonly string[];
    diagnostics?: PerformanceDiagnostics;
  };
  constructor(deps: AsyncCodexCatalog['deps']) {
    this.deps = { ...deps };
  }
  private read<T>(input: CodexCatalogScope, run: () => Promise<T>): Promise<Reply<T>> {
    if (this.frozen || this.pending.size >= 16) return Promise.reject(new ConnectorOwnerUnavailable());
    const original = structuredClone(input);
    const work = Promise.resolve().then(async (): Promise<Reply<T>> => {
      const trace = guardedTrace(this.deps.diagnostics ?? performanceDiagnostics, 'codex-dispatch');
      trace.add('step', original.kind === 'models' ? 54 : 55);
      let failed = true;
      try {
        const before = await this.deps.owner.command('codexCatalogAuthorize', original);
        if (!validConnectorCodexCatalogOutput('codexCatalogAuthorize', before)) throw new ConnectorOwnerUnavailable();
        if ('error' in before) return before;
        if (this.frozen) throw new ConnectorOwnerUnavailable();
        this.deps.local();
        // Preserve the original disabled-runtime response even for absent Deck rows.
        if (!this.deps.runtime.enabled) return { error: original.kind === 'models' ? 404 : 409 };
        const check = () => {
          if (this.frozen) throw new ConnectorOwnerUnavailable();
          this.deps.local();
          if (original.kind === 'skills' && !this.deps.sessionExists(original.key)) throw new MissingSession();
        };
        check();
        const value = await run();
        check();
        const after = await this.deps.owner.command('codexCatalogDeliver', { ...original, readerId: before.readerId });
        if (!validConnectorCodexCatalogOutput('codexCatalogDeliver', after)) throw new ConnectorOwnerUnavailable();
        if ('error' in after) return after;
        if (after.readerId !== before.readerId) throw new ConnectorOwnerUnavailable();
        check(); failed = false; return { value };
      } catch (error) {
        if (error instanceof MissingSession) return { error: 404 };
        throw error;
      } finally { trace.finish(failed); }
    });
    const done = () => { this.pending.delete(drain); };
    const drain = Promise.prototype.then.call(work, done, done) as Promise<void>;
    this.pending.add(drain);
    return work;
  }
  models(input: { authorization: string }): Promise<Reply<Models>> {
    return this.read({ authorization: input.authorization, kind: 'models' }, async () => {
      return structuredClone(await this.deps.runtime.listModels());
    });
  }
  skills(input: { authorization: string; key: string }): Promise<Reply<SessionSkills>> {
    const key = input.key;
    return this.read({ authorization: input.authorization, kind: 'skills', key }, async () => structuredClone(await this.deps.runtime.listSessionSkills(key)));
  }
  freeze() { this.frozen = true; }
  close(): Promise<void> {
    this.freeze();
    return this.closing ??= Promise.resolve().then(async () => { await Promise.all([...this.pending]); });
  }
}
class MissingSession extends Error {}

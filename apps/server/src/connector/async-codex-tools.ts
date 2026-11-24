import type { CodexAppServer } from '../codex/app-server.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorCodexToolsOutput, type ConnectorCodexToolsCommands, type CodexToolsRef } from './connector-codex-tools-domain.js';

type Input = ConnectorCodexToolsCommands['codexToolsBind']['input'];
type Binding = { ref: CodexToolsRef; stop(): Promise<void> };

/** Original FIFO task-tool ownership only. It never opens SQL, authorizes a
 * different actor, settles execution, retries a native effect or expires a lease.
 * Composition closes dispatch first, this bridge second, executor/owner last. */
export class AsyncCodexTools {
  private readonly bindings = new Map<string, Binding>();
  private readonly keys = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private frozen = false;
  private closing?: Promise<void>;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: Pick<CodexAppServer, 'bindOwnedBoardTools' | 'stopConnectionId'>;
  }) {}

  prepare(input: Input): Promise<void> {
    if (this.frozen || this.keys.has(input.sessionKey) || this.pending.size >= 128) return Promise.reject(new ConnectorOwnerUnavailable());
    const key = input.sessionKey; this.keys.add(key);
    let snapshot: Input, failure: { error: unknown } | undefined;
    const task = Promise.resolve().then(() => {
      if (failure) throw failure.error;
      return this.once(snapshot);
    });
    const release = () => { this.keys.delete(key); this.pending.delete(drain); };
    const drain = task.then(release, release); this.pending.add(drain);
    try { snapshot = structuredClone(input); } catch (error) { failure = { error }; }
    return task;
  }

  close(): Promise<void> {
    this.frozen = true;
    return this.closing ??= (async () => {
      // In-progress prepare sees frozen after its IPC await and cannot install.
      await Promise.allSettled([...this.pending]);
      const bindings = [...this.bindings.values()]; this.bindings.clear();
      const results = await Promise.allSettled(bindings.map(binding => this.release(binding)));
      if (results.some(result => result.status === 'rejected')) throw new ConnectorOwnerUnavailable();
    })();
  }

  private local(input: Input) {
    if (this.frozen || this.options.runtime.stopConnectionId !== input.connectionId) throw new ConnectorOwnerUnavailable();
  }

  private async release(binding: Binding) {
    // Abort/await physical HTTP and permission work before worker revocation.
    await binding.stop();
    const released = await this.options.owner.command('codexToolsRelease', binding.ref);
    if (typeof released !== 'boolean') throw new ConnectorOwnerUnavailable();
  }

  private async once(input: Input) {
    this.local(input);
    const previous = this.bindings.get(input.sessionKey);
    if (previous) {
      await this.release(previous);
      this.bindings.delete(input.sessionKey);
      this.local(input);
    }
    const reply = await this.options.owner.command('codexToolsBind', input);
    if (!validConnectorCodexToolsOutput('codexToolsBind', reply) || !reply) throw new ConnectorOwnerUnavailable();
    if (!reply.enabled) { this.local(input); return; }
    const ref = structuredClone(reply.ref);
    if (ref.sessionKey !== input.sessionKey || ref.commandId !== input.commandId || ref.connectionId !== input.connectionId)
      throw new ConnectorOwnerUnavailable();
    let stop = () => Promise.resolve();
    try {
      this.local(input);
      stop = this.options.runtime.bindOwnedBoardTools(input, async runId => {
        try {
          this.local(input);
          const permitted = await this.options.owner.command('codexToolsCheck', { ...ref, runId });
          this.local(input);
          return permitted === true;
        } catch { return false; }
      });
      this.local(input);
      this.bindings.set(input.sessionKey, { ref, stop });
    } catch (error) {
      await this.release({ ref, stop });
      throw error;
    }
  }
}

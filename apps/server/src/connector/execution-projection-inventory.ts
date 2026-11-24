import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { CONNECTOR_COMMAND_BYTES, CONNECTOR_RESULT_BYTES, ConnectorOwnerUnavailable, encodeConnectorOwnerJson,
  validConnectorOwnerOutput } from './connector-owner-domain.js';
import { EXECUTION_READ_BATCH } from './connector-execution-domain.js';

/** A moving committed head is not a corrupt journal or failed executor. The
 * caller may request a later read, but must not deliver the old map as fresh. */
export class ExecutionProjectionChanged extends ConnectorOwnerUnavailable {}

/** Internal bounded read barrier, not a generic worker/RPC method. The original
 * projection supplies its runtime-specific validated reader. Never publishes a
 * partial directory, waits for native idle, writes a fact or retries an effect. */
export async function executionProjectionInventory<T>(options: {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  runtime: 'codex' | 'openclaw';
  validKey(key: unknown): key is string;
  decode(value: unknown, key: string): T | null;
  maxFacts: number;
  maxBytes: number;
}): Promise<{ facts: Map<string, T>; bytes: number }> {
  const head = async () => {
    const value: unknown = JSON.parse(encodeConnectorOwnerJson(await options.owner.command('eventProjectionHead', {})));
    if (!validConnectorOwnerOutput('eventProjectionHead', value)) throw new ConnectorOwnerUnavailable();
    return value as { cursor: string; version: string };
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await head(), facts = new Map<string, T>();
    let after = '', bytes = 0, scanned = 0, missing = false;
    for (;;) {
      const page: unknown = JSON.parse(encodeConnectorOwnerJson(await options.owner.command('executionSessionPage', {
        runtime: options.runtime, after, limit: 64,
      }), CONNECTOR_RESULT_BYTES));
      if (!Array.isArray(page) || page.length > 64) throw new ConnectorOwnerUnavailable();
      if (!page.length) break;
      let keys: string[] = [], inputBytes = Buffer.byteLength(JSON.stringify({ runtime: options.runtime, keys }));
      const flush = async () => {
        if (!keys.length) return;
        const reply: unknown = JSON.parse(encodeConnectorOwnerJson(
          await options.owner.command('executionFactBatch', { runtime: options.runtime, keys }), CONNECTOR_RESULT_BYTES));
        if (!Array.isArray(reply) || reply.length !== keys.length) throw new ConnectorOwnerUnavailable();
        for (const [index, key] of keys.entries()) {
          const fact = options.decode(reply[index], key);
          if (fact === null) missing = true;
          else {
            bytes += Buffer.byteLength(encodeConnectorOwnerJson(fact));
            if (bytes > options.maxBytes) throw new ConnectorOwnerUnavailable();
            facts.set(key, fact);
          }
        }
        keys = [];
        inputBytes = Buffer.byteLength(JSON.stringify({ runtime: options.runtime, keys }));
      };
      for (const key of page) {
        if (!options.validKey(key) || Buffer.compare(Buffer.from(key), Buffer.from(after)) <= 0) throw new ConnectorOwnerUnavailable();
        if (++scanned > options.maxFacts) throw new ConnectorOwnerUnavailable();
        const keyBytes = Buffer.byteLength(JSON.stringify(key));
        if (keys.length && (keys.length === EXECUTION_READ_BATCH || inputBytes + 1 + keyBytes > CONNECTOR_COMMAND_BYTES)) await flush();
        inputBytes += keyBytes + (keys.length ? 1 : 0);
        keys.push(key);
        after = key;
      }
      await flush();
    }
    const confirmed = await head();
    if (before.cursor !== confirmed.cursor || before.version !== confirmed.version) continue;
    if (missing) throw new ConnectorOwnerUnavailable();
    return { facts, bytes };
  }
  throw new ExecutionProjectionChanged();
}

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';

export const openClawFixtureKey = (name: string) => `agent:main:dashboard:${name}`;

/** Seed only uninvoked original work BEFORE opening the sole production worker.
 * Live execution facts are created after ready by its existing fixed commands.
 * No recovery bypass, parallel SQLite connection, native call or SQL command. */
export async function seedOpenClawOwnerTurns(store: ConnectorUserStore, directory: string,
  turns: readonly { key: string; id: string; mirror?: boolean }[]) {
  const tokenFile = join(directory, 'live-fixture-tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, undefined, new PerformanceDiagnostics(() => {}));
  const actor = tokens.create({ label: 'Original fixture caller', scopes: ['messages:send', 'messages:mirror'] }).record.id;
  for (const turn of turns) {
    const explicitRoute = { originatingChannel: 'test', originatingTo: 'original', outboundTarget: 'original' };
    if (turn.mirror) store.mirrorOutbox.upsert({ actorId: actor, sessionKey: turn.key, after: 1,
      inputText: 'original fixture input', idempotencyKey: turn.id,
      explicitRoute });
    await store.turns.enqueueAsync('openclaw', {
      sessionKey: turn.key, id: turn.id, createdAt: 1,
      payload: { actorId: actor, message: 'original fixture input', deliveryMode: turn.mirror ? 'mirror' : 'web-only', media: [],
        ...(turn.mirror ? { explicitRoute } : {}) },
    });
  }
  return { tokenFile };
}

/** Claim an original FIFO row without invoking a native runtime. Tests deliver
 * their own ACK/observation only after this production transaction succeeds. */
export async function claimOpenClawOwnerTurn(owner: Pick<AsyncConnectorOwner, 'command'>,
  key: string, connectionId: string, cli = false) {
  const plan = await owner.command('openClawDispatchPlan', { key });
  assert.ok(plan && plan !== 'blocked', 'original queued work must be currently authorized');
  const claimed = await owner.command('openClawDispatchClaim', { key, id: plan.turn.id, digest: plan.digest, connectionId });
  assert.ok(claimed, 'current sole owner must atomically claim original work');
  const ref = { key, id: claimed.turn.id, revision: claimed.execution.revision!, digest: claimed.digest };
  assert.equal(await owner.command('openClawDispatchReady', ref), true);
  if (!cli) return claimed;
  const fallback = await owner.command('openClawDispatchCli', ref);
  assert.ok(fallback, 'original invocation must switch transport before CLI callbacks');
  return fallback;
}

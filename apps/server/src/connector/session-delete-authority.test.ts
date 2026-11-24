import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteConnectorSession } from './session-delete.js';
import { SynchronousEffectAuthorityError } from '../auth/synchronous-effect-authority.js';

const sessions = ['claude-code:synthetic', 'ghcp:synthetic', 'hermes:synthetic', 'codex:synthetic', 'agent:synthetic'];

function fixture(key: string, wait?: () => Promise<void>) {
  const effects: string[] = [];
  const native = async (_key: string, authorize: () => void, acknowledge: () => void) => {
    effects.push('entered');
    await wait?.();
    authorize();
    effects.push('native'); acknowledge();
  };
  const deps: Parameters<typeof deleteConnectorSession>[0] = {
    gateway: { async requestBound<T = unknown>(method: string, _body: unknown, _connection?: string, authorize?: () => void) {
      await wait?.(); authorize?.(); effects.push(method);
      const payload = method === 'sessions.describe' ? { session: { key } } : { ok: true, key, deleted: true };
      return { connectionId: 'synthetic-connection', payload: payload as T };
    } },
    store: { removeSession() { effects.push('projection'); return true; } },
    refreshSessions: async () => { effects.push('refresh'); await wait?.(); },
    codex: { owns: (value: string) => value.startsWith('codex:'), remove: native },
    hermes: { remove: native }, claude: { ready: true, remove: native }, copilot: { ready: true, remove: native },
  };
  return { effects, run: (authorize: () => void) => deleteConnectorSession(deps, key,
    authorize, () => { effects.push('acknowledged'); }) };
}

for (const key of sessions) {
  test(`${key}: original async authority cannot begin deletion, refresh, projection or acknowledgement`, async () => {
    const f = fixture(key); let calls = 0;
    await assert.rejects(f.run(async () => { calls++; }), SynchronousEffectAuthorityError);
    assert.equal(calls, 0); assert.deepEqual(f.effects, []);
  });
  test(`${key}: promise authority after admission cannot reach a native delete or acknowledgement`, async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(key, () => gate);
    let allowed = true;
    const pending = f.run(() => allowed ? undefined : Promise.resolve());
    const rejected = assert.rejects(pending, SynchronousEffectAuthorityError);
    allowed = false; release(); await rejected;
    assert.deepEqual(f.effects, key.startsWith('agent:') ? ['refresh'] : ['entered']);
  });
  test(`${key}: original synchronous rejection retains identity and has no effects`, async () => {
    const f = fixture(key), failure = new Error('original authority');
    await assert.rejects(f.run(() => { throw failure; }), error => error === failure);
    assert.deepEqual(f.effects, []);
  });
  test(`${key}: synchronous authority preserves the existing successful deletion contract`, async () => {
    const f = fixture(key);
    assert.deepEqual(await f.run(() => {}), { ok: true });
    assert.deepEqual(f.effects, key.startsWith('agent:')
      ? ['refresh', 'sessions.describe', 'sessions.delete', 'acknowledged', 'projection']
      : ['entered', 'native', 'acknowledged']);
  });
}

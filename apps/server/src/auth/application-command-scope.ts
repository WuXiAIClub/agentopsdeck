import { types } from 'node:util';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

const actions = ['create', 'message', 'stop', 'compact', 'settings', 'delete', 'queue', 'interaction', 'files', 'usage'] as const;
const runtimes = ['codex', 'openclaw', 'claude-code', 'ghcp', 'antigravity', 'hermes'] as const;
const stages = ['admission', 'prepare', 'effect'] as const;
export type ApplicationCommandIntent = Readonly<{
  action: typeof actions[number]; runtime: typeof runtimes[number]; resource: string;
  commandKey: string; payloadDigest: string;
}>;
export type ApplicationCommandStage = typeof stages[number];
export type ApplicationCommandScope = Readonly<{
  intent: ApplicationCommandIntent;
  /** Current original Auth observation, NOT a Connector transaction grant. */
  authorize(stage: ApplicationCommandStage): Promise<void>;
  /** Local lifetime/cancellation only, NEVER native or transaction authority. */
  local(): void;
}>;
export class ApplicationCommandScopeError extends Error {
  constructor(readonly code: 'invalid' | 'capacity' | 'unavailable' | 'unauthorized' | 'cancelled' | 'expired') {
    super(`Application command scope ${code}`);
  }
}
const fail = (code: ApplicationCommandScopeError['code']) => new ApplicationCommandScopeError(code);

function copyIntent(input: ApplicationCommandIntent): ApplicationCommandIntent {
  if (!input || typeof input !== 'object' || types.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw fail('invalid');
  const fields = Object.getOwnPropertyDescriptors(input);
  const names = ['action', 'runtime', 'resource', 'commandKey', 'payloadDigest'] as const;
  if (Reflect.ownKeys(fields).length !== names.length
    || names.some(name => !fields[name] || !('value' in fields[name]!))) throw fail('invalid');
  const values = Object.fromEntries(names.map(name => [name, fields[name]!.value]));
  const text = (value: unknown, max: number): value is string => typeof value === 'string'
    && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  if (!(actions as readonly unknown[]).includes(values.action) || !(runtimes as readonly unknown[]).includes(values.runtime)
    || !text(values.resource, 4096) || Buffer.byteLength(values.resource) > 4096
    || typeof values.commandKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(values.commandKey)
    || typeof values.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(values.payloadDigest)) throw fail('invalid');
  return Object.freeze(values) as ApplicationCommandIntent;
}

/** Application-side lifetime owner. No worker, credential cache, receipt store,
 * synthetic bearer or synchronous-effect permission is created here. The
 * business chain must still pair its original admission/claim/settlement.
 * Closing/cancellation prohibit future checks, not settlement of an old effect.
 */
export function createApplicationCommandScopes(deps: {
  authorize(request: Request): boolean | Promise<boolean>;
  assertAvailable(): void;
  capacity?: number;
  diagnostics?: PerformanceDiagnostics;
}) {
  // Retain dependencies once, including the original authorization endpoint.
  const { authorize, assertAvailable, capacity = 128, diagnostics = performanceDiagnostics } = deps;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024
    || typeof authorize !== 'function' || typeof assertAvailable !== 'function' || types.isAsyncFunction(assertAvailable)) throw fail('invalid');
  let pending = 0, closed: Promise<void> | undefined, finishClose: (() => void) | undefined;
  const unknownPhysical = new Set<Promise<unknown>>();
  const available = () => {
    if (closed) throw fail('unavailable');
    try {
      const result: unknown = assertAvailable();
      if (result !== undefined) {
        if (types.isPromise(result)) {
          try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* Never authorizes. */ }
        }
        throw fail('unavailable');
      }
    }
    catch { throw fail('unavailable'); }
    if (closed) throw fail('unavailable');
  };
  const run = <Result>(request: Request, input: ApplicationCommandIntent,
    task: (scope: ApplicationCommandScope) => Promise<Result>): Promise<Result> => {
    try {
      available();
      if (pending >= capacity) throw fail('capacity');
      if (typeof task !== 'function') throw fail('invalid');
      const intent = copyIntent(input), signal = request.signal;
      if (signal.aborted) throw fail('cancelled');
      // Snapshot only original credential headers; never consume a request body
      // or expose the private copy. Each recheck gets a fresh independent Request.
      const headers: [string, string][] = [];
      let bytes = 0;
      for (const name of ['authorization', 'x-agentopsdeck-key', 'cookie']) {
        const value = request.headers.get(name);
        if (value !== null) { bytes += Buffer.byteLength(value); headers.push([name, value]); }
      }
      if (bytes > 65_536) throw fail('invalid');
      available();
      if (pending >= capacity) throw fail('capacity');
      pending++;
      let ended = false, released = false, failed = false, observationUnknown = false, checks = 0;
      let poisoned: ApplicationCommandScopeError | undefined;
      // Publish retention before diagnostics/caller callbacks may reenter close.
      const trace = guardedTrace(diagnostics, 'application-command-scope');
      trace.add('admitted', 1);
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
      const release = () => {
        if (!ended || checks || released || observationUnknown) return;
        released = true; clearTimeout(warning);
        if (--pending === 0) finishClose?.();
        trace.add('settled', 1); trace.finish(failed || !!poisoned);
      };
      const local = () => {
        if (poisoned) throw poisoned;
        if (ended) throw fail('expired');
        try { available(); if (signal.aborted) throw fail('cancelled'); }
        catch (error) { poisoned = error instanceof ApplicationCommandScopeError ? error : fail('unavailable'); throw poisoned; }
      };
      const observeOriginal = <Value>(original: Promise<Value>) => new Promise<Value>((resolve, reject) => {
        try { void Promise.prototype.then.call(original, resolve, reject); }
        catch {
          // A hostile constructor/species can prevent even intrinsic Promise
          // observation. Refuse the waiter but do NOT certify physical drain,
          // close its owner, assimilate a custom then or replay the command.
          observationUnknown = true; unknownPhysical.add(original);
          poisoned ??= fail('unavailable'); trace.add('unknown', 1); reject(poisoned);
        }
      });
      const scope: ApplicationCommandScope = Object.freeze({ intent, local,
        async authorize(stage: ApplicationCommandStage) {
          try {
            local();
            if (!(stages as readonly unknown[]).includes(stage)) throw fail('invalid');
            if (checks >= 8) throw fail('capacity');
          } catch (error) {
            poisoned ??= error instanceof ApplicationCommandScopeError ? error : fail('unavailable'); throw poisoned;
          }
          checks++;
          const checking = guardedTrace(diagnostics, 'application-command-authority');
          checking.add('step', stages.indexOf(stage) + 1);
          let checkFailed = true;
          try {
            local(); // A diagnostic callback may have reentered close.
            const result = authorize(new Request('http://application-auth.invalid/', { headers }));
            // Observe the original physical Promise, not its mutable .then.
            const allowed = types.isPromise(result) ? await observeOriginal(result) : result;
            local();
            if (allowed !== true) throw fail(allowed === false ? 'unauthorized' : 'unavailable');
            checkFailed = false;
          } catch (error) {
            poisoned ??= error instanceof ApplicationCommandScopeError ? error : fail('unavailable'); throw poisoned;
          } finally { checks--; release(); checking.finish(checkFailed); }
        },
      });
      // Keep physical completion private: modifying the caller's returned
      // Promise cannot shorten lifetime, drop a late ACK or close its owner.
      const physical = (async () => {
        await scope.authorize('admission');
        local();
        const result = task(scope);
        if (!types.isPromise(result)) throw fail('invalid');
        return await observeOriginal(result);
      })();
      return new Promise<Result>((resolve, reject) => {
        void Promise.prototype.then.call(physical, (result: Result) => {
          ended = true; release(); resolve(result);
        }, (error: unknown) => {
          failed = true; ended = true; trace.add('unknown', 1); release(); reject(error);
        });
      });
    } catch (error) { return Promise.reject(error); }
  };
  const close = () => {
    if (closed) return closed;
    closed = new Promise<void>(resolve => { finishClose = resolve; });
    if (pending === 0) finishClose!();
    return closed;
  };
  return Object.freeze({ run, close, get pending() { return pending; } });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthPersistenceError } from './private-store.js';
import { synchronousAuthorizationCall } from './synchronous-authorization.js';

function faulting(fault: string) {
  const diagnostics = new PerformanceDiagnostics(() => {});
  const start = diagnostics.start.bind(diagnostics);
  let hits = 0;
  diagnostics.start = operation => {
    if (fault === 'start') { hits++; throw Error('observer failed'); }
    const trace = start(operation);
    return {
      add(metric, value) {
        if (metric === fault) { hits++; throw Error('observer failed'); }
        trace.add(metric, value);
      },
      reportPending: snapshot => trace.reportPending(snapshot),
      finish(failed) {
        if (fault === 'finish') { hits++; throw Error('observer failed'); }
        trace.finish(failed);
      },
    };
  };
  return { diagnostics, hits: () => hits };
}

for (const fault of ['start', 'step', 'finish']) for (const verdict of [true, false, 'error'] as const) {
  test(`authorization observation ${fault} preserves ${verdict}`, () => {
    const observer = faulting(fault);
    let calls = 0, inspections = 0;
    const run = () => synchronousAuthorizationCall(() => {
      calls++;
      if (verdict === 'error') throw Error('original persistence failure');
      return verdict;
    }, [], () => { inspections++; }, undefined, observer.diagnostics);
    if (verdict === 'error') assert.throws(run, AuthPersistenceError);
    else assert.equal(run(), verdict);
    assert.equal(calls, 1);
    assert.equal(inspections, verdict === 'error' ? 0 : 1);
    assert.ok(observer.hits() > 0);
  });
}

for (const fault of ['start', 'deferred', 'step', 'finish']) {
  test(`authorization observation ${fault} never starts an asynchronous guard`, () => {
    const observer = faulting(fault);
    let calls = 0;
    const asyncGuard = async () => { calls++; return true; };
    assert.equal(synchronousAuthorizationCall(asyncGuard as unknown as () => boolean,
      [], undefined, undefined, observer.diagnostics), false);
    assert.equal(calls, 0);
    assert.ok(observer.hits() > 0);
  });
}

for (const fault of ['start', 'unknown', 'step', 'finish']) for (const inspectorThrows of [false, true]) {
  test(`authorization observation ${fault} retains rejected native participant (${inspectorThrows})`, () => {
    const extension = import.meta.url.endsWith('.js') ? '.js' : '.ts';
    const result = spawnSync(process.execPath, [
      ...process.execArgv.filter(arg => !arg.startsWith('--test')),
      '--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import { PerformanceDiagnostics } from ${JSON.stringify(new URL('../diagnostics/performance' + extension, import.meta.url).href)};
        import { synchronousAuthorizationCall } from ${JSON.stringify(new URL('./synchronous-authorization' + extension, import.meta.url).href)};
        import { AuthPersistenceError } from ${JSON.stringify(new URL('./private-store' + extension, import.meta.url).href)};
        const diagnostics = new PerformanceDiagnostics(() => {});
        let hits = 0, calls = 0, inspections = 0;
        diagnostics.start = () => {
          if (${JSON.stringify(fault)} === 'start') { hits++; throw Error('observer failed'); }
          return {
            add(metric) { if (metric === ${JSON.stringify(fault)}) { hits++; throw Error('observer failed'); } },
            reportPending() {},
            finish() { if (${JSON.stringify(fault)} === 'finish') { hits++; throw Error('observer failed'); } },
          };
        };
        const original = Promise.reject(Error('original rejected participant'));
        const run = () => synchronousAuthorizationCall(() => { calls++; return original; }, [], value => {
          inspections++; assert.equal(value, original);
          if (${inspectorThrows}) throw Error('original participant refusal');
        }, undefined, diagnostics);
        ${inspectorThrows ? 'assert.throws(run, AuthPersistenceError);' : 'assert.equal(run(), false);'}
        assert.equal(calls, 1); assert.equal(inspections, 1); assert.ok(hits > 0);
        await new Promise(resolve => setImmediate(resolve));
        console.log('original-rejection-observed');
      `,
    ], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, 'observer failures must not skip the original participant or its rejection observer');
    assert.match(result.stdout, /original-rejection-observed/);
  });
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { linuxProcessGroup } from './worker-supervision.js';

test('Linux group parser handles spaces and parentheses without confusing ppid and pgrp', () => {
  assert.equal(linuxProcessGroup('123 (worker (private)) S 456 123 789 0'), 123);
  assert.equal(linuxProcessGroup('2 (kthreadd) S 0 0 0 0'), 0);
  for (const invalid of ['', '123 no brackets S 1 2', '123 (worker) S 2 NaN', '123 (worker) S 2 -1']) {
    assert.throws(() => linuxProcessGroup(invalid));
  }
});

test('Live Linux worker owns its group, observes descendants and waits for their exit', { skip: process.platform !== 'linux' }, async () => {
  const source = import.meta.url.endsWith('.ts');
  const module = new URL(source ? './worker-supervision.ts' : './worker-supervision.js', import.meta.url);
  const marker = 'agentopsdeck-worker-group-verification-complete';
  // tsx creates an esbuild descendant in the group being tested. Native type
  // transformation loads the actual source without changing that process group.
  const sourceResolution = source ? `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL?.startsWith(${JSON.stringify(new URL('../', module).href)})
            && specifier.startsWith('.') && specifier.endsWith('.js')) {
          return next(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
        }
        return next(specifier, context);
      },
    });
  ` : '';
  const child = spawn(process.execPath, [...(source ? ['--experimental-transform-types'] : []), '--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { strict as assert } from 'node:assert';
    ${sourceResolution}
    const { claudeWorkerGroupEmpty, waitForClaudeWorkerGroup } = await import(${JSON.stringify(module.href)});
    assert.equal(await claudeWorkerGroupEmpty(), true);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    const exited = once(child, 'exit');
    try {
      assert.equal(await claudeWorkerGroupEmpty(), false);
      await assert.rejects(waitForClaudeWorkerGroup(30), /remain active/);
    } finally { child.kill('SIGKILL'); await exited; }
    await waitForClaudeWorkerGroup();
    process.stdout.write(${JSON.stringify(marker + '\n')});
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  let output = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }, 10_000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, errors);
    assert.equal(output, marker + '\n', 'Worker must finish every process-group assertion');
  } finally { clearTimeout(timeout); }
});

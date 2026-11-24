import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

export function liveInteractionOptions(args) {
  const [settingsFile, codexCommand, codexProvider, selected = 'codex,claude-code,ghcp', scenario = 'matrix', candidateRoot] = args;
  assert.ok(args.length <= 6 && ['matrix', 'pending', 'goals', 'questions', 'browser'].includes(scenario));
  assert.ok(candidateRoot === undefined || isAbsolute(candidateRoot), 'Candidate must be an absolute frozen release directory');
  assert.ok(isAbsolute(settingsFile ?? '') && isAbsolute(codexCommand ?? ''));
  const provider = new URL(codexProvider);
  assert.ok(provider.protocol === 'http:' && provider.hostname === '127.0.0.1' && provider.port
    && !provider.username && !provider.password && !provider.search && !provider.hash && provider.pathname === '/');
  const runtimes = selected.split(',');
  assert.ok(runtimes.length && runtimes.every(r => ['codex', 'claude-code', 'ghcp'].includes(r)) && new Set(runtimes).size === runtimes.length);
  assert.ok(scenario !== 'goals' || runtimes.includes('codex'), 'Goal acceptance requires Codex');
  return { settingsFile, codexCommand, codexProvider, selected, scenario, provider, runtimes, candidateRoot };
}

export function newTurnFailed(runtime, previousRunId) {
  return Boolean(runtime?.turnId && runtime.turnId !== previousRunId
    && ['failed', 'unknown', 'interrupted'].includes(runtime.phase));
}

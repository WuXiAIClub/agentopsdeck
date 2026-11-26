import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeClientGitRepo,
  readGitRepoSelection,
  saveGitRepoSelection,
  validClientGitRepo,
} from './git-repo-selection.js';

test('normalizeClientGitRepo and validClientGitRepo validate owner/repo slugs', () => {
  assert.equal(normalizeClientGitRepo(' https://github.com/WuXiAIClub/agentopsdeck.git '), 'WuXiAIClub/agentopsdeck');
  assert.equal(validClientGitRepo('WuXiAIClub/agentopsdeck'), true);
  assert.equal(validClientGitRepo('owner/repo.name_1'), true);
  assert.equal(validClientGitRepo('../escape'), false);
  assert.equal(validClientGitRepo('owner/..'), false);
  assert.equal(validClientGitRepo('only-owner'), false);
});

test('readGitRepoSelection and saveGitRepoSelection isolate scopes and cards', () => {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  try {
    const scopeA = 'a'.repeat(64);
    const scopeB = 'b'.repeat(64);
    saveGitRepoSelection(scopeA, 'card-1', { accountId: 'work', repo: 'https://github.com/WuXiAIClub/agentopsdeck.git' });
    assert.deepEqual(readGitRepoSelection(scopeA, 'card-1'), { accountId: 'work', repo: 'WuXiAIClub/agentopsdeck' });
    assert.equal(readGitRepoSelection(scopeA, 'card-2'), undefined);
    assert.equal(readGitRepoSelection(scopeB, 'card-1'), undefined);
    // Rejects invalid slugs without overwriting
    saveGitRepoSelection(scopeA, 'card-1', { accountId: 'work', repo: '../invalid' });
    assert.deepEqual(readGitRepoSelection(scopeA, 'card-1'), { accountId: 'work', repo: 'WuXiAIClub/agentopsdeck' });
  } finally {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  }
});

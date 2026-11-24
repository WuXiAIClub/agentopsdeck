import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkspaceFileRoot, syncWorkspaceDirectory } from './workspace-file-platform.js';
import { parseFileBoardPolicy } from './workspace-board-file-policy.js';
import { boardFilesContext } from './workspace-board-file-format.js';
import { cardFilesContext } from './workspace-file-card-format.js';
import type { open } from 'node:fs/promises';

test('Windows dedicated roots support drives, spaces, Unicode, slash input and UNC', () => {
  for (const [input, expected] of [
    ['C:\\AgentOpsDeck\\Card Files', 'C:\\AgentOpsDeck\\Card Files'],
    ['D:/Agent data/笔记', 'D:\\Agent data\\笔记'],
    ['\\\\server\\share\\cards', '\\\\server\\share\\cards'],
    ['//server/share/cards', '\\\\server\\share\\cards'],
  ]) assert.equal(normalizeWorkspaceFileRoot(input!, 'win32'), expected);
});
test('Windows root validation rejects ambiguous, device, traversal and ADS paths', () => {
  for (const input of ['C:', 'C:cards', 'C:\\', '\\cards', '/cards', '\\\\server\\share', '\\\\server\\share\\',
    '\\\\?\\C:\\cards', '\\\\.\\C:\\cards', 'C:\\cards\\..\\other', 'C:\\cards\\.\\other',
    'C:\\cards:secret', 'C:\\cards\\NUL', 'C:\\cards\\COM1.json', 'C:\\cards\\COM¹', 'C:\\cards\\a.', 'C:\\cards\\a ',
    'C:\\cards\\a?b', 'C:\\cards\n', 'C:\\cards\\', 'relative', 'C:\\' + 'x'.repeat(513)]) {
    assert.equal(normalizeWorkspaceFileRoot(input, 'win32'), undefined, input);
  }
});
test('POSIX semantics remain strict and do not reinterpret Windows as local roots', () => {
  assert.equal(normalizeWorkspaceFileRoot('/srv/card files/笔记', 'linux'), '/srv/card files/笔记');
  assert.equal(normalizeWorkspaceFileRoot('/Users/agent/cards', 'darwin'), '/Users/agent/cards');
  for (const value of ['/', '/srv/../cards', '/srv//cards', '/srv/cards/', 'C:\\cards', 'relative']) assert.equal(normalizeWorkspaceFileRoot(value, 'linux'), undefined);
});
test('operator Windows configuration normalizes only paths and refuses HOME case aliases', () => {
  const policies = [{ owner: 'local:file-boards', runtime: 'codex' }];
  assert.deepEqual(parseFileBoardPolicy(JSON.stringify({ root: 'D:/Cards', policies }), 'win32', 'C:\\Users\\agent'), { root: 'D:\\Cards', policies });
  assert.throws(() => parseFileBoardPolicy(JSON.stringify({ root: 'c:/USERS/Agent', policies }), 'win32', 'C:\\Users\\agent'));
});
test('Agent contexts preserve escaped Windows/UNC paths as JSON data, not shell fragments', () => {
  const paths = ['C:\\Agent Files\\笔记\\card.json', '\\\\server\\share\\cards\\tasks.json'];
  for (const text of [boardFilesContext(paths), cardFilesContext(paths)]) for (const path of paths) assert.ok(text.includes(JSON.stringify(path)));
});
test('Windows directory sync does not try a POSIX directory open; POSIX errors still fail closed', async () => {
  let opens = 0, syncs = 0, closes = 0;
  const fake = (async () => { opens++; return { sync: async () => { syncs++; }, close: async () => { closes++; } }; }) as unknown as typeof open;
  await syncWorkspaceDirectory('C:\\cards', 'win32', fake);
  assert.deepEqual([opens, syncs, closes], [0, 0, 0]);
  await syncWorkspaceDirectory('/cards', 'linux', fake);
  assert.deepEqual([opens, syncs, closes], [1, 1, 1]);
  const failing = (async () => ({ sync: async () => { throw Error('EIO'); }, close: async () => { closes++; } })) as unknown as typeof open;
  await assert.rejects(syncWorkspaceDirectory('/cards', 'darwin', failing), /EIO/);
  assert.equal(closes, 2);
});

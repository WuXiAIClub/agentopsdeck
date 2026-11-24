import assert from 'node:assert/strict';
import test from 'node:test';
import { startupOwnerPathKey } from './startup-owner.js';

// Pure key policy, not a native Windows filesystem or ACL acceptance.
for (const [first, alias] of [
  ['C:\\State\\owner.db', '\\\\?\\C:\\State\\owner.db'],
  ['C:\\State\\owner.db', '//?/c:/STATE/owner.DB'],
  ['\\\\Server\\Share\\State\\owner.db', '\\\\?\\UNC\\server\\share\\State\\owner.db'],
  ['\\\\Server\\Share\\State\\owner.db', '//?/UNC/server/share/STATE/owner.DB'],
] as const) test('filesystem namespace alias shares its conservative acquisition key: ' + alias, () => {
  assert.equal(startupOwnerPathKey(first, 'win32'), startupOwnerPathKey(alias, 'win32'));
});

for (const path of ['\\\\?\\C:\\State\\owner.db', '\\\\?\\UNC\\server\\share\\State\\owner.db'])
  test('Linux literal namespace is unchanged: ' + path, () => {
    assert.equal(startupOwnerPathKey(path, 'linux'), path);
  });

for (const path of ['\\\\?\\Volume{fixture}\\State\\owner.db', '\\\\?\\GLOBALROOT\\Device\\fixture', '\\\\.\\PhysicalDrive0'])
  test('non-filesystem namespace is not flattened into a filesystem alias: ' + path, () => {
    assert.notEqual(startupOwnerPathKey(path, 'win32'), startupOwnerPathKey(path.slice(4), 'win32'));
  });

test('drive-relative extended spelling is not made absolute by the key policy', () => {
  assert.notEqual(startupOwnerPathKey('\\\\?\\C:owner.db', 'win32'), startupOwnerPathKey('C:\\owner.db', 'win32'));
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readStartupFailure } from './startup-failure-metadata.js';
import { assertWindowsPrivatePath, PRIVATE_ACL_SCRIPT, powershellArguments, windowsControlEnvironment,
  windowsPowerShell, windowsPrivateControl, windowsPrivateControlScript } from './windows-private-worker.js';

const helper = fileURLToPath(new URL('../../../../runtime/private-path-check.exe', import.meta.url));
const native = { skip: process.platform !== 'win32'
  ? 'Requires a native Windows host; Linux is not Windows ACL acceptance'
  : !existsSync(helper) ? 'Requires the compiled Windows private-path verifier' : false, timeout: 30_000 };
const restrict = (path: string) => windowsPrivateControl(`
$p=$env:AOD_PRIVATE_PATH
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $p -AclObject $acl`, { AOD_PRIVATE_PATH: path });
function results(path: string) {
  const env = windowsControlEnvironment({ AOD_PRIVATE_PATH: path });
  const direct = spawnSync(helper, [], { env, windowsHide: true, encoding: 'utf8' });
  const fallback = spawnSync(windowsPowerShell(), powershellArguments(windowsPrivateControlScript(PRIVATE_ACL_SCRIPT)),
    { env, windowsHide: true, encoding: 'utf8' });
  assert.equal(direct.error, undefined);
  assert.equal(fallback.error, undefined);
  assert.deepEqual({ status: direct.status, value: direct.stdout.trim() },
    { status: fallback.status, value: fallback.stdout.trim() });
  return direct.stdout.trim();
}

test('native private ACL verifier matches strict PowerShell checks without caching authority', native, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-acl-native-'));
  try {
    restrict(root);
    const file = join(root, 'key'); await writeFile(file, 'synthetic-not-a-key');
    assert.equal(results(file), 'private');
    const start = performance.now();
    for (let i = 0; i < 3; i++) assertWindowsPrivatePath(file);
    assert.ok(performance.now() - start < 1_000, 'Three native ACL checks must finish within one second');
    windowsPrivateControl(`
$p=$env:AOD_PRIVATE_PATH;$acl=Get-Acl -LiteralPath $p
$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow'))
Set-Acl -LiteralPath $p -AclObject $acl`, { AOD_PRIVATE_PATH: file });
    assert.equal(results(file), '3');
    assert.throws(() => assertWindowsPrivatePath(file, 3), error => {
      assert.deepEqual(readStartupFailure(error), { controlReason: 6, aclReason: 3, controlTarget: 3 });
      return true;
    });
    assert.equal(results(join(process.env.SystemRoot!, 'System32', 'kernel32.dll')), '2');
    assert.equal(results(join(root, 'missing')), '4');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native private ACL verifier also rejects inherit-only grants to foreign principals', native, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-acl-inherit-'));
  try {
    restrict(root);
    const directory = join(root, 'child'); await mkdir(directory);
    windowsPrivateControl(`
$p=$env:AOD_PRIVATE_PATH;$acl=Get-Acl -LiteralPath $p
$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','ContainerInherit,ObjectInherit','InheritOnly','Allow'))
Set-Acl -LiteralPath $p -AclObject $acl`, { AOD_PRIVATE_PATH: directory });
    assert.equal(results(directory), '3');
    assert.throws(() => assertWindowsPrivatePath(directory));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native and fallback ACL verifiers reject null DACLs rather than treating no rules as private', native, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-acl-null-'));
  try {
    restrict(root);
    const file = join(root, 'public-null-acl'); await writeFile(file, 'synthetic-only');
    windowsPrivateControl(`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentOpsDeckNullAclFixture {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern uint SetNamedSecurityInfoW(string p,int t,uint i,IntPtr o,IntPtr g,IntPtr d,IntPtr s);
 public static void Set(string p) {
  if(SetNamedSecurityInfoW(p,1,0x80000004,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero)!=0)
   throw new Exception("null DACL fixture failed");
 }
}
'@
[AgentOpsDeckNullAclFixture]::Set($env:AOD_PRIVATE_PATH)`,
    { AOD_PRIVATE_PATH: file, TEMP: root, TMP: root });
    assert.equal(results(file), '3');
    assert.throws(() => assertWindowsPrivatePath(file));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing native companion retains strict fallback and malformed companions never fall back', native, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-acl-fallback-'));
  const saved = helper + '.fixture-backup';
  let moved = false, malformed = false;
  try {
    restrict(root);
    assert.equal(existsSync(saved), false, 'A previous fixture companion must not be overwritten');
    await rename(helper, saved); moved = true;
    assertWindowsPrivatePath(root);
    await writeFile(helper, 'not-an-executable', { flag: 'wx' }); malformed = true;
    assert.throws(() => assertWindowsPrivatePath(root));
  } finally {
    if (malformed) await rm(helper);
    if (moved) await rename(saved, helper);
    await rm(root, { recursive: true, force: true });
  }
});

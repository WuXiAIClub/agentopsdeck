import { parentPort } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { windowsPrivateControl } from '../connector/windows-private-worker.js';
import { startupDatabaseOwners } from './startup-owner.js';
import { StorageAdmissionDeferred } from './work-admission.js';
import { VolumeAdmission } from './volume-admission.js';
import { addSqlFailure } from './sql-failure-diagnostics.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { installVolumeAdmissionProtocol } from './volume-admission-protocol.js';

// This module owns the coordinator connection; it cannot execute on the main loop.
if (!parentPort) throw new Error('Admission worker requires a parent');
const coordinators = new Map<string, { db: DatabaseSync; admission: VolumeAdmission }>();
function windowsCoordinator() {
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = Join-Path $env:TEMP ('agentopsdeck-storage-admission-' + $sid.Value)
if (-not (Test-Path -LiteralPath $directory)) {
  New-Item -ItemType Directory -Path $directory | Out-Null
  $acl = Get-Acl -LiteralPath $directory
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $directory -AclObject $acl
}
$item = Get-Item -LiteralPath $directory -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'unsafe-coordinator-directory' }
foreach ($path in @($directory) + @(Get-ChildItem -LiteralPath $directory -Force | ForEach-Object { $_.FullName })) {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'unsafe-coordinator-file' }
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe-coordinator-owner' }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $rules.Count) { throw 'unsafe-coordinator-permissions' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow') { throw 'unsafe-coordinator-permissions' }
  }
}
[Console]::Write($directory)
`;
  try {
    return windowsPrivateControl(script, { TEMP: tmpdir(), TMP: tmpdir() });
  } catch { throw new StorageAdmissionDeferred('unsafe-coordinator-directory'); }
}
/** All local destinations on one physical volume share the same ledger. The
 * configured root is trusted server state, never an HTTP-provided path. */
export function volumeAdmission(root: string) {
  const device = String(statSync(root, { bigint: true }).dev);
  const cached = coordinators.get(device);
  // A previous destination may have been removed (temporary fixtures/exports).
  // Share its database, not its path or free-space sampler.
  if (cached) return new VolumeAdmission(cached.db, root);
  if (coordinators.size >= 32) throw new StorageAdmissionDeferred('volume-capacity');
  if (process.platform !== 'win32' && !process.getuid) throw new StorageAdmissionDeferred('volume-coordinator-unavailable');
  const uid = process.getuid?.(), directory = process.platform === 'win32'
    ? windowsCoordinator() : join(tmpdir(), `agentopsdeck-storage-admission-${uid}`);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const owned = lstatSync(directory);
  if (!owned.isDirectory() || owned.isSymbolicLink()
    || (process.platform !== 'win32' && (owned.uid !== uid || (owned.mode & 0o077) !== 0))) throw new StorageAdmissionDeferred('unsafe-coordinator-directory');
  const file = join(directory, `volume-${device}.sqlite`);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { const stat = lstatSync(file + suffix); if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && stat.uid !== uid) || stat.nlink !== 1) throw new StorageAdmissionDeferred('unsafe-coordinator-file'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  const trace = guardedTrace(performanceDiagnostics, 'storage-coordinator-startup');
  let db: DatabaseSync | undefined, failed = true, step = 1;
  try {
    db = startupDatabaseOwners.open(file); step = 2;
    chmodSync(file, 0o600); db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    step = 3;
    const coordinator = { db, admission: new VolumeAdmission(db, root) };
    coordinators.set(device, coordinator); trace.add('settled', 1); failed = false; return coordinator.admission;
  } catch (e) {
    trace.add('step', step); addSqlFailure(trace, e);
    // Retain the exact failed owner. A later startup can retry ONLY its close,
    // not the initialization body, and cannot replace an unconfirmed handle.
    if (db) { try { startupDatabaseOwners.abandon(db); } catch { trace.add('unknown', 1); } }
    throw e;
  } finally { trace.finish(failed); }
}


installVolumeAdmissionProtocol(parentPort, volumeAdmission);

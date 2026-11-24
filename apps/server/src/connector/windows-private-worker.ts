import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupFailure, readStartupFailure } from './startup-failure-metadata.js';

const denied = () => new Error('Windows private worker ownership could not be verified');

function windowsEnvironmentValue(env: NodeJS.ProcessEnv, name: string) {
  const entries = Object.entries(env).filter(([key]) => key.toUpperCase() === name.toUpperCase());
  if (entries.length > 1) throw denied();
  const value = entries[0]?.[1];
  if (value !== undefined && (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value))) throw denied();
  return value;
}

export function windowsWorkerEnvironment(homeDirectory: string,
  host: { execPath: string; env: NodeJS.ProcessEnv } = process): NodeJS.ProcessEnv {
  const systemRoot = windowsEnvironmentValue(host.env, 'SystemRoot');
  if (!systemRoot || !/^[A-Za-z]:\\[^\x00-\x1f"%]+$/.test(systemRoot)) throw denied();
  const homeRoot = win32.parse(homeDirectory).root;
  if (!/^[A-Za-z]:\\$/.test(homeRoot)) throw denied();
  const identity: NodeJS.ProcessEnv = {};
  for (const name of ['USERNAME', 'USERDOMAIN', 'LOGONSERVER']) {
    const value = windowsEnvironmentValue(host.env, name);
    if (value !== undefined) identity[name] = value;
  }
  // libuv supplies Windows identity variables even with an explicit env block.
  return { SystemRoot: systemRoot, WINDIR: systemRoot, ...identity,
    SYSTEMDRIVE: win32.parse(systemRoot).root.slice(0, -1),
    HOMEDRIVE: homeRoot.slice(0, -1), HOMEPATH: homeDirectory.slice(2),
    PATH: `${win32.dirname(host.execPath)};${win32.join(systemRoot, 'System32')}`,
    HOME: homeDirectory, USERPROFILE: homeDirectory,
    APPDATA: win32.join(homeDirectory, 'config'), LOCALAPPDATA: win32.join(homeDirectory, 'cache'),
    TEMP: win32.join(homeDirectory, 'tmp'), TMP: win32.join(homeDirectory, 'tmp') };
}

export function assertPrivateWorkerEnvironment(expectedEnvironment: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform, extraControls: readonly string[] = []) {
  const normalize = (name: string) => platform === 'win32' ? name.toUpperCase() : name;
  const expected = new Map(Object.entries(expectedEnvironment).map(([name, value]) => [normalize(name), value]));
  const actual = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(env)) {
    const key = normalize(name);
    if (actual.has(key)) throw denied();
    actual.set(key, value);
  }
  for (const [name, value] of expected) if (actual.get(name) !== value) throw denied();
  const controls = new Set(['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', ...extraControls].map(normalize));
  for (const name of actual.keys()) if (!expected.has(name) && !controls.has(name)) throw denied();
}

/** No PATH lookup, shell interpolation, inherited profile, or credential output. */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (!root || !/^[A-Za-z]:\\[^\x00-\x1f"%]+$/.test(root)) throw startupFailure(denied(), { controlReason: 1 });
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
export function windowsControlEnvironment(extra: NodeJS.ProcessEnv = {}, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const executable = windowsPowerShell(host);
  const root = win32.resolve(executable, '..', '..', '..', '..');
  return { SystemRoot: root, WINDIR: root, ...extra };
}
export function powershellArguments(script: string) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
export function windowsPrivateControlScript(script: string) {
  // Windows PowerShell otherwise uses the host code page for redirected
  // stdout. Node decodes UTF-8; non-ASCII profile paths must round-trip exactly.
  return "$ErrorActionPreference='Stop';\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n" + script;
}
export function windowsPrivateControl(script: string, extra: NodeJS.ProcessEnv = {}): string {
  try {
    const helper = script === PRIVATE_ACL_SCRIPT && process.platform === 'win32' ? nativePrivateAclHelper() : undefined;
    const result = spawnSync(helper ?? windowsPowerShell(),
      helper ? [] : powershellArguments(windowsPrivateControlScript(script)), {
        env: windowsControlEnvironment(extra), encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8192,
      });
    if (result.error || result.status !== 0) {
      let controlReason = 4, aclReason: number | undefined;
      if (result.error) controlReason = 'code' in result.error && result.error.code === 'ETIMEDOUT' ? 2 : 3;
      else if (script === PRIVATE_ACL_SCRIPT) {
        const index = ['1', '2', '3', '4'].indexOf(result.stdout.trim());
        if (index >= 0) { controlReason = 6; aclReason = index + 1; }
      }
      throw startupFailure(denied(), { controlReason, aclReason });
    }
    return result.stdout.trim();
  } catch (error) {
    if (!readStartupFailure(error).controlReason) startupFailure(error, { controlReason: 7 });
    throw error;
  }
}

function nativePrivateAclHelper() {
  const path = fileURLToPath(new URL('../../../../runtime/private-path-check.exe', import.meta.url));
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || !canonicalPrivatePath(path)) {
    throw startupFailure(denied(), { controlReason: 3 });
  }
  // Absence retains the strict PowerShell implementation. A present companion
  // must pass; a rejection or malformed executable never falls back.
  return path;
}

/** ACLs, not chmod bits: only current SID, SYSTEM and Administrators may be
 * granted access. A trusted-host check, not protection from the same OS user. */
export const PRIVATE_ACL_SCRIPT = `
try {
$p=$env:AOD_PRIVATE_PATH
$item=Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [Console]::Write('1'); exit 1 }
$acl=Get-Acl -LiteralPath $p
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { [Console]::Write('2'); exit 1 }
$raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
if ($null -eq $raw.DiscretionaryAcl) { [Console]::Write('3'); exit 1 }
foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $rule.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')) { [Console]::Write('3'); exit 1 }
}
[Console]::Write('private')
} catch { [Console]::Write('4'); exit 1 }`;
export function assertWindowsPrivatePath(path: string, target?: number) {
  try {
    if (process.platform !== 'win32' || !canonicalPrivatePath(path) || lstatSync(path).isSymbolicLink()
      || windowsPrivateControl(PRIVATE_ACL_SCRIPT, { AOD_PRIVATE_PATH: path }) !== 'private') {
      throw startupFailure(denied(), { controlReason: 5 });
    }
  } catch (error) { throw startupFailure(error, { controlTarget: target }); }
}
/** Add-Type's Framework compiler needs writable temporary storage. Create it
 * under the ACL-checked private HOME, never the host profile or Windows dir.
 * ACL probes themselves do not compile code and need no temporary directory. */
export function windowsPrivateTemporaryDirectory(home: string) {
  try {
    assertWindowsPrivatePath(home);
    if (!lstatSync(home).isDirectory()) throw denied();
    const directory = win32.join(home, 'tmp');
    try { mkdirSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    assertWindowsPrivatePath(directory);
    if (!lstatSync(directory).isDirectory()) throw denied();
    return directory;
  } catch { throw denied(); }
}
export function canonicalPrivatePath(path: string) {
  const resolved = realpathSync(path);
  return process.platform === 'win32' ? win32.normalize(resolved).toLowerCase() === win32.normalize(path).toLowerCase() : resolved === path;
}

import { execFile } from 'node:child_process';
import { powershellArguments, windowsControlEnvironment, windowsPowerShell, windowsPrivateControlScript } from './windows-private-worker.js';

/** Bounded asynchronous control: never block other sessions or expose host output. */
export function windowsAsyncControl(script: string, extra: NodeJS.ProcessEnv = {}, host: NodeJS.ProcessEnv = process.env): Promise<void> {
  return windowsAsyncControlOutput(script, extra, host).then(() => {});
}
export function windowsAsyncControlOutput(script: string, extra: NodeJS.ProcessEnv = {}, host: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const denied = () => reject(new Error('Windows private control failed'));
    try {
      execFile(windowsPowerShell(host), powershellArguments(windowsPrivateControlScript(script)), {
        env: windowsControlEnvironment(extra, host), windowsHide: true, timeout: 10_000, maxBuffer: 8192,
      }, (error, stdout) => { if (error) denied(); else resolve(stdout.trim()); });
    } catch { denied(); }
  });
}

export const SECRET_DIRECTORY_ACL_SCRIPT = `
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($env:AOD_SECRET_DIRECTORY, $acl)
`;

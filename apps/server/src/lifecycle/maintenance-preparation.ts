import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
const failed = () => new Error('Isolated candidate preparation could not be verified');
export type PreparationCommand = { executable: string; args: readonly string[]; systemdRun: string; systemctl: string };

/** A build must not outlive its deadline as orphaned npm/git/compiler processes.
 * The transient unit is separate from both Connector and supervisor. Even if
 * this supervisor disappears, systemd owns the process tree and runtime limit.
 * No shell, request-provided command, credentials or output enter the journal.
 */
export async function runSystemdPreparation(command: PreparationCommand, cwd: string, timeoutMs: number,
  runner: (binary: string, args: string[], timeout: number) => Promise<void> = async (binary, args, timeout) => {
    await new Promise<void>((resolve, reject) => {
      // Discard output instead of buffering install logs (which can contain
      // private URLs and legitimately exceed execFile's output limit).
      const child = spawn(binary, args, { cwd, stdio: 'ignore',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' } });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(failed()); }, timeout);
      child.once('error', () => { clearTimeout(timer); reject(failed()); });
      child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(failed()); });
    });
  }) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || ![cwd, command.executable, command.systemdRun, command.systemctl].every(path => isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path))) throw failed();
  const unit = `agentopsdeck-candidate-${randomUUID()}.service`;
  // Copy only named operator environment settings; never put their values in
  // process arguments. Other private provider/runtime environment is not needed.
  const environment = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK']
    .filter(name => process.env[name] !== undefined).map(name => `--setenv=${name}`);
  const args = ['--user', '--wait', '--pipe', '--collect', '--quiet', '--service-type=exec', '--expand-environment=no', `--unit=${unit}`,
    '--property=ExitType=cgroup', '--property=KillMode=control-group', '--property=Delegate=no',
    '--property=TimeoutStopSec=10s', '--property=SendSIGKILL=yes', '--property=Restart=no', '--property=UMask=0077',
    `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}s`, `--working-directory=${cwd}`,
    '--setenv=GIT_TERMINAL_PROMPT=0', ...environment, '--', command.executable, ...command.args];
  try {
    // Leave time for systemd's forced process-tree termination after its own
    // deadline. A local exec timeout alone only kills systemd-run, not the build.
    await runner(command.systemdRun, args, timeoutMs + 30_000);
  } catch {
    // Exact random test/build-owned unit only. A failed/unknown stop stays an
    // error; the adapter never advances to fence/stop/activate the Connector.
    try { await runner(command.systemctl, ['--user', 'stop', unit], 30_000); } catch { /* retain failure */ }
    throw failed();
  }
}

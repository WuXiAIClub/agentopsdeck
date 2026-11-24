import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const failed = () => new Error('Independent Connector service control could not be verified');
const properties = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'ControlGroup', 'KillMode', 'Delegate'];
const group = (value: string) => value.startsWith('/') && value !== '/' && !value.endsWith('/')
  && value.split('/').slice(1).every(part => part && part !== '.' && part !== '..' && /^[A-Za-z0-9_.@:\\-]+$/.test(part));
const within = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
type ServiceState = Record<typeof properties[number], string>;

/** Linux user-systemd process boundary for an independently running supervisor.
 * The unit/cgroup/binary are fixed node-local configuration, never request data.
 * This class intentionally has no restart(), kill(), force(), or shell escape:
 * the coordinator must inspect/fence, stop, prove exit, back up, then start.
 * Other platforms require their own process-tree evidence provider.
 */
export class SystemdConnectorService {
  private readonly run: (args: string[], timeoutMs: number) => Promise<string>;
  private readonly read: (path: string) => Promise<string>;
  constructor(private readonly options: {
    unit: string;
    controlGroup: string;
    systemctl: string;
    /** Explicit node-local opt-in for owned native worker subgroups. Stopping
     * still requires control-group killing and hierarchical empty proof. */
    allowDelegated?: boolean;
    /** Operator reconciliation only: transient supervisors may be unloaded
     * after exit. Still require exact inactive state AND empty/missing cgroup. */
    allowUnloadedStopped?: boolean;
    /** Test seam; production always executes the fixed systemctl binary. */
    run?: (args: string[], timeoutMs: number) => Promise<string>;
    read?: (path: string) => Promise<string>;
    platform?: NodeJS.Platform;
  }) {
    this.options = { ...options };
    if ((options.platform ?? process.platform) !== 'linux' || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,150}\.service$/.test(options.unit)
      || !group(options.controlGroup) || !isAbsolute(options.systemctl) || /[\x00-\x1f\x7f]/.test(options.systemctl)
      || (options.allowDelegated !== undefined && typeof options.allowDelegated !== 'boolean')
      || (options.allowUnloadedStopped !== undefined && typeof options.allowUnloadedStopped !== 'boolean')) throw failed();
    this.run = options.run ?? (async (args, timeoutMs) => (await execute(options.systemctl, args, {
      timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' },
    })).stdout);
    this.read = options.read ?? (path => readFile(path, 'utf8'));
  }

  private async state(): Promise<ServiceState> {
    const output = await this.run(['--user', 'show', '--no-pager', `--property=${properties.join(',')}`, this.options.unit], 60_000);
    const values: Record<string, string> = {};
    for (const line of output.trim().split('\n')) {
      const equal = line.indexOf('=');
      const key = line.slice(0, equal);
      if (equal < 1 || !properties.includes(key) || key in values) throw failed();
      values[key] = line.slice(equal + 1);
    }
    const unloadedStopped = this.options.allowUnloadedStopped === true && values.LoadState === 'not-found'
      && values.ActiveState === 'inactive' && values.SubState === 'dead' && values.MainPID === '0'
      && values.ControlPID === '0' && values.ControlGroup === '';
    if (Object.keys(values).length !== properties.length || !(values.LoadState === 'loaded' || unloadedStopped)
      || values.KillMode !== 'control-group'
      || !(values.Delegate === 'no' || (this.options.allowDelegated === true && values.Delegate === 'yes'))
      || !/^\d+$/.test(values.MainPID!) || !/^\d+$/.test(values.ControlPID!)
      || (values.ControlGroup && values.ControlGroup !== this.options.controlGroup)) throw failed();
    return values as ServiceState;
  }

  private async independent() {
    // Require unified cgroup v2. No process-list or MainPID-only fallback.
    await this.read('/sys/fs/cgroup/cgroup.controllers');
    const rows = (await this.read('/proc/self/cgroup')).trim().split('\n');
    const unified = rows.filter(row => row.startsWith('0::'));
    if (unified.length !== 1) throw failed();
    const own = unified[0]!.slice(3);
    if (!group(own) || within(this.options.controlGroup, own) || within(own, this.options.controlGroup)) throw failed();
  }

  private async empty() {
    let events: string;
    try { events = await this.read(`/sys/fs/cgroup${this.options.controlGroup}/cgroup.events`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const populated = events.split('\n').filter(line => line.startsWith('populated '));
    if (populated.length !== 1 || populated[0] !== 'populated 0') throw failed();
  }

  async verifyRunning() {
    try {
      await this.independent();
      const state = await this.state();
      if (state.ActiveState !== 'active' || state.SubState !== 'running' || state.ControlGroup !== this.options.controlGroup
        || Number(state.MainPID) <= 0 || state.ControlPID !== '0') throw failed();
    } catch { throw failed(); }
  }
  async verifyStopped() {
    try {
      await this.independent();
      const state = await this.state();
      if (state.ActiveState !== 'inactive' || state.SubState !== 'dead' || state.MainPID !== '0' || state.ControlPID !== '0') throw failed();
      await this.empty();
    } catch { throw failed(); }
  }
  async stop() {
    try {
      await this.verifyRunning();
      await this.run(['--user', 'stop', this.options.unit], 660_000);
      await this.verifyStopped();
    } catch { throw failed(); }
  }
  async start() {
    try {
      await this.verifyStopped();
      await this.run(['--user', 'start', this.options.unit], 660_000);
      await this.verifyRunning();
    } catch { throw failed(); }
  }
}

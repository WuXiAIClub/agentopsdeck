'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const commands = ['help', 'version', 'status', 'doctor', 'verify', 'paths', 'logs', 'start', 'stop', 'restart', 'uninstall'];
function arguments_(args) {
  const [command = 'help', ...flags] = args;
  if (!commands.includes(command) || flags.some(flag => !['--json', '--yes'].includes(flag))
    || new Set(flags).size !== flags.length || flags.includes('--yes') && command !== 'uninstall') {
    throw Error('Invalid CLI arguments; use --cli help');
  }
  if (command === 'uninstall' && !flags.includes('--yes')) throw Error('Uninstall requires --yes; user data is preserved');
  return { command };
}
async function safeJson(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw Error('Unsafe metadata file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function verify(root) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('Unsafe application root');
  const manifest = await safeJson(path.join(root, 'windows-payload-manifest.json'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 20000) {
    throw Error('Invalid bounded payload manifest');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || /[\\:\x00-\x1f<>|?*]/.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 256 * 1024 * 1024) {
      throw Error('Unsafe payload manifest entry');
    }
    if (seen.has(file.path.toLowerCase())) throw Error('Payload path alias');
    seen.add(file.path.toLowerCase());
    let current = root;
    for (const part of file.path.split('/')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw Error('Linked or special payload object');
    }
    const bytes = await fs.readFile(current);
    if (bytes.length !== file.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw Error('Payload integrity mismatch: ' + file.path);
    }
  }
  return { filesVerified: manifest.files.length + 1, sourceRevision: manifest.sourceRevision,
    integrityOnly: true, vendorSignatureVerified: false };
}
async function uninstall(root, data) {
  const life = require(path.join(root, 'lifecycle.cjs'));
  const status = await life.status(data), monitor = await life.status(path.join(data, '.desktop-startup'));
  if (![0, 10].includes(status.code) || ![0, 10].includes(monitor.code)) throw Error('Unresolved ownership; uninstall not scheduled');
  await verify(root);
  const uninstaller = path.join(root, 'unins000.exe');
  const stat = await fs.lstat(uninstaller);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Unsafe or missing Inno uninstaller');
  const logs = path.join(data, 'logs');
  await fs.mkdir(logs, { recursive: true });
  if ((await fs.lstat(logs)).isSymbolicLink()) throw Error('Linked log directory refused');
  return scheduleUninstall({ root, logs });
}
async function scheduleUninstall({ root, logs, parents = [process.pid, process.ppid] }) {
  if (!path.isAbsolute(root) || !path.isAbsolute(logs)) throw Error('Absolute uninstall supervisor paths required');
  if (!Array.isArray(parents) || parents.length !== 2
    || parents.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw Error('Exact CLI process identities required');
  const id = crypto.randomUUID();
  const receipt = path.join(logs, 'uninstall-' + id + '.json'), log = path.join(logs, 'uninstall-' + id + '.log');
  const supervisor = path.join(logs, 'uninstall-' + id + '-supervisor.exe');
  await fs.copyFile(path.join(root, 'AgentOpsDeck.exe'), supervisor, require('node:fs').constants.COPYFILE_EXCL);
  const child = cp.spawn(supervisor, ['--uninstall-supervisor', id, ...parents.map(String)],
    { windowsHide: true, stdio: 'ignore', detached: true });
  let exited;
  child.once('exit', code => { exited = code; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  for (let count = 0; count < 600; count++) {
    try {
      const state = await safeJson(receipt);
      if (state.state !== 'scheduled') throw Error('Uninstall supervisor failed before scheduling');
      return { scheduled: true, completed: false, receipt, log, supervisor, userDataPreserved: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (exited !== undefined) throw Error('Uninstall supervisor exited before acknowledgement (exit ' + exited + '); inspect logs before retrying');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw Error('Uninstall scheduling acknowledgement unavailable; inspect logs before retrying');
}
async function main(args = process.argv.slice(2), options = {}) {
  const { command } = arguments_(args);
  const root = options.root || __dirname;
  if (!process.env.LOCALAPPDATA || !path.isAbsolute(process.env.LOCALAPPDATA)) throw Error('Absolute LOCALAPPDATA required');
  const data = path.join(process.env.LOCALAPPDATA, 'AgentOpsDeck');
  const life = require(path.join(root, 'lifecycle.cjs'));
  let value, code = 0;
  if (command === 'help') value = { commands, format: 'AgentOpsDeck.exe --cli COMMAND [--json]',
    install: 'Start-Process .\\AgentOpsDeck-Setup.exe -ArgumentList /VERYSILENT,/SUPPRESSMSGBOXES,/NORESTART -Wait -PassThru',
    uninstall: 'AgentOpsDeck.exe --cli uninstall --yes --json; wait for completed:true in the returned receipt',
    exitCodes: { 0: 'command succeeded or uninstall scheduled; inspect completed', 10: 'legacy lifecycle running', 11: 'pending or ownership/readiness unresolved', 12: 'invalid input or operation failed' } };
  else if (command === 'version') {
    const release = await safeJson(path.join(root, 'release.json'));
    value = { version: release.version, sourceRevision: release.sourceRevision,
      installerRevision: release.localInstallerRevision, node: process.version };
  } else if (command === 'verify') value = await verify(root);
  else if (command === 'paths') value = { application: root, state: data, configuration: path.join(data, 'state', '.env'), logs: path.join(data, 'logs') };
  else if (command === 'logs') {
    const receipt = require(path.join(root, 'startup-receipts.cjs'));
    value = { startup: receipt.read(data), logDirectory: path.join(data, 'logs') };
  } else if (command === 'uninstall') value = await uninstall(root, data);
  else if (['start', 'stop', 'restart'].includes(command)) {
    const config = require(path.join(root, 'ui-config.cjs')).load(path.join(data, 'state', '.env'));
    const { Manager } = require(path.join(root, 'ui-manager.cjs'));
    const result = await new Manager({ root, data, ready: () => require(path.join(root, 'ui-helper.cjs')).health(config.values) }).run(command);
    code = result.code;
    value = { state: result.state, code, startup: result.receipt && require(path.join(root, 'startup-receipts.cjs')).sanitize(result.receipt) };
  } else {
    const status = await life.status(data), monitor = await life.status(path.join(data, '.desktop-startup'));
    const config = require(path.join(root, 'ui-config.cjs')).load(path.join(data, 'state', '.env')).values;
    const httpReady = status.code === 10 && await require(path.join(root, 'ui-helper.cjs')).health(config);
    const unknown = ![0, 10].includes(status.code) || ![0, 10].includes(monitor.code);
    code = unknown || status.code === 10 && !httpReady ? 11 : 0;
    value = { state: unknown ? 'ownership-unresolved' : httpReady ? 'running' : status.code === 10 ? 'starting' : 'stopped',
      service: status.state, monitor: monitor.state, httpReady, ...(status.meta ? { pid: status.meta.pid } : {}) };
    if (command === 'doctor') {
      const deps = require(path.join(root, 'ui-dependencies.cjs')).discover(root, process.env, config);
      value.runtimes = { codex: deps.codex, claudeEnabled: config.AOD_CLAUDE_ENABLED === 'true',
        codexWorkspaceConfigured: !!config.AOD_CODEX_DEFAULT_CWD };
      value.integrity = await verify(root);
      value.agentReadinessVerified = false;
    }
  }
  return { code, result: { command, ...value } };
}
module.exports = { main, arguments_, verify, scheduleUninstall };
if (require.main === module) main().then(({ code, result }) => {
  console.log(JSON.stringify(result)); process.exitCode = code;
}).catch(error => {
  console.error(JSON.stringify({ error: error.message, code: 12 })); process.exitCode = 12;
});

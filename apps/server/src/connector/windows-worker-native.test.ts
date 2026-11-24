import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, copyFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertWindowsPrivatePath, windowsPrivateControl, windowsPrivateTemporaryDirectory } from './windows-private-worker.js';
import { readPrivateWorkerCredential } from './private-worker-credential.js';
import { PrivateAgentHomeLease } from './private-agent-home-lease.js';
import { ClaudeWorkerPreflight } from '../claude/worker-preflight.js';
import { CLAUDE_SDK_VERSION, CLAUDE_CLI_VERSION } from '../claude/dispatch-adapter.js';
import { loadWorkerBoardTools } from '../tools/workspace-board-worker.js';
import { approvedTaskFile } from './sdk-turn-context.js';
import { DatabaseSync } from 'node:sqlite';

const native = { skip: process.platform !== 'win32' ? 'Requires a native Windows host; Linux is not Windows acceptance' : false, timeout: 60_000 };
const sourceMode = import.meta.url.endsWith('.ts');
const loaderArguments = sourceMode ? ['--import', import.meta.resolve('tsx')] : [];
const jobModule = new URL(sourceMode ? './windows-worker-job.ts' : './windows-worker-job.js', import.meta.url).href;
const restrict = (path: string, directory: boolean) => windowsPrivateControl(`
$p=$env:AOD_PRIVATE_PATH
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=if ($env:AOD_PRIVATE_DIRECTORY -eq 'true') { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
if ($env:AOD_PRIVATE_DIRECTORY -eq 'true') {
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
} else { $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow') }
$acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl
[Console]::Write('restricted')`, { AOD_PRIVATE_PATH: path, AOD_PRIVATE_DIRECTORY: String(directory) });

test('native Windows ACL credentials and HOME lease reject public access and retain an unresolved crash fence', native, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-win-private-'));
  try {
    restrict(root, true);
    const home = join(root, 'home'), store = join(root, 'connector.db'), key = join(root, 'key');
    await mkdir(home); await writeFile(store, 'fixture'); await writeFile(key, 'fixture-not-a-real-key');
    assertWindowsPrivatePath(home);
    assert.equal(windowsPrivateTemporaryDirectory(home), join(home, 'tmp'));
    assert.equal(await readPrivateWorkerCredential(key), 'fixture-not-a-real-key');
    const grants = join(root, 'grants'), sessionId = '11111111-1111-4111-8111-111111111111';
    await mkdir(grants);
    await writeFile(join(grants, `claude-code-${sessionId}.json`), JSON.stringify({ runtime: 'claude-code', sessionId,
      credential: { endpoint: 'http://127.0.0.1:8791/api/workspace-agent/v1/board', token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 } }));
    const tools = await loadWorkerBoardTools(grants, 'claude-code', sessionId, () => true);
    assert.ok(tools); tools.close();
    const taskFile = join(root, 'tasks.json'); await writeFile(taskFile, '{}');
    assert.equal(await approvedTaskFile([taskFile], taskFile), true);
    const nodeId = 'node_11111111-1111-4111-8111-111111111111';
    const lease = PrivateAgentHomeLease.acquire('claude-code', home, store, nodeId);
    assert.throws(() => PrivateAgentHomeLease.acquire('claude-code', home, store, nodeId));
    await lease.releaseAfter(async () => {});
    const successor = PrivateAgentHomeLease.acquire('claude-code', home, store, nodeId);
    await assert.rejects(successor.releaseAfter(async () => { throw new Error('cleanup unconfirmed'); }));
    assert.throws(() => PrivateAgentHomeLease.acquire('claude-code', home, store, nodeId));
    windowsPrivateControl(`$p=$env:AOD_PRIVATE_PATH; $acl=Get-Acl -LiteralPath $p; $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`, { AOD_PRIVATE_PATH: key });
    await assert.rejects(readPrivateWorkerCredential(key));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native Windows Job includes descendants and releases only after native exit', native, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-win-job-'));
  restrict(root, true);
  const script = `import { WindowsWorkerJob as Job } from ${JSON.stringify(jobModule)};
    import { spawn } from 'node:child_process'; import { once } from 'node:events';
    await Job.enter(${JSON.stringify(root)}); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(await Job.empty() ? 'bad-empty' : 'busy');
    const exited=once(child,'exit'); child.kill(); await exited;
    if (!await Job.empty()) throw Error('not empty'); await Job.release(); console.log('clean');`;
  const child = spawn(process.execPath, [...loaderArguments, '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.resume();
  const deadline = setTimeout(() => child.kill(), 50_000);
  try { assert.equal((await once(child, 'exit'))[0], 0); assert.match(output, /busy\s+clean/); }
  finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); }
});

test('native Windows guardian kills descendants on owner death without a reusable-PID tree scan', native, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-win-owner-'));
  restrict(root, true);
  const script = `import { WindowsWorkerJob as Job } from ${JSON.stringify(jobModule)};
    import { spawn } from 'node:child_process'; import { once } from 'node:events';
    await Job.enter(${JSON.stringify(root)}); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,'ignore']});
    await once(child,'spawn'); console.log('ready-owner'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, [...loaderArguments, '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume(); const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<void>((resolve, reject) => { lines.on('line', line => { if (line === 'ready-owner') resolve(); }); child.once('exit', () => reject(new Error('owner failed before readiness'))); });
  const deadline = setTimeout(() => child.kill(), 50_000);
  try {
    await ready;
    const closed = once(child.stdout, 'close'); child.kill(); await exited;
    // The descendant inherits stdout. EOF proves it did not outlive the
    // owner/guardian chain (without signalling any saved descendant PID).
    await closed;
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); lines.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['ready', 'configuration-failure', 'native-failure'] as const) test(mode === 'ready'
  ? 'native Windows production preflight joins its Job and drains an injected native process before ACK settlement'
  : `native Windows production preflight ${mode} proves cleanup and releases HOME without becoming ready`, native, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-win-preflight-'));
  let probe: ClaudeWorkerPreflight | undefined;
  let lease: PrivateAgentHomeLease | undefined, database: DatabaseSync | undefined, released = false;
  try {
    restrict(root, true);
    const homeDirectory = join(root, 'home'), workspace = join(root, 'workspace'), sdkDirectory = join(root, 'sdk');
    for (const path of [homeDirectory, workspace, sdkDirectory]) await mkdir(path);
    const apiKeyFile = join(root, 'key'); await writeFile(apiKeyFile, 'synthetic-fixture-key');
    // A regular fixture executable satisfies path validation only. This is
    // transport/preflight coverage, NOT acceptance of the actual Git Bash/SDK.
    const gitBashPath = join(root, 'bash.exe'); await copyFile(process.execPath, gitBashPath);
    await writeFile(join(sdkDirectory, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk',
      version: mode === 'configuration-failure' ? 'invalid-version' : CLAUDE_SDK_VERSION, claudeCodeVersion: CLAUDE_CLI_VERSION }));
    await writeFile(join(sdkDirectory, 'sdk.mjs'), `
      export async function resolveSettings(){return {effective:{},provenance:{},sources:[]}}
      export async function getSessionMessages(){return []}
      export function query({options}){
        const child=options.spawnClaudeCodeProcess({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:options.cwd,env:options.env});
        return {async initializationResult(){
          if (${JSON.stringify(mode)} === 'native-failure') throw Error('synthetic native initialization failure');
          return {models:[],commands:[]}
        },async interrupt(){},close(){child.kill()},async *[Symbol.asyncIterator](){}};
      }`);
    const store = join(root, 'connector.sqlite'), nodeId = 'node_11111111-1111-4111-8111-111111111111';
    database = new DatabaseSync(store);
    database.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    lease = PrivateAgentHomeLease.acquire('claude-code', homeDirectory, store, nodeId);
    const binding = await readFile(join(homeDirectory, '.agentopsdeck-claude-binding'));
    const entry = fileURLToPath(new URL(sourceMode ? '../claude/worker-main.ts' : '../claude/worker-main.js', import.meta.url));
    probe = new ClaudeWorkerPreflight({ homeDirectory, workspace, sdkDirectory, apiKeyFile, gitBashPath,
      baseUrl: 'https://fixture.invalid', model: 'fixture', startupTimeoutMs: 50_000 }, { entry, execArgv: loaderArguments });
    assert.equal(await probe.ready, mode === 'ready');
    assert.equal(probe.inspectQuiescence(), true);
    probe.close(); probe.close();
    assert.equal(probe.inspectQuiescence(), true);
    const original = probe;
    await lease.releaseAfter(async () => {
      await original.finished;
      assert.equal(original.inspectQuiescence(), true);
    });
    released = true;
    await assert.rejects(lstat(join(homeDirectory, '.agentopsdeck-claude-owner')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(homeDirectory, '.agentopsdeck-claude-binding')), binding);
    const successor = PrivateAgentHomeLease.acquire('claude-code', homeDirectory, store, nodeId);
    await successor.releaseAfter(async () => {});
  } finally {
    probe?.close(); await probe?.finished;
    try {
      if (lease && !released) {
        const original = probe;
        await lease.releaseAfter(async () => {
          assert.ok(original?.inspectQuiescence(), 'Retain the fixture fence when cleanup is unconfirmed');
        });
        released = true;
      }
    } finally {
      database?.close();
      if (released || !lease && !probe) await rm(root, { recursive: true, force: true });
    }
  }
});

// Isolated native-protocol POC. No turn/start, provider auth or live session data.
// The installed executable is used without changing its configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const command = process.argv[2];
if (!command || !path.isAbsolute(command)) throw new Error('Pass an absolute installed Codex executable');
const root = await mkdtemp(path.join(tmpdir(), 'agentopsdeck-skills-poc-'));
const project = path.join(root, 'project'), config = path.join(root, 'codex-home');
let child, exited;
const pending = new Map();
let id = 0;
try {
  await mkdir(path.join(project, '.agents', 'skills', 'agentopsdeck-fixture'), { recursive: true });
  await mkdir(config);
  await writeFile(path.join(project, '.agents', 'skills', 'agentopsdeck-fixture', 'SKILL.md'),
    '---\nname: agentopsdeck-fixture\ndescription: Isolated AgentOpsDeck skill discovery fixture\n---\nDo not execute anything.\n');
  child = spawn(command, ['app-server', '--stdio'], { cwd: project,
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: config }, stdio: ['pipe', 'pipe', 'pipe'] });
  exited = new Promise(resolve => child.once('exit', resolve));
  child.stderr.resume(); // Never print native diagnostics or config material.
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error('Native protocol request rejected'));
    else callback.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error('Native protocol timeout')); }, 15_000);
    pending.set(next, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`);
  });
  await request('initialize', { clientInfo: { name: 'agentopsdeck-skills-poc', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const result = await request('skills/list', { cwds: [project], forceReload: false });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].cwd, project);
  const skill = result.data[0].skills.find(item => item.name === 'agentopsdeck-fixture');
  assert.ok(skill); assert.equal(skill.enabled, true); assert.equal(skill.scope, 'repo');
  const again = await request('skills/list', { cwds: [project], forceReload: false });
  assert.ok(again.data[0].skills.some(item => item.name === 'agentopsdeck-fixture'));
  console.log(JSON.stringify({ result: 'passed', nativeRequests: id, turnsStarted: 0, fixtureDiscovered: true, enabled: true, scope: 'repo', loadedEvidence: false }));
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited; clearTimeout(timer);
  }
  await rm(root, { recursive: true, force: true });
}

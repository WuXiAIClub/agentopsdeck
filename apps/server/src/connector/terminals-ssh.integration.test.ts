import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TerminalSessions, type TerminalTarget } from './terminals.js';

// Opt-in: only synthetic keys, a private temporary directory and loopback high port.
// No system SSH configuration, production private key or remote machine is used.
test('real isolated SSH PTY: pinned host key, command/resize and wrong-key rejection', {
  skip: process.env.AOD_TEST_SSHD !== '1' ? 'Opt-in isolated SSH daemon fixture; requires AOD_TEST_SSHD=1' : false,
  timeout: 25000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentopsdeck-terminal-ssh-')), run = promisify(execFile);
  let daemon: ReturnType<typeof spawn> | undefined;
  const sessions = new TerminalSessions(), abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 20000);
  try {
    for (const name of ['host', 'client', 'wrong-host']) await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)]);
    await writeFile(join(dir, 'authorized_keys'), await readFile(join(dir, 'client.pub')), { mode: 0o600 });
    const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
    const config = ['ListenAddress 127.0.0.1', `Port ${port}`, `HostKey ${dir}/host`, `PidFile ${dir}/sshd.pid`, `AuthorizedKeysFile ${dir}/authorized_keys`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes yes', 'DisableForwarding yes', 'PermitUserEnvironment no', 'PermitUserRC no', 'PrintMotd no', 'PrintLastLog no', 'LogLevel ERROR', `AllowUsers ${userInfo().username}`, 'ForceCommand /bin/sh -i'].join('\n');
    await writeFile(join(dir, 'sshd_config'), config, { mode: 0o600 });
    const hostPublic = (await readFile(join(dir, 'host.pub'), 'utf8')).split(' ').slice(0, 2).join(' ');
    await writeFile(join(dir, 'known hosts'), `[127.0.0.1]:${port} ${hostPublic}\n`, { mode: 0o600 });
    await run('/usr/sbin/sshd', ['-t', '-f', join(dir, 'sshd_config')]);
    daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let daemonError = ''; daemon.stderr?.on('data', b => { daemonError = (daemonError + String(b)).slice(-2000); });
    // Readiness checks only this freshly generated fixture endpoint.
    const net = await import('node:net');
    for (let i = 0; ; i++) {
      const ready = await new Promise<boolean>(resolve => { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => { socket.destroy(); resolve(false); }); });
      if (ready) break;
      assert.ok(i < 50 && daemon.exitCode === null, `isolated sshd did not start: ${daemonError}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const target: TerminalTarget = { id: 'ssh', label: 'Test SSH', tokenIds: ['test'], kind: 'ssh', executable: '/usr/bin/ssh', cwd: dir, home: dir, path: '/usr/bin:/bin', host: '127.0.0.1', port, user: userInfo().username, identityFile: join(dir, 'client'), knownHosts: join(dir, 'known hosts') };
    const { id } = await sessions.start('test', target, randomUUID(), 80, 24);
    sessions.resize('test', id, 99, 31);
    sessions.write('test', id, 1, "printf 'SSH_REAL_%s\\n' VERIFIED; stty size; exit\r");
    const drain = async (id: string) => { let cursor = 0, output = ''; for (;;) { const r = await sessions.read('test', id, cursor, abort.signal, 500); cursor = r.cursor; output += r.data; if (!r.running && !r.more) return output; } };
    const output = await drain(id); assert.match(output, /SSH_REAL_VERIFIED/); assert.match(output, /31 99/);
    const wrongPublic = (await readFile(join(dir, 'wrong-host.pub'), 'utf8')).split(' ').slice(0, 2).join(' ');
    await writeFile(join(dir, 'known hosts'), `[127.0.0.1]:${port} ${wrongPublic}\n`, { mode: 0o600 });
    const denied = await sessions.start('test', target, randomUUID(), 80, 24);
    const rejection = await drain(denied.id); assert.match(rejection, /Host key verification failed/);
    assert.ok(!rejection.includes('SSH_REAL_VERIFIED'));
  } finally {
    clearTimeout(deadline); abort.abort(); sessions.close();
    if (daemon && daemon.exitCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited; }
    await rm(dir, { recursive: true, force: true });
  }
});

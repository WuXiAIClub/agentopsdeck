import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { registerConnectorTerminals } from './terminals-http.js';
import { parseTerminalTargets, permitsTerminal, terminalLaunch, TerminalSessions, type TerminalPty, type TerminalTarget } from './terminals.js';

const target: TerminalTarget = { id: 'local', label: 'Test shell', kind: 'local', tokenIds: ['alice'], cwd: '/tmp', home: '/tmp', path: '/usr/bin:/bin', executable: '/bin/sh', args: [] };
class FakePty implements TerminalPty {
  writes: string[] = []; sizes: number[][] = []; killed = 0;
  data = new Set<(data: string) => void>(); exits = new Set<(event: { exitCode: number }) => void>();
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed++; this.exit(); }
  onData(fn: (data: string) => void) { this.data.add(fn); return { dispose: () => { this.data.delete(fn); } }; }
  onExit(fn: (event: { exitCode: number }) => void) { this.exits.add(fn); return { dispose: () => { this.exits.delete(fn); } }; }
  emit(data: string) { for (const fn of this.data) fn(data); }
  exit() { for (const fn of [...this.exits]) fn({ exitCode: 0 }); }
}
test('terminal config fails closed and never inherits broad scopes or shell environment', () => {
  assert.deepEqual(parseTerminalTargets(), []);
  assert.deepEqual(parseTerminalTargets(JSON.stringify([target])), [target]);
  for (const patch of [{ cwd: 'relative' }, { executable: 'sh' }, { path: '/usr/bin:' }, { path: '.:/usr/bin' }, { path: '/usr/bin:relative' }, { unknown: true }, { tokenIds: '*' }, { args: ['\0'] }]) assert.throws(() => parseTerminalTargets(JSON.stringify([{ ...target, ...patch }])));
  assert.equal(DEFAULT_SCOPES.includes('terminals:use'), false);
  assert.equal(permitsTerminal(target, { tokenId: 'bob', label: 'local:daily', scopes: ['terminals:use'] }), false);
  assert.equal(permitsTerminal({ ...target, local: true }, { tokenId: 'local:daily', label: 'In-process Hub', scopes: ['terminals:use'] }), true);
  const launch = terminalLaunch(target); assert.deepEqual(Object.keys(launch.env).sort(), ['HOME', 'LANG', 'PATH', 'TERM', 'USERPROFILE']);
  const ssh = terminalLaunch({ ...target, kind: 'ssh', host: 'host.example', port: 22, user: 'dev', identityFile: '/private/key', knownHosts: '/private/hosts' });
  assert.ok(ssh.args.includes('StrictHostKeyChecking=yes')); assert.ok(ssh.args.includes('BatchMode=yes')); assert.ok(ssh.args.includes('ForwardAgent=no')); assert.ok(!ssh.args.includes('-A'));
  assert.ok(ssh.args.includes('UserKnownHostsFile="/private/hosts"'));
  const sshTarget = { ...target, kind: 'ssh', args: undefined, host: 'host.example', port: 22, user: 'dev', identityFile: '/private/key', knownHosts: '/private/known hosts' };
  assert.equal(parseTerminalTargets(JSON.stringify([sshTarget])).length, 1);
  for (const knownHosts of ['/private/%h', '/private/${HOME}', '/private/"hosts']) assert.throws(() => parseTerminalTargets(JSON.stringify([{ ...sshTarget, knownHosts }])));
});
test('terminal idempotency, owner boundary, ordered input and stop', async () => {
  const pty = new FakePty(); let spawns = 0;
  const s = new TerminalSessions(async () => { spawns++; return pty; });
  try {
    const req = randomUUID(), { id } = await s.start('alice', target, req, 80, 24);
    assert.deepEqual(await s.start('alice', target, req, 80, 24), { id }); assert.equal(spawns, 1);
    await assert.rejects(s.start('alice', target, req, 81, 24), { status: 409 });
    assert.throws(() => s.write('bob', id, 1, 'secret'), { status: 404 });
    s.write('alice', id, 1, 'ok'); assert.throws(() => s.write('alice', id, 1, 'ok'), { status: 409 });
    assert.deepEqual(pty.writes, ['ok']); s.resize('alice', id, 90, 30); assert.deepEqual(pty.sizes, [[90, 30]]);
    s.stop('alice', id); assert.equal(pty.killed, 1); assert.equal(pty.data.size, 0);
    await assert.rejects(s.start('alice', target, req, 80, 24), { status: 409 }); assert.equal(spawns, 1);
  } finally { s.close(); }
});
test('bounded output drains after exit, isolated cursor and no duplicate reader', async () => {
  const pty = new FakePty(), s = new TerminalSessions(async () => pty), signal = new AbortController();
  try {
    const { id } = await s.start('alice', target, randomUUID(), 80, 24);
    const pending = s.read('alice', id, 0, signal.signal);
    await assert.rejects(s.read('alice', id, 0, signal.signal), { status: 409 });
    pty.emit('x'.repeat(300000)); pty.exit();
    const first = await pending; assert.equal(first.data.length, 32768); assert.equal(first.truncated, true); assert.equal(first.running, false); assert.equal(first.more, true);
    let cursor = first.cursor, bytes = first.data.length;
    while (cursor < 300000) { const result = await s.read('alice', id, cursor, signal.signal); bytes += result.data.length; cursor = result.cursor; }
    assert.equal(bytes, 262144); await assert.rejects(s.read('alice', id, 300001, signal.signal), { status: 400 });
  } finally { s.close(); }
});
test('revocation during start, disconnect and admission budgets stop safely', async () => {
  const pty = new FakePty(); let resolve!: (value: TerminalPty) => void, allowed = true;
  const s = new TerminalSessions(() => new Promise(r => { resolve = r; }), () => allowed);
  const req = randomUUID(), pending = s.start('alice', target, req, 80, 24);
  await assert.rejects(s.start('alice', target, req, 80, 24), { status: 409 });
  allowed = false; resolve(pty); await assert.rejects(pending, { status: 403 }); assert.ok(pty.killed > 0); s.close();
  const live = new FakePty(), t = new TerminalSessions(async () => live);
  try {
    const { id } = await t.start('alice', target, randomUUID(), 80, 24); await t.start('alice', target, randomUUID(), 80, 24);
    await assert.rejects(t.start('alice', target, randomUUID(), 80, 24), { status: 429 });
    const c = new AbortController(), read = t.read('alice', id, 0, c.signal); c.abort(); await assert.rejects(read, { status: 409 }); assert.ok(live.killed > 0);
  } finally { t.close(); }
});
test('Connector HTTP requires exact token target and scope, sanitizes catalog, rejects malformed writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-terminal-http-')), tokens = new ConnectorTokenStore(join(dir, 'tokens.json'));
  const a = tokens.createTransient(['terminals:use'], 'alice'), b = tokens.createTransient(['terminals:use'], 'bob'), low = tokens.createTransient(DEFAULT_SCOPES, 'low');
  const app = new Hono(), pty = new FakePty(), service = registerConnectorTerminals(app, tokens, [target], async () => pty);
  const req = (path: string, token: string, method = 'GET', body?: unknown) => app.request(`/api/connector/v1/terminals${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await req('/targets', 'bad')).status, 401); assert.equal((await req('/targets', low.token)).status, 403);
    assert.deepEqual(await (await req('/targets', b.token)).json(), { targets: [] });
    assert.deepEqual(await (await req('/targets', a.token)).json(), { targets: [{ id: target.id, label: target.label, kind: target.kind }] });
    const input = { targetId: 'local', requestId: randomUUID(), cols: 80, rows: 24 };
    assert.equal((await req('', b.token, 'POST', input)).status, 404);
    const start = await req('', a.token, 'POST', input); assert.equal(start.status, 200); const { id } = await start.json();
    assert.equal((await req(`/${id}/input`, a.token, 'POST', { sequence: 1, data: 'hi', command: 'ignored?' })).status, 400);
    assert.equal((await req(`/${id}/input`, b.token, 'POST', { sequence: 1, data: 'hi' })).status, 404);
    assert.equal((await req(`/${id}/input`, a.token, 'POST', { sequence: 1, data: 'hi' })).status, 200);
    a.dispose(); assert.equal((await req(`/${id}/output?cursor=0`, a.token)).status, 401);
  } finally { service.close(); a.dispose(); b.dispose(); low.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('real local PTY receives input, resize and exit without saving output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-terminal-real-')), s = new TerminalSessions();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const { id } = await s.start('alice', { ...target, cwd: dir, home: dir, args: ['-i'] }, randomUUID(), 80, 24);
    s.resize('alice', id, 99, 31);
    s.write('alice', id, 1, "printf 'PTY_REAL_OK\\n'; stty size; exit\r");
    let output = '', cursor = 0;
    for (;;) {
      const result = await s.read('alice', id, cursor, controller.signal, 1000); output += result.data; cursor = result.cursor;
      if (!result.running && !result.more) break;
    }
    assert.match(output, /PTY_REAL_OK/); assert.match(output, /31 99/);
  } finally { clearTimeout(timeout); s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('configured daily shell loads login profile, interactive aliases and completion without inheriting Hub secrets', { skip: process.platform !== 'linux' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-terminal-profile-')), s = new TerminalSessions();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
  const inherited = process.env.AOD_TERMINAL_TEST_SECRET;
  process.env.AOD_TERMINAL_TEST_SECRET = 'synthetic-parent-secret';
  try {
    mkdirSync(join(dir, 'bin'));
    symlinkSync('/bin/echo', join(dir, 'bin', 'development-tool'));
    writeFileSync(join(dir, '.bash_profile'), 'export PATH="$HOME/bin:$PATH"\nexport PROFILE_LOADED=yes\n. "$HOME/.bashrc"\n');
    writeFileSync(join(dir, '.bashrc'), 'alias profile_alias="true"\ncomplete -W "one two" development-tool\n');
    const { id } = await s.start('alice', { ...target, cwd: dir, home: dir, executable: '/bin/bash', args: ['--login', '-i'] }, randomUUID(), 80, 24);
    writeFileSync(join(dir, 'check.sh'), [
      'test "$PROFILE_LOADED" = yes',
      'test -z "${AOD_TERMINAL_TEST_SECRET+x}"',
      'test -z "${AOD_ACCESS_KEY+x}"',
      'test -z "${AOD_HUB_VAULT_SECRET+x}"',
      'test -z "${CODEX_HOME+x}"',
      'shopt -q login_shell',
      'case $- in *i*) true;; *) false;; esac',
      'command -v development-tool >/dev/null',
      'alias profile_alias >/dev/null',
      'complete -p development-tool >/dev/null',
      "printf '%s%s\\n' 'DAILY_PROFILE_' 'OK'",
      '',
    ].join('\n'));
    s.write('alice', id, 1, '. "$HOME/check.sh"; exit\r');
    let output = '', cursor = 0;
    for (;;) {
      const result = await s.read('alice', id, cursor, controller.signal, 1000);
      output += result.data; cursor = result.cursor;
      if (!result.running && !result.more) break;
    }
    assert.ok(output.includes('DAILY_PROFILE_OK'), 'Login/interactive profile checks must complete successfully');
    assert.ok(!output.includes('synthetic-parent-secret'));
  } finally {
    if (inherited === undefined) delete process.env.AOD_TERMINAL_TEST_SECRET;
    else process.env.AOD_TERMINAL_TEST_SECRET = inherited;
    clearTimeout(timeout); s.close(); rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createOpenClawSessionSource } from './openclaw-session-source.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-session-source-'));
  const previous = { HOME: process.env.HOME, AOD_OPENCLAW_HOME: process.env.AOD_OPENCLAW_HOME };
  process.env.HOME = root; process.env.AOD_OPENCLAW_HOME = join(root, '.openclaw');
  const home = join(root, 'private-openclaw');
  await mkdir(home, { mode: 0o700 });
  const sessions = join(home, 'agents/main/sessions'), titles = join(root, 'preferences/titles.json');
  const save = async (file: string, value: unknown) => { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify(value)); };
  context.after(async () => {
    context.mock.restoreAll(); syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, sessions, titles, save, config: { sessionTitlesFile: titles,
    nativeFileRoots: { home, configFile: join(home, 'openclaw.json'), configRequired: false } },
    fallback: () => {
      const original = fsPromises.readdir;
      context.mock.method(fsPromises, 'readdir', (...args: Parameters<typeof fsPromises.readdir>) => {
        if (args[0] === join(home, 'agents')) throw Object.assign(Error('synthetic missing registry'), { code: 'ENOENT' });
        return original(...args);
      });
      syncBuiltinESMExports();
    } };
}

test('original registry priority, title/file overrides and recovered Feishu identity survive extraction', async context => {
  const f = await fixture(context), file = join(f.sessions, 'ou_original.jsonl');
  await f.save(join(f.sessions, 'sessions.json'), {
    'agent:main:main': { sessionId: 'ou_original', sessionFile: file, status: 'idle', model: 'original-model',
      updatedAt: 123, origin: { to: 'original-route' }, deliveryContext: { accountId: 'original-account' } },
  });
  await writeFile(join(f.home, 'agents/not-a-directory'), 'ignored');
  const web = 'agent:main:dashboard:agentopsdeck-web-original';
  await f.save(f.titles, { [web]: '  Original title  ', 'agent:main:feishu:group:original': 'Group title' });
  await f.save(join(dirname(f.titles), 'session-files.json'), { [web]: join(f.sessions, 'original.jsonl') });
  const source = createOpenClawSessionSource(f.config, { execute: async () => assert.fail('registry must not invoke CLI') });
  try {
    const rows = await source.readSessions(), direct = rows.find(row => row.sessionKey === 'agent:main:feishu:direct:ou_original');
    assert.equal(direct?.sessionId, 'ou_original'); assert.equal(direct?.sessionFile, file);
    assert.equal(direct?.origin.to, 'original-route'); assert.equal(direct?.deliveryContext.accountId, 'original-account');
    const recovered = rows.find(row => row.sessionKey === web);
    assert.equal(recovered?.label, 'Original title'); assert.equal(recovered?.sessionId, 'original');
    assert.equal(recovered?.model, 'original-model');
    assert.equal(rows.find(row => row.sessionKey === 'agent:main:feishu:group:original')?.origin.chatType, 'group');
  } finally { await source.close(); }
});

test('registry and transcript reads share captured private roots rather than mutable ambient homes', async context => {
  const f = await fixture(context), key = 'agent:main:main';
  await f.save(join(f.sessions, 'sessions.json'), { [key]: { sessionId: 'private', status: 'idle' } });
  await writeFile(join(f.sessions, 'private.jsonl'), JSON.stringify({ type: 'message', id: 'private', message: { role: 'user', content: 'private fixture' } }));
  const ambient = join(f.root, '.openclaw/agents/main/sessions');
  await f.save(join(ambient, 'sessions.json'), { [key]: { sessionId: 'ambient', status: 'idle' } });
  await writeFile(join(ambient, 'ambient.jsonl'), JSON.stringify({ type: 'message', id: 'ambient', message: { role: 'user', content: 'ambient fixture' } }));
  const source = createOpenClawSessionSource(f.config, { execute: async () => assert.fail('private registry must win') });
  process.env.AOD_OPENCLAW_HOME = join(f.root, '.openclaw');
  try {
    assert.equal((await source.readSessions())[0]?.sessionId, 'private');
    assert.equal((await source.readTranscript(key))[0]?.id, 'private');
  } finally { await source.close(); }
});

test('CLI reads use existing private environment and explicit state/config without ambient credentials', async context => {
  const f = await fixture(context); f.fallback();
  const configFile = join(f.home, 'explicit-config.json');
  f.config.nativeFileRoots.configFile = configFile;
  const config = JSON.stringify({ fixture: 'explicit native configuration' });
  await writeFile(configFile, config);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-not-forwarded';
  const source = createOpenClawSessionSource(f.config, { execute: async (_args, options) => {
    assert.equal(options.env.HOME, f.home);
    assert.equal(options.env.USERPROFILE, f.home);
    assert.equal(options.env.OPENCLAW_STATE_DIR, f.home);
    assert.equal(options.env.OPENCLAW_CONFIG_PATH, configFile);
    assert.equal(options.env.TMPDIR, join(f.home, 'tmp'));
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.AOD_OPENCLAW_HOME, undefined);
    assert.equal(options.timeout, 30_000);
    return { stdout: '[]' };
  } });
  try {
    assert.deepEqual(await source.readSessions(), []);
    assert.equal(await readFile(configFile, 'utf8'), config);
  } finally {
    await source.close();
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
});

test('aliased configured home is refused before transcript reads or CLI execution', async context => {
  const f = await fixture(context), alias = join(f.root, 'home-alias');
  await symlink(f.home, alias);
  const source = createOpenClawSessionSource({ ...f.config, nativeFileRoots: { ...f.config.nativeFileRoots, home: alias } }, {
    execute: async () => assert.fail('invalid private home must not launch CLI'),
  });
  try {
    await assert.rejects(source.readSessions(), /private configuration could not be verified/);
    await assert.rejects(source.readTranscript('agent:main:main'), /private configuration could not be verified/);
  } finally { await source.close(); }
});

test('original CLI unknown-option fallback retains transcript title and newer successful terminal recovery', async context => {
  const f = await fixture(context), key = 'agent:main:main', sessionFile = join(f.sessions, 'original.jsonl');
  f.fallback();
  await f.save(join(f.sessions, 'sessions.json'), { [key]: { sessionId: 'original', sessionFile } });
  const at = Date.now();
  await writeFile(sessionFile, [
    { type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'Original\nquestion' }] } },
    { type: 'message', timestamp: at + 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Original successful reply' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const calls: string[][] = [];
  const source = createOpenClawSessionSource(f.config, { execute: async (args, options) => {
    calls.push(args); assert.equal(options.timeout, 30_000); assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    if (calls.length === 1) throw Object.assign(Error('old CLI'), { stderr: 'unknown option --limit' });
    return { stdout: JSON.stringify({ sessions: [{ key, status: 'failed', updatedAt: 1 }] }) };
  } });
  try {
    const [row] = await source.readSessions();
    assert.deepEqual(calls, [['sessions', '--all-agents', '--limit', '500', '--json'], ['sessions', '--all-agents', '--json']]);
    assert.equal(row?.derivedTitle, 'Original question'); assert.equal(row?.status, 'idle');
    assert.ok(row.updatedAt >= at + 1);
  } finally { await source.close(); }
});

test('original status fallback is read-only and preserves recent directory rows', async context => {
  const f = await fixture(context); f.fallback();
  const calls: string[][] = [];
  const source = createOpenClawSessionSource(f.config, { execute: async (args, options) => {
    calls.push(args);
    if (args[0] === 'sessions') throw Error('isolated unavailable CLI');
    assert.equal(options.maxBuffer, 8 * 1024 * 1024);
    return { stdout: JSON.stringify({ sessions: { recent: [{ key: 'agent:main:main', label: 'Original' }] } }) };
  } });
  try {
    assert.equal((await source.readSessions())[0]?.label, 'Original');
    assert.deepEqual(calls, [['sessions', '--all-agents', '--limit', '500', '--json'], ['status', '--json']]);
  } finally { await source.close(); }
});

test('original history keeps last 400 message mappings and original full-stream timestamp offsets', async context => {
  const f = await fixture(context), key = 'agent:main:main', file = join(f.sessions, 'original.jsonl');
  await f.save(join(f.sessions, 'sessions.json'), { [key]: { sessionId: 'original', sessionFile: file } });
  const time = Date.now();
  const rows = Array.from({ length: 405 }, (_, i) => ({ type: 'message', id: `original-${i}`, timestamp: time,
    message: { role: 'assistant', timestamp: time, content: [{ type: 'text', text: 'original' }], usage: { totalTokens: i },
      stopReason: 'stop', status: 'sent', toolCallId: `call-${i}`, toolName: 'original-tool' } }));
  await writeFile(file, [JSON.stringify({ type: 'metadata' }), ...rows.map(row => JSON.stringify(row))].join('\n'));
  const source = createOpenClawSessionSource(f.config);
  try {
    const history = await source.readTranscript(key);
    assert.equal(history.length, 400); assert.equal(history[0]?.id, 'original-5');
    assert.equal(history[0]?.createdAt, time + 5); assert.equal(history[399]?.updatedAt, time + 404);
    assert.deepEqual(history[399]?.usage, { totalTokens: 404 }); assert.equal(history[399]?.toolCallId, 'call-404');
    assert.equal(history[399]?.name, 'original-tool'); assert.equal(history[399]?.stopReason, 'stop');
  } finally { await source.close(); }
});

test('recovered Feishu history and original file override use the same transcript source', async context => {
  const f = await fixture(context), file = join(f.sessions, 'original.jsonl');
  await f.save(join(f.sessions, 'sessions.json'), { 'agent:main:main': { sessionId: 'ou_original', sessionFile: file } });
  const custom = 'agent:main:dashboard:agentopsdeck-web-original';
  await f.save(join(dirname(f.titles), 'session-files.json'), { [custom]: file });
  await writeFile(file, JSON.stringify({ type: 'message', id: 'original', message: { role: 'assistant', content: 'original' } }));
  const source = createOpenClawSessionSource(f.config);
  try {
    assert.equal((await source.readTranscript('agent:main:feishu:direct:ou_original'))[0]?.id, 'original');
    assert.equal((await source.readTranscript(custom))[0]?.id, 'original');
    assert.deepEqual(await source.readTranscript('agent:main:feishu:direct:ou_other'), []);
  } finally { await source.close(); }
});

for (const reject of [false, true]) test(`source close retains original CLI ${reject ? 'rejection' : 'completion'} and forbids new work`, async context => {
  const f = await fixture(context); f.fallback();
  const entered = deferred<void>(), pending = deferred<{ stdout: string }>();
  let calls = 0;
  const source = createOpenClawSessionSource(f.config, { execute: async () => {
    if (++calls === 1) { entered.resolve(); return pending.promise; }
    throw Error('status fallback unavailable');
  } });
  const read = source.readSessions(); const result = read.then(() => 'resolved', () => 'rejected');
  await entered.promise;
  const close = source.close(); let closed = false; void close.then(() => { closed = true; });
  assert.equal(source.close(), close);
  try {
    await assert.rejects(source.readSessions(), /closing/); await assert.rejects(source.readTranscript('agent:main:main'), /closing/);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    if (reject) pending.reject(Error('isolated CLI failure')); else pending.resolve({ stdout: '[]' });
    assert.equal(await result, reject ? 'rejected' : 'resolved'); await close; assert.equal(closed, true);
  } finally { pending.resolve({ stdout: '[]' }); await result; await close; }
});

for (const reject of [false, true]) test(`source close drains accepted physical history read on ${reject ? 'failure' : 'success'}`, async context => {
  const f = await fixture(context), key = 'agent:main:main', index = join(f.sessions, 'sessions.json');
  await f.save(index, { [key]: { sessionId: 'original' } });
  await writeFile(join(f.sessions, 'original.jsonl'), JSON.stringify({ type: 'message', id: 'original', message: { role: 'user' } }));
  const gate = deferred<void>(), entered = deferred<void>(), original = fsPromises.readFile;
  context.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof readFile>) => {
    if (args[0] === index) { entered.resolve(); await gate.promise; }
    return original(...args);
  }); syncBuiltinESMExports();
  const source = createOpenClawSessionSource(f.config), read = source.readTranscript(key), outcome = read.then(() => true, () => false);
  await entered.promise;
  let closed = false; const close = source.close(); void close.then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    if (reject) gate.reject(Error('isolated disk failure')); else gate.resolve();
    assert.equal(await outcome, !reject); await close; assert.equal(closed, true);
  } finally { gate.resolve(); await outcome; await close; }
});

test('crafted traversal agent keys and nested symlink escapes are refused or confined within private home', async context => {
  const f = await fixture(context);
  const outsideDir = join(f.root, 'outside-agent/sessions');
  await mkdir(outsideDir, { recursive: true, mode: 0o700 });
  const outsideTranscript = join(outsideDir, 'decoy.jsonl');
  await writeFile(outsideTranscript, JSON.stringify({ type: 'message', id: 'escaped', message: { role: 'user', content: 'escaped' } }));
  await writeFile(join(outsideDir, 'sessions.json'), JSON.stringify({
    'agent:../outside-agent:main': { sessionId: 'decoy', sessionFile: outsideTranscript },
  }));
  await f.save(join(f.sessions, 'sessions.json'), {
    'agent:main:main': { sessionId: 'main-safe' },
  });
  const source = createOpenClawSessionSource(f.config, { execute: async () => assert.fail('registry present') });
  try {
    assert.deepEqual(await source.readTranscript('agent:../outside-agent:main'), []);
    assert.deepEqual(await source.readTranscript('../outside-agent'), []);
    const symlinkTranscript = join(f.sessions, 'main-safe.jsonl');
    await symlink(outsideTranscript, symlinkTranscript);
    await assert.rejects(source.readTranscript('agent:main:main'), /openclaw_transcript_untrusted/);
  } finally {
    await source.close();
  }
});

test('symlinked sessions index and oversized override/index/transcript files fail closed without silent fallback', async context => {
  const f = await fixture(context), key = 'agent:main:main';
  const outsideIndex = join(f.root, 'outside-sessions.json');
  await writeFile(outsideIndex, JSON.stringify({ [key]: { sessionId: 'outside' } }));
  await mkdir(f.sessions, { recursive: true, mode: 0o700 });
  await symlink(outsideIndex, join(f.sessions, 'sessions.json'));
  const source = createOpenClawSessionSource(f.config, {
    execute: async () => assert.fail('untrusted registry index must not silently fall back to CLI'),
  });
  try {
    await assert.rejects(source.readSessions(), /openclaw_session_index_untrusted/);
    await assert.rejects(source.readTranscript(key), /openclaw_session_index_untrusted/);
    await rm(join(f.sessions, 'sessions.json'));
    await f.save(join(f.sessions, 'sessions.json'), { [key]: { sessionId: 'bounded' } });
    const oversizedOverride = join(dirname(f.titles), 'session-files.json');
    await mkdir(dirname(oversizedOverride), { recursive: true, mode: 0o700 });
    await writeFile(oversizedOverride, `{"pad":"${'x'.repeat(1024 * 1024 + 32)}"}`);
    await assert.rejects(source.readSessions(), /session_override_file_oversize/);
    await rm(oversizedOverride);
    const oversizedLineFile = join(f.sessions, 'bounded.jsonl');
    await writeFile(oversizedLineFile, `{"type":"message","id":"big","message":{"role":"assistant","content":"${'y'.repeat(2 * 1024 * 1024 + 64)}"}}\n`);
    await assert.rejects(source.readTranscript(key), /openclaw_transcript_line_oversize/);
  } finally {
    await source.close();
  }
});

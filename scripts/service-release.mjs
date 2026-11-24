import { execFileSync } from 'node:child_process';

export function serviceState(unit, execute = execFileSync) {
  if (!/^[a-zA-Z0-9_.@-]+\.service$/.test(unit)) throw new Error('Invalid service unit');
  const output = execute('/usr/bin/systemctl', ['--user', 'show', unit, '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,ControlGroup'],
    { encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` } });
  const state = Object.fromEntries(output.trim().split('\n').map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
  if (state.LoadState !== 'loaded' || !['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading'].includes(state.ActiveState)
    || !/^\d+$/.test(state.MainPID ?? '') || !/^\d+$/.test(state.ControlPID ?? '')) throw new Error('Invalid service state');
  return state;
}

export function pinRelease(source, previous, next) {
  const safeName = name => /^[a-zA-Z0-9][a-zA-Z0-9_-]+$/.test(name);
  if (![previous, next].every(pin => safeName(pin.release) && /^[a-f0-9]{64}$/.test(pin.manifest))) throw new Error('Invalid release identity');
  const releaseLine = `const release = \`\${root}/releases/${previous.release}\`;`;
  const hash = `'${previous.manifest}'`;
  if (source.split(releaseLine).length !== 2 || source.split(hash).length !== 2) throw new Error('Launcher pin changed');
  return source.replace(releaseLine, `const release = \`\${root}/releases/${next.release}\`;`).replace(hash, `'${next.manifest}'`);
}

export async function activateRelease({ install, start, verify, stop, restore, recordFailure }) {
  try { await install(); await start(); await verify(); }
  catch (error) {
    try { await recordFailure(error); } catch { }
    try { await stop(); await restore(); await start(); await verify(); }
    catch (recovery) { throw new AggregateError([error, recovery], 'Deployment and recovery failed'); }
    throw error;
  }
}

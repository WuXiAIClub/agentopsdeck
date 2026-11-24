// Read-only observer of an EXISTING command. Cannot submit, restart or recover.
// Run as an independent user service; private local config contains paths, not keys.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export async function verifyWeb(origin, release, request = fetch) {
  const url = new URL(origin);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash);
  const manifest = JSON.parse(await readFile(join(release, 'candidate-manifest.json'), 'utf8'));
  const assets = manifest.files.filter(file => /^apps\/web\/dist\/assets\/[^/]+\.(js|css)$/.test(file.path));
  assert.ok(assets.some(file => file.path.endsWith('.js')) && assets.some(file => file.path.endsWith('.css')));
  const get = async path => {
    const response = await request(new URL(path, origin), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, 'Web request failed');
    return Buffer.from(await response.arrayBuffer());
  };
  const html = (await get('/')).toString('utf8');
  const index = await readFile(join(release, 'apps/web/dist/index.html'), 'utf8');
  const references = text => [...text.matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)].map(m => m[1]).sort();
  // Public HTML may have proxy-injected RUM; validate actual script/style pins.
  assert.deepEqual(references(html), references(index), 'Served HTML does not reference the selected release');
  for (const asset of assets) {
    const bytes = await get(`/${asset.path.slice('apps/web/dist/'.length)}`);
    assert.equal(bytes.length, asset.bytes, 'Asset size mismatch');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, 'Asset digest mismatch');
  }
  return { origin: url.origin, assets: assets.length, verified: true };
}

export async function observe(configFile) {
  // Operator-controlled config. Validate before reading the separate credential.
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  for (const field of ['toolkit', 'maintenanceConfig', 'candidate', 'result']) assert.ok(isAbsolute(config[field]));
  assert.match(config.commandKey, /^[A-Za-z0-9._:-]{1,200}$/);
  assert.ok(Number.isSafeInteger(config.previousPid) && config.previousPid > 0);
  assert.ok(Array.isArray(config.origins) && config.origins.length > 0);
  const { readPrivateMaintenanceFile } = await import(pathToFileURL(join(config.toolkit, 'apps/server/dist/lifecycle/maintenance-entry.js')));
  const { verifyNodeRelease } = await import(pathToFileURL(join(config.toolkit, 'apps/server/dist/lifecycle/maintenance-node-adapter.js')));
  await readPrivateMaintenanceFile(configFile);
  const maintenance = JSON.parse(await readPrivateMaintenanceFile(config.maintenanceConfig));
  assert.equal(maintenance.listener.hostname, '127.0.0.1');
  const candidate = await verifyNodeRelease(JSON.parse(await readPrivateMaintenanceFile(config.candidate)), maintenance.releasesDirectory, true);
  const credential = (await readPrivateMaintenanceFile(maintenance.credentialFile)).trim();
  const evidence = { commandKey: config.commandKey, startedAt: new Date().toISOString(), state: 'observing', stages: [], candidate };
  async function save() {
    const temporary = `${config.result}.${process.pid}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(evidence, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, config.result);
    const parent = await open(dirname(config.result), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  await save();
  const deadline = Date.now() + 40 * 60 * 1000;
  try {
    let completed = false;
    while (Date.now() < deadline) {
      let response;
      try {
        response = await fetch(`http://127.0.0.1:${maintenance.listener.port}/api/maintenance/v1/commands/${encodeURIComponent(config.commandKey)}`, {
          redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${credential}`,
            'x-agentopsdeck-maintenance-protocol': '1', 'x-agentopsdeck-expected-node-id': maintenance.nodeId },
        });
      } catch { await delay(5000); continue; }
      if (response.status === 404 || response.status >= 500) { await delay(5000); continue; }
      assert.equal(response.status, 200, 'Maintenance receipt inaccessible');
      const { command } = await response.json();
      assert.equal(command.nodeId, maintenance.nodeId);
      assert.equal(command.operation, 'upgrade');
      evidence.receipt = command;
      if (!evidence.stages.includes(command.stage)) evidence.stages.push(command.stage);
      await save();
      if (command.stage === 'attention') throw new Error('Maintenance requires operator attention');
      if (command.stage === 'cancelled') throw new Error('Maintenance was cancelled by the local operator; no deployment completed');
      if (command.stage === 'succeeded') {
        assert.equal(command.release?.manifestSha256, candidate.manifestSha256);
        assert.equal(command.release?.revision, candidate.revision);
        completed = true; break;
      }
      await delay(3000);
    }
    assert.ok(completed, 'Observation deadline; inspect original receipt, never resubmit');
    assert.deepEqual(JSON.parse(await readPrivateMaintenanceFile(maintenance.activeReleaseFile)), candidate);
    const { stdout } = await promisify(execFile)(maintenance.service.systemctl,
      ['--user', 'show', maintenance.service.unit, '-p', 'MainPID', '-p', 'ActiveState'], { timeout: 10000 });
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')));
    assert.equal(fields.ActiveState, 'active');
    assert.ok(Number(fields.MainPID) > 0 && Number(fields.MainPID) !== config.previousPid);
    evidence.pid = Number(fields.MainPID);
    evidence.web = [];
    for (const origin of config.origins) evidence.web.push(await verifyWeb(origin, candidate.directory));
    evidence.state = 'verified';
  } catch {
    // Never record response bodies/errors that could contain credentials/data.
    evidence.state = 'needs-review'; process.exitCode = 1;
  }
  evidence.finishedAt = new Date().toISOString(); await save();
  console.log(`Maintenance observer: ${evidence.state}; inspect private result file`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { assert.equal(process.argv.length, 3); await observe(process.argv[2]); }
  catch { console.error('Maintenance observer setup failed'); process.exitCode = 1; }
}

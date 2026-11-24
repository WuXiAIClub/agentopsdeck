// Production browser assets + synthetic sessions only. Never contact a live Hub.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT } from '../packages/shared/dist/session-notebook.js';
import { createIsolatedGeckodriverHarness, formatBoundedBrowserDiagnostic } from './lib/isolated-geckodriver-harness.mjs';

// Isolate browser lifetimes as well as storage. Reusing a geckodriver after a
// six-pane streaming page can fail while deleting its Marionette session.
const scenario = process.argv[2];
if (!scenario) {
  for (const mode of ['desktop', 'mobile', 'panels', 'notebooks', 'boundaries']) {
    const child = spawn(process.execPath, [process.argv[1], mode], { cwd: process.cwd(), stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`${mode} browser fixture failed (${code})`)));
    });
  }
  console.log(JSON.stringify({ desktop: true, mobile: true, panels: true, notebooks: true, boundaries: true, independentBrowserProcesses: true }));
  process.exit(0);
}
assert.ok(['desktop', 'mobile', 'panels', 'notebooks', 'boundaries'].includes(scenario), 'Use desktop, mobile, panels, notebooks or boundaries');
const evidence = await mkdtemp(resolve(tmpdir(), `agentopsdeck-224-ui-${scenario}-`));
await chmod(evidence, 0o700);

const dist = resolve('apps/web/dist'), scope = 'a'.repeat(64), now = Date.now();
const sessions = Array.from({ length: 6 }, (_, i) => ({ sessionKey: `fixture:${Buffer.from(`codex:sync-${i}`).toString('base64url')}`,
  source: 'codex', agentId: 'codex', title: `Sync fixture ${i}`, status: 'running', hasActiveRun: true, runStartedAt: now,
  runtime: { turnId: `turn-${i}`, phase: 'running', connection: 'connected', sync: 'current', lastEventAt: now } }));
if (scenario === 'boundaries') for (const session of sessions) session.envConnectionId = 'fixture';
let sourceState = 'ready';
const hasNotebooks = ['notebooks', 'boundaries'].includes(scenario);
if (scenario === 'mobile') {
  for (const index of [0, 1]) Object.assign(sessions[index], { hasActiveRun: false, status: 'idle', runCompletedAt: now + 100,
    runtime: { ...sessions[index].runtime, phase: 'completed', threadActivity: 'idle' } });
}
const panes = sessions.map((session, i) => ({ id: `pane${i}`, sessionKey: session.sessionKey }));
const leaf = i => ({ kind: 'pane', id: panes[i].id });
const row = i => ({ kind: 'split', axis: 'horizontal', ratio: 1 / 3, first: leaf(i), second: { kind: 'split', axis: 'horizontal', ratio: .5, first: leaf(i + 1), second: leaf(i + 2) } });
const saved = [{ id: 'six', name: 'Six sync fixtures', collapsedKeys: [], workspace: { version: 1, panes, floating: [], active: panes[0].id,
  dock: { kind: 'split', axis: 'vertical', ratio: .5, first: row(0), second: row(3) } } }];
let revision = 1, slow = false, failed = false, unsupported = false, messageWrites = 0;
const streams = new Set(), requests = [], timers = new Set();
const noteLayout = { resourceId: JSON.stringify(['hub-notebook-layout', 1, 'default']), revision: 1, updatedAt: now,
  text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Workspace tips', x: 90, y: 110 }) };
const sessionNotePath = `/api/hub/v1/sessions/${encodeURIComponent(sessions[0].sessionKey)}/notebook`;
const noteDocuments = new Map([
  ['/api/hub/v1/notebooks/default/layout', noteLayout],
  ['/api/hub/v1/notebooks/default', { resourceId: JSON.stringify(['hub-notebook', 1]), revision: 1, updatedAt: now, text: '# Global tips\n\n- [ ] Verify docking' }],
  [sessionNotePath, { resourceId: JSON.stringify(['fixture-node', 'codex', 'sync-0', 'session']), revision: 1, updatedAt: now, text: 'Session tip' }],
]);
const noteRequests = []; let noteOffline = false, noteDelay = 0;
const page = key => ({ messages: [{ id: `message-${key}`, sessionKey: key, role: 'assistant', text: `Sync text ${revision}`, status: 'sent', createdAt: now,
  turnId: sessions.find(session => session.sessionKey === key)?.runtime.turnId, phase: 'final_answer' }], updatedAt: now + revision });
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'POST' && path.endsWith('/messages')) messageWrites++;
  if (hasNotebooks && noteDocuments.has(path)) {
    const record = { method: req.method, path }; noteRequests.push(record);
    res.setHeader('Content-Type', 'application/json');
    if (path === sessionNotePath && sourceState === 'denied') { res.writeHead(403); res.end(JSON.stringify({ error: 'Synthetic permission revoked' })); return; }
    if (noteOffline) { res.writeHead(503); res.end(JSON.stringify({ error: 'Synthetic offline notebook' })); return; }
    if (req.method === 'PUT') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const value = JSON.parse(raw);
      record.value = value;
      if (noteDelay) await new Promise(resolve => setTimeout(resolve, noteDelay));
      const previous = noteDocuments.get(path);
      if (value.resourceId !== previous.resourceId || value.revision !== previous.revision) { res.writeHead(409); res.end(JSON.stringify({ error: 'Synthetic revision conflict' })); return; }
      noteDocuments.set(path, { ...value, revision: value.revision + 1, updatedAt: Date.now() });
    }
    res.end(JSON.stringify(noteDocuments.get(path))); return;
  }
  if (path === '/api/hub/v1/workspace/sync') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { items } = JSON.parse(raw); requests.push({ type: 'batch', size: items.length, keys: items.map(item => item.sessionKey), at: Date.now() });
    if (unsupported) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' }); res.flushHeaders();
    let remaining = items.length;
    for (const item of items) {
      const write = () => {
        if (res.destroyed) return;
        const error = failed && item.sessionKey === sessions[0].sessionKey;
        res.write(JSON.stringify({ sessionKey: item.sessionKey, status: error ? 503 : 200, body: error ? { error: 'Synthetic isolated failure' } : page(item.sessionKey) }) + '\n');
        if (--remaining === 0) res.end();
      };
      if (slow && item.sessionKey === sessions[0].sessionKey) { const timer = setTimeout(() => { timers.delete(timer); write(); }, 3000); timers.add(timer); }
      else write();
    }
    return;
  }
  if (path.endsWith('/events/stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write('event: heartbeat\ndata: \n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (path.startsWith('/api/')) {
    if (path.endsWith('/messages')) requests.push({ type: 'direct', key: decodeURIComponent(path.split('/').at(-2)), at: Date.now() });
    const key = decodeURIComponent(path.split('/').at(-2) ?? '');
    const body = path === '/api/auth/status' ? { authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } }
      : path === '/api/auth/passkeys' ? { passkeys: [] }
      : path === '/api/hub/v1/workspace/preferences' ? { revision: 1, groups: [], sessions: {} }
      : path === '/api/hub/v1/notebooks' ? { items: hasNotebooks ? [noteDocuments.get('/api/hub/v1/notebooks/default/layout')] : [], nextCursor: null }
      : path.endsWith('/sessions/state') ? { groups: [{ agentId: 'codex', sessions: sourceState === 'denied' ? [] : sessions }], updatedAt: now + revision, revision: String(revision),
        ...(scenario === 'boundaries' ? { viewKey: 'boundaries', sourceStates: [{ connectionId: 'fixture', authority: 1, state: sourceState, hiddenCount: 0, archivedCount: 0, pinnedCount: 0 }] } : {}) }
      : path.endsWith('/messages') ? page(key)
      : path === '/api/agents' ? { agents: [] }
      : path === '/api/gateway/status' ? { ok: true, status: 'online', updatedAt: now } : {};
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  try {
    const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`); if (!file.startsWith(`${dist}/`)) throw Error('invalid path');
    let content = await readFile(file);
    if (extname(file) === '.html') content = content.toString().replace('<head>', `<head><script>
      localStorage.setItem('agentopsdeck.locale','en');
      localStorage.setItem('agentopsdeck.saved-layouts.v1:${scope}',${JSON.stringify(JSON.stringify(saved))});
      window.__errors=[];addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
      </script>`);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream' }); res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const harness = await createIsolatedGeckodriverHarness({
  fixturePort: server.address().port,
  prefix: `agentopsdeck-ws-preview-${scenario}-`,
});
const request = (path, method = 'GET', body) => harness.request(path, method, body);
let id;
const script = source => request(`/session/${id}/execute/sync`, 'POST', { script: source, args: [] });
const until = source => harness.untilScript(script, source, { attempts: 100, intervalMs: 100 });
const click = label => script(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click(); return true;`);
const pointer = actions => request(`/session/${id}/actions`, 'POST', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });
async function hoverPane(index) {
  // Since 2.2.6 session-to-session reveal uses the bottom 15%, not message text.
  const point = await script(`const r=document.querySelector('[data-session-pane="${sessions[index].sessionKey}"]').closest('[data-workspace-pane]').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height*.9)};`);
  await pointer([{ type: 'pointerMove', duration: 80, ...point }]);
  await delay(220);
}
const focusedPane = () => script(`return document.activeElement?.matches('.desktop-composer-textarea') ? document.activeElement.closest('[data-session-pane]').dataset.sessionPane : null;`);
function emit() {
  revision++;
  for (const session of sessions) for (const stream of streams) {
    const event = { id: `${revision}:${session.sessionKey}`, type: 'stream.reset', ts: Date.now(), sessionKey: session.sessionKey, payload: { reason: 'fixture' } };
    stream.write(`id: ${event.id}\nevent: stream.reset\ndata: ${JSON.stringify(event)}\n\n`);
  }
}
try {
  id = await harness.createSession(scenario === 'mobile' ? { 'ui.prefersReducedMotion': 1 } : {});
  if (scenario === 'boundaries') {
    await request(`/session/${id}/window/rect`, 'POST', { width: 2200, height: 1600 });
    await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/#/session/${encodeURIComponent(sessions[0].sessionKey)}` });
    await until(`return document.querySelector('.message-selection-surface')?.textContent.includes('Sync text 1')`);
    await script(`document.querySelector('[aria-label="Saved layouts"]').click(); document.querySelector('.saved-layout-row > button').click(); return true;`);
    await until(`return document.querySelectorAll('.message-selection-surface').length===6`);
    const openPanel = text => script(`document.querySelector('[aria-label="Layout presets"]').click(); [...document.querySelectorAll('.session-workspace-preset-menu button')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click(); return true;`);
    await click('Browser and sign-in settings');
    await script(`document.querySelector('input[role="switch"][aria-label="Workspace sync · Preview"]').click(); return true;`);
    await click('Close settings');
    const sample = async () => {
      await delay(1800); const offset = requests.length; emit();
      await until(`return document.querySelectorAll('.message-selection-surface').length===6 && [...document.querySelectorAll('.message-selection-surface')].every(el=>el.textContent.includes('Sync text ${revision}'))`);
      const reads = requests.slice(offset);
      const keys = reads.flatMap(row => row.type === 'batch' ? row.keys : [row.key]);
      assert.equal(new Set(keys).size, 6); assert.ok(keys.every(key=>sessions.some(session=>session.sessionKey===key)));
      return { requests: reads.length, reads: keys.length };
    };
    const baseline = await sample();
    await script(`window.__hosts=[...document.querySelectorAll('[data-session-pane]')]; return true;`);
    await openPanel('Workspace overview'); await openPanel('Dock notebook: Workspace tips');
    await until(`return document.querySelectorAll('[data-workspace-pane]').length===8 && document.querySelector('.session-notebook--embedded [contenteditable="true"]')?.textContent.includes('Verify docking')`);
    assert.equal(await script(`return [...document.querySelectorAll('[data-workspace-pane]')].filter(el=>el.dataset.floating==='true').length`), 2);
    assert.ok(await script(`return [...document.querySelectorAll('.session-workspace-preset-menu button')].find(b=>b.textContent.includes('Session notebook'))?.disabled`), 'ninth pane is blocked');
    const noteReadsBefore = noteRequests.length;
    const mixed = await sample();
    assert.equal(noteRequests.length, noteReadsBefore, 'stream refresh does not poll notebook content');
    assert.ok(mixed.reads <= baseline.reads && mixed.requests <= baseline.requests, JSON.stringify({ baseline, mixed }));
    assert.ok(await script(`return window.__hosts.every(el=>el.isConnected)`), 'adding resources preserves all six session hosts');
    await openPanel('Close Preview panels');
    await until(`return document.querySelectorAll('[data-workspace-pane]').length===6`);
    assert.ok(await script(`return window.__hosts.every(el=>el.isConnected)`), 'Preview exit preserves chat hosts');
    await delay(500);
    await request(`/session/${id}/refresh`, 'POST', {});
    await until(`return document.querySelectorAll('[data-session-pane]').length===6`);
    assert.equal(await script(`return document.querySelectorAll('.workspace-dashboard,.session-notebook--embedded').length`), 0);
    assert.equal(await script(`return localStorage.getItem('agentopsdeck.saved-layouts.v1:${scope}')`), JSON.stringify(saved));
    // Leave only a session note and account-owned resources: invalidation must
    // work even when no chat host remains to report the revoked session.
    await script(`for(const host of [...document.querySelectorAll('[data-session-pane]')].slice(1)) host.closest('[data-workspace-pane]').querySelector('[aria-label="Close pane"]').click(); return true;`);
    await openPanel('Session notebook'); await openPanel('Workspace overview'); await openPanel('Dock notebook: Workspace tips');
    await until(`return document.querySelectorAll('.session-notebook--embedded').length===2`);
    await script(`document.querySelector('[data-session-pane]').closest('[data-workspace-pane]').querySelector('[aria-label="Close pane"]').click(); return true;`);
    await until(`return !document.querySelector('[data-session-pane]')`);
    sourceState = 'unavailable'; emit(); await delay(1600);
    assert.equal(await script(`return document.querySelectorAll('.session-notebook--embedded').length`), 2, 'temporary failure does not revoke notes');
    sourceState = 'denied'; emit();
    await until(`return document.querySelectorAll('.session-notebook--embedded').length===1`);
    assert.ok(await script(`return document.querySelector('.session-notebook--embedded [contenteditable="true"]')?.textContent.includes('Verify docking') && !!document.querySelector('.workspace-dashboard')`));
    assert.equal(noteRequests.filter(row=>row.method==='PUT').length, 0);
    await script(`window.dispatchEvent(new Event('agentopsdeck:auth-required')); return true;`);
    await until(`return !document.querySelector('.session-notebook--embedded')`);
    const lockedReads = noteRequests.length; emit(); await delay(1600);
    assert.equal(noteRequests.length, lockedReads, 'locked UI performs no notebook reads');
    assert.equal(messageWrites, 0); assert.deepEqual(await script('return window.__errors'), []);
    console.log(JSON.stringify({ phase: 'boundaries', sixPlusTwoCapacity: true, ninthBlocked: true, baseline, mixed,
      noNotebookPolling: true, previewExitPersisted: true, stableChatHosts: true, notebookOnlyRevocation: true,
      unavailablePreservesNotes: true, lockHidesNotes: true, legacyStoragePreserved: true, messageWrites, evidence }));
  } else if (scenario === 'notebooks') {
    await request(`/session/${id}/window/rect`, 'POST', { width: 1800, height: 1100 });
    await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/#/session/${encodeURIComponent(sessions[0].sessionKey)}` });
    await until(`return document.querySelector('.message-selection-surface')?.textContent.includes('Sync text 1')`);
    const openNote = text => script(`document.querySelector('[aria-label="Layout presets"]').click(); [...document.querySelectorAll('.session-workspace-preset-menu button')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click(); return true;`);
    await until(`return [...document.querySelectorAll('.session-workspace-preset-menu button')].some(b=>b.textContent.includes('Dock notebook: Workspace tips'))`);
    await openNote('Dock notebook: Workspace tips');
    await until(`return document.querySelector('.session-notebook--embedded [contenteditable="true"]')?.textContent.includes('Verify docking')`);
    assert.equal(noteRequests.filter(row => row.method === 'PUT').length, 0, 'opening a notebook does not rewrite Markdown or layout');
    await click('Global notebook'); await click('Workspace tips');
    await until(`return document.querySelector('.session-notebook--embedded [contenteditable="true"]')===document.activeElement`);
    assert.equal(await script(`return document.querySelectorAll('.session-notebook [contenteditable="true"]').length`), 1, 'catalog focuses the existing editor rather than opening a second one');
    const putCount = () => noteRequests.filter(row => row.method === 'PUT' && row.path === '/api/hub/v1/notebooks/default').length;
    const typeIn = (selector, text) => script(`const editor=document.querySelector(${JSON.stringify(selector)}); editor.focus(); const range=document.createRange(); range.selectNodeContents(editor); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText',false,${JSON.stringify(text)}); return true;`);
    const dockEditor = '.session-notebook--embedded [contenteditable="true"]';
    await delay(800);
    assert.equal(putCount(), 0, 'focusing the loaded task list must not normalize and save its Markdown');
    await script(`document.querySelector('.session-notebook--embedded input[type="checkbox"]').click(); return true;`);
    await until(`return document.querySelector('.session-notebook--embedded input[type="checkbox"]')?.checked && document.querySelector('.session-notebook--embedded .notebook-footer')?.textContent.includes('Saved to Hub')`);
    assert.match(noteDocuments.get('/api/hub/v1/notebooks/default').text, /- \[x\] Verify docking/);
    assert.equal(putCount(), 1, 'a real task checkbox edit is saved exactly once');
    await typeIn(dockEditor, 'Shared draft from dock');
    await until(`return document.querySelector('.session-notebook--embedded .notebook-footer')?.textContent.includes('Saved to Hub')`);
    assert.equal(putCount(), 2, 'one edit creates exactly one content write');
    await script(`window.__catalogEditor=document.querySelector(${JSON.stringify(dockEditor)}); document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').querySelector('[aria-label="Float pane"]').click(); return true;`);
    await until(`return document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').dataset.floating==='true'`);
    assert.ok(await script(`return window.__catalogEditor===document.querySelector(${JSON.stringify(dockEditor)})`));
    await typeIn(dockEditor, 'Shared draft from float');
    await until(`return document.querySelector(${JSON.stringify(dockEditor)})?.textContent.includes('Shared draft from float')`);
    await until(`return document.querySelector('.session-notebook--embedded .notebook-footer')?.textContent.includes('Saved to Hub')`);
    assert.equal(putCount(), 3);
    await script(`document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').querySelector('[aria-label="Dock pane"]').click(); return true;`);
    await until(`return document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').dataset.floating==='false'`);
    noteDelay = 500;
    await typeIn(dockEditor, 'Close while saving');
    await script(`document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').querySelector('[aria-label="Close pane"]').click(); return true;`);
    await openNote('Dock notebook: Workspace tips');
    await until(`return document.querySelector(${JSON.stringify(dockEditor)})?.textContent.includes('Close while saving')`);
    await until(`return document.querySelector('.session-notebook--embedded .notebook-footer')?.textContent.includes('Saved to Hub')`);
    noteDelay = 0; assert.equal(putCount(), 4, 'close/reopen does not race the pending write');
    noteOffline = true; await typeIn(dockEditor, 'Offline retained draft');
    await until(`return document.querySelector('.session-notebook--embedded .notebook-footer')?.textContent.includes('draft retained')`);
    noteOffline = false; // No manual Retry or online event: exercise the existing timer.
    await until(`return document.querySelector('.session-notebook--embedded .notebook-footer')?.textContent.includes('Saved to Hub')`);
    assert.equal(noteDocuments.get('/api/hub/v1/notebooks/default').text, 'Offline retained draft');
    noteOffline = true; await typeIn(dockEditor, 'Local conflict draft');
    await until(`return document.querySelector('.session-notebook--embedded .notebook-footer')?.textContent.includes('draft retained')`);
    const previous = noteDocuments.get('/api/hub/v1/notebooks/default');
    noteDocuments.set('/api/hub/v1/notebooks/default', { ...previous, text: 'Saved by another tab', revision: previous.revision + 1 }); noteOffline = false;
    await until(`return !!document.querySelector('.session-notebook--embedded .notebook-conflict')`);
    await script(`[...document.querySelectorAll('.session-notebook--embedded .notebook-conflict button')].find(b=>b.textContent==='Use saved version').click(); return true;`);
    await until(`return document.querySelector(${JSON.stringify(dockEditor)})?.textContent.includes('Saved by another tab')`);
    await script(`window.__noteEditor=document.querySelector(${JSON.stringify(dockEditor)}); document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').querySelector('[aria-label="Float pane"]').click(); return true;`);
    await until(`return document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').dataset.floating==='true'`);
    assert.ok(await script(`return window.__noteEditor===document.querySelector(${JSON.stringify(dockEditor)})`), 'floating does not recreate editor');
    await script(`document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').querySelector('[aria-label="Dock pane"]').click(); return true;`);
    const dragPoints = await script(`const pane=document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]');
      const handle=pane.querySelector('.session-pane-drag').getBoundingClientRect(), area=document.querySelector('.session-workspace-surface').getBoundingClientRect();
      return {start:{x:Math.round(handle.x+handle.width/2),y:Math.round(handle.y+handle.height/2)},end:{x:Math.round(area.x+8),y:Math.round(area.y+area.height/2)}};`);
    await pointer([{ type: 'pointerMove', duration: 0, ...dragPoints.start }, { type: 'pointerDown', button: 0 }, { type: 'pointerMove', duration: 250, ...dragPoints.end }, { type: 'pointerUp', button: 0 }]);
    await until(`return document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').getBoundingClientRect().x < document.querySelector('[data-session-pane]').closest('[data-workspace-pane]').getBoundingClientRect().x`);
    assert.ok(await script(`return window.__noteEditor===document.querySelector(${JSON.stringify(dockEditor)})`), 'pointer dragging preserves the editor');
    await script(`document.querySelector('.session-notebook--embedded .notebook-title button').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return true;`);
    await until(`return document.querySelector('.session-notebook--embedded [aria-label="Notebook name"]')`);
    await script(`const input=document.querySelector('.session-notebook--embedded [aria-label="Notebook name"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Renamed workspace tips'); input.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
    await script(`document.querySelector('.session-notebook--embedded [aria-label="Notebook name"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true;`);
    await until(`return [...document.querySelectorAll('.session-workspace-preset-menu button')].some(b=>b.textContent.includes('Dock notebook: Renamed workspace tips')) && document.querySelector('.session-notebook--embedded').closest('[data-workspace-pane]').querySelector('.session-pane-drag-title')?.textContent.includes('Renamed workspace tips')`);
    await openNote('Session notebook · Preview');
    await until(`return document.querySelectorAll('.session-notebook--embedded [contenteditable="true"]').length===2`);
    await typeIn('.session-notebook--embedded[aria-label="Session notebook"] [contenteditable="true"]', 'Private session draft');
    await until(`return document.querySelector('.session-notebook--embedded[aria-label="Session notebook"] .notebook-footer')?.textContent.includes('Saved to Hub')`);
    assert.equal(noteDocuments.get(sessionNotePath).text, 'Private session draft');
    assert.equal(noteDocuments.get('/api/hub/v1/notebooks/default').text, 'Saved by another tab');
    await delay(350); await request(`/session/${id}/refresh`, 'POST', {});
    await until(`return document.querySelectorAll('.session-notebook--embedded [contenteditable="true"]').length===2 && document.body.innerText.includes('Private session draft') && document.body.innerText.includes('Saved by another tab')`);
    await writeFile(resolve(evidence, 'notebooks.png'), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
    assert.ok(requests.every(entry => entry.type === 'direct' ? entry.key === sessions[0].sessionKey : entry.keys.every(key => key === sessions[0].sessionKey)), 'notebooks never subscribe as sessions');
    assert.equal(messageWrites, 0); assert.deepEqual(await script('return window.__errors'), []);
    console.log(JSON.stringify({ phase: 'notebooks', sharedWriter: true, noRewriteOnOpen: true, todoSharedSave: true, closeReopenDuringSave: true, automaticOfflineRecovery: true,
      explicitConflictResolution: true, stableEditorFloatDock: true, pointerDrag: true, liveCatalogRename: true, sessionAndHubIsolation: true, refreshRestore: true, messageWrites, evidence }));
  } else if (scenario === 'panels') {
  await request(`/session/${id}/window/rect`, 'POST', { width: 1800, height: 1100 });
  await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/#/session/${encodeURIComponent(sessions[0].sessionKey)}` });
  await until(`return document.querySelector('.message-selection-surface')?.textContent.includes('Sync text 1')`);
  assert.equal(await script(`return !!document.querySelector('.workspace-dashboard')`), false, 'overview is opt-in');
  const openOverview = () => script(`document.querySelector('[aria-label="Layout presets"]').click(); [...document.querySelectorAll('.session-workspace-preset-menu button')].find(b=>b.textContent.includes('Workspace overview')).click(); return true;`);
  await script(`window.__originalComposer=document.querySelector('.desktop-composer-textarea'); return true;`);
  await openOverview();
  await until(`return document.querySelectorAll('[data-workspace-pane]').length===2 && document.querySelector('.workspace-dashboard')`);
  assert.ok(await script(`return window.__originalComposer===document.querySelector('.desktop-composer-textarea')`), 'session controller survives adding resource pane');
  assert.equal(await script(`return document.querySelectorAll('.workspace-dashboard-session').length`), 6);
  // Memoized overview must still react to local filters and new metadata.
  const searchOverview = value => script(`const input=document.querySelector('.workspace-dashboard-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
  await searchOverview('fixture 4');
  await until(`return document.querySelectorAll('.workspace-dashboard-session').length===1 && document.querySelector('.workspace-dashboard-session').textContent.includes('fixture 4')`);
  await searchOverview('');
  await script(`document.querySelector('.workspace-dashboard-counts [data-state="idle"]').click(); return true;`);
  await until(`return document.querySelectorAll('.workspace-dashboard-session').length===0`);
  await script(`document.querySelector('.workspace-dashboard-counts [data-state="idle"]').click(); return true;`);
  sessions[4].title = 'Updated overview metadata';
  emit();
  await until(`return document.querySelector('.workspace-dashboard-list').textContent.includes('Updated overview metadata')`);
  await searchOverview('updated overview');
  await until(`return document.querySelectorAll('.workspace-dashboard-session').length===1`);
  await searchOverview('');
  await until(`return document.querySelectorAll('.workspace-dashboard-session').length===6`);
  const legacy = await script(`return localStorage.getItem('agentopsdeck.saved-layouts.v1:${scope}')`);
  // The non-session pane uses exactly the same float/collapse/dock controls.
  await script(`document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').querySelector('[aria-label="Float pane"]').click(); return true;`);
  await until(`return document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').dataset.floating==='true'`);
  await script(`document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').querySelector('[aria-label="Collapse floating pane"]').click(); return true;`);
  await until(`return document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').dataset.collapsed==='true'`);
  await delay(350);
  const snapshot = await script(`return JSON.parse(localStorage.getItem('agentopsdeck.current-layout.v2:${scope}'))`);
  assert.equal(snapshot.workspace.version, 2);
  assert.deepEqual(snapshot.collapsedKeys, ['\u0000dashboard:overview']);
  await request(`/session/${id}/refresh`, 'POST', {});
  await until(`return document.querySelector('.workspace-dashboard')?.closest('[data-workspace-pane]').dataset.collapsed==='true'`);
  await script(`document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').querySelector('[aria-label="Expand floating pane"]').click(); return true;`);
  await script(`document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').querySelector('[aria-label="Dock pane"]').click(); return true;`);
  await until(`return document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').dataset.floating==='false'`);
  assert.ok(requests.every(entry => entry.type === 'direct' ? entry.key === sessions[0].sessionKey : entry.keys.every(key => key === sessions[0].sessionKey)), 'dashboard never prefetches other session transcripts');
  // Pointer drag uses the same stable host; release on the left workspace rim.
  const dragPoints = await script(`const pane=document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]'); window.__dashboardHost=pane;
    const handle=pane.querySelector('.session-pane-drag').getBoundingClientRect(), area=document.querySelector('.session-workspace-surface').getBoundingClientRect();
    return {start:{x:Math.round(handle.x+handle.width/2),y:Math.round(handle.y+handle.height/2)},end:{x:Math.round(area.x+8),y:Math.round(area.y+area.height/2)}};`);
  await pointer([{ type: 'pointerMove', duration: 0, ...dragPoints.start }, { type: 'pointerDown', button: 0 }, { type: 'pointerMove', duration: 250, ...dragPoints.end }, { type: 'pointerUp', button: 0 }]);
  await until(`const dashboard=document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]'), session=document.querySelector('[data-session-pane]').closest('[data-workspace-pane]'); return dashboard.getBoundingClientRect().x < session.getBoundingClientRect().x`);
  assert.ok(await script(`return document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]')===window.__dashboardHost`));
  // A dashboard click navigates only the session host, never replaces itself.
  await script(`document.querySelectorAll('.workspace-dashboard-session')[1].click(); return true;`);
  await until(`return document.querySelector('[data-session-pane="${sessions[1].sessionKey}"]') && document.querySelector('.workspace-dashboard')`);
  await openOverview();
  assert.equal(await script(`return document.querySelectorAll('.workspace-dashboard').length`), 1);
  // Save a mixed arrangement through the actual modal and preserve legacy data.
  await script(`document.querySelector('[aria-label="Saved layouts"]').click(); document.querySelector('.saved-layout-new').click(); return true;`);
  await until(`return document.querySelector('dialog[open] input')`);
  await script(`const input=document.querySelector('dialog[open] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Mixed overview'); input.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
  await script(`document.querySelector('dialog[open] form').requestSubmit(); return true;`);
  await until(`return !document.querySelector('dialog[open]')`);
  const mixedSaved = await script(`return JSON.parse(localStorage.getItem('agentopsdeck.saved-layouts.v2:${scope}'))`);
  assert.equal(mixedSaved.length, 2);
  assert.equal(mixedSaved[1].workspace.version, 2);
  assert.equal(await script(`return localStorage.getItem('agentopsdeck.saved-layouts.v1:${scope}')`), legacy);
  await writeFile(resolve(evidence, 'panels.png'), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
  // Compact desktop renders resource and session tabs, not duplicate controllers.
  await request(`/session/${id}/window/rect`, 'POST', { width: 1050, height: 540 });
  await until(`return document.querySelector('.session-workspace-tabs')`);
  await script(`const tabs=[...document.querySelectorAll('.session-workspace-tabs button')]; tabs.find(b=>b.textContent.includes('Workspace overview')).click(); return true;`);
  assert.ok(await script(`return !document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').hidden`));
  await request(`/session/${id}/window/rect`, 'POST', { width: 1800, height: 1100 });
  await until(`return !document.querySelector('.session-workspace-tabs')`);
  // Restore legacy named layout still works and caps at six sessions. The seventh
  // pane (overview) floats; no fake session is admitted to either transport.
  await script(`document.querySelector('[aria-label="Saved layouts"]').click(); document.querySelector('.saved-layout-row > button').click(); return true;`);
  await until(`return document.querySelectorAll('[data-session-pane]').length===6 && !document.querySelector('.workspace-dashboard')`);
  await openOverview();
  await until(`return document.querySelector('.workspace-dashboard').closest('[data-workspace-pane]').dataset.floating==='true'`);
  await delay(400);
  const keys = requests.flatMap(entry => entry.type==='batch' ? entry.keys : [entry.key]);
  assert.ok(keys.length && keys.every(key => sessions.some(session=>session.sessionKey===key)), 'only real sessions are read');
  assert.equal(messageWrites, 0, 'arranging dashboard never sends a message');
  assert.deepEqual(await script('return window.__errors'), []);
  console.log(JSON.stringify({ phase: 'panels', optIn: true, mixedLayout: true, stableSessionHost: true, floatCollapseDock: true, refreshRestore: true,
    legacyStoragePreserved: true, pointerDrag: true, compactTabs: true, sixSessionPlusOverview: true, onlyRealSessionReads: true,
    overviewSearchAndFilter: true, liveOverviewMetadata: true, messageWrites, evidence }));
  } else if (scenario === 'desktop') {
  await request(`/session/${id}/window/rect`, 'POST', { width: 2200, height: 1600 });
  await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/#/session/${encodeURIComponent(sessions[0].sessionKey)}` });
  await until(`return document.querySelector('[aria-label="Saved layouts"]') && document.querySelectorAll('[data-session-card]').length >= 6 && document.querySelector('.message-selection-surface')?.textContent.includes('Sync text 1')`);
  await script(`document.querySelector('[aria-label="Saved layouts"]').click(); document.querySelector('.saved-layout-row > button').click(); return true;`);
  await until(`return document.querySelectorAll('[data-session-pane]').length === 6 && document.querySelectorAll('.message-selection-surface').length === 6`);
  assert.ok(await script(`return [...document.querySelectorAll('.session-state-header')].every(el => getComputedStyle(el).backgroundImage === 'none' && getComputedStyle(el).animationName === 'none')`));
  assert.ok(await script(`return [...document.querySelectorAll('.session-pane-caption')].every(el => getComputedStyle(el).backgroundImage.includes('gradient'))`));
  assert.ok(await script(`return [...document.querySelectorAll('.desktop-session-frame')].every(el => {
    const style = getComputedStyle(el), caption = el.closest('[data-workspace-pane]').querySelector('.session-pane-caption');
    return style.borderTopLeftRadius === '0px' && style.borderTopRightRadius === '0px'
      && Math.abs(el.getBoundingClientRect().top - caption.getBoundingClientRect().bottom) < 1;
  })`), 'Toolbar meets the caption without rounded cutouts or a gap');
  // 2.2.4: real mouse moves focus the correct composer without clicking/sending.
  await hoverPane(1);
  assert.equal(await focusedPane(), sessions[1].sessionKey);
  const composer = await request(`/session/${id}/element/active`);
  await request(`/session/${id}/element/${Object.values(composer)[0]}/value`, 'POST', { text: 'Unsent hover draft' });
  await hoverPane(2);
  assert.equal(await focusedPane(), sessions[2].sessionKey);
  await hoverPane(1);
  assert.equal(await script('return document.activeElement.value'), 'Unsent hover draft');
  await script(`document.activeElement.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); return true;`);
  await hoverPane(2);
  assert.equal(await focusedPane(), sessions[1].sessionKey, 'IME composition keeps its editor');
  await script(`document.activeElement.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); const el=document.createElement('div'); el.id='hover-test-overlay'; el.setAttribute('role','menu'); el.textContent='Menu'; document.body.append(el); return true;`);
  await hoverPane(3);
  assert.equal(await focusedPane(), sessions[1].sessionKey, 'Visible menu blocks focus following');
  await script(`document.getElementById('hover-test-overlay').remove(); const el=document.createElement('textarea'); el.id='hover-test-editor'; document.body.append(el); el.focus(); return true;`);
  await hoverPane(2);
  assert.equal(await script('return document.activeElement.id'), 'hover-test-editor', 'Another editor is not interrupted');
  await script(`document.getElementById('hover-test-editor').remove(); return true;`);
  await hoverPane(0);
  assert.equal(await focusedPane(), sessions[0].sessionKey);
  assert.equal(messageWrites, 0);
  console.log(JSON.stringify({ phase: 'hover-focus', mouseActivatesComposer: true, draftPreserved: true, imeProtected: true, menuProtected: true, otherEditorProtected: true, messageWrites }));
  await click('Browser and sign-in settings');
  const toggle = 'input[role="switch"][aria-label="Workspace sync · Preview"]';
  await until(`return document.querySelector(${JSON.stringify(toggle)})`);
  assert.equal(await script(`return document.querySelector(${JSON.stringify(toggle)}).checked`), false);
  await script(`document.querySelector(${JSON.stringify(toggle)}).click(); return true;`); await click('Close settings');
  await delay(1800); requests.length = 0; emit();
  await until(`return [...document.querySelectorAll('.message-selection-surface')].every(el => el.textContent.includes('Sync text ${revision}'))`);
  assert.ok(requests.some(entry => entry.type === 'batch' && entry.size >= 5), JSON.stringify(requests));
  assert.equal(requests.filter(entry => entry.type === 'direct').length, 0);
  const batchedReads = [...requests];
  slow = true; emit();
  await until(`return [...document.querySelectorAll('.message-selection-surface')].filter(el => el.textContent.includes('Sync text ${revision}')).length >= 5`);
  assert.equal(await script(`return document.querySelector('[data-session-pane="${sessions[0].sessionKey}"] .message-selection-surface').textContent.includes('Sync text ${revision}')`), false);
  await until(`return [...document.querySelectorAll('.message-selection-surface')].every(el => el.textContent.includes('Sync text ${revision}'))`); slow = false;
  failed = true; requests.length = 0; emit();
  await until(`return document.body.textContent.includes('Synthetic isolated failure')`);
  assert.equal(await script(`return document.querySelector('[data-session-pane="${sessions[0].sessionKey}"] .session-state-header').dataset.sessionState`), 'error');
  assert.equal(await script(`return document.querySelectorAll('.session-pane-error').length`), 0);
  assert.equal(await script(`return document.querySelector('.history-sync-issue').open`), false);
  assert.equal(requests.filter(entry => entry.type === 'direct').length, 0); failed = false;
  await click('Browser and sign-in settings'); await script(`document.querySelector(${JSON.stringify(toggle)}).click(); return true;`); await click('Close settings');
  await delay(1800); requests.length = 0; emit();
  await until(`return [...document.querySelectorAll('.message-selection-surface')].every(el => el.textContent.includes('Sync text ${revision}'))`);
  assert.ok(requests.filter(entry => entry.type === 'direct').length >= 6); assert.equal(requests.filter(entry => entry.type === 'batch').length, 0);
  await click('Browser and sign-in settings'); await script(`document.querySelector(${JSON.stringify(toggle)}).click(); return true;`);
  assert.equal(await script(`return localStorage.getItem('agentopsdeck.workspace-sync-preview.v1:${scope}')`), 'on');
  // A full browser reload must restore the user's selection.
  await until(`return JSON.parse(localStorage.getItem('agentopsdeck.current-layout.v2:${scope}') || 'null')?.workspace.panes.length === 6`);
  const beforeReloadLayout = await script(`return JSON.parse(localStorage.getItem('agentopsdeck.current-layout.v2:${scope}')).workspace`);
  await request(`/session/${id}/refresh`, 'POST', {}); await until(`return document.querySelector('button[aria-label="Browser and sign-in settings"]')`);
  await until(`return document.querySelectorAll('[data-session-pane]').length === 6`);
  assert.deepEqual(await script(`return JSON.parse(localStorage.getItem('agentopsdeck.current-layout.v2:${scope}')).workspace`), beforeReloadLayout);
  await click('Browser and sign-in settings'); await until(`return document.querySelector(${JSON.stringify(toggle)})?.checked`);
  unsupported = true; await click('Close settings'); emit(); await delay(1800); await click('Browser and sign-in settings');
  await until(`return document.body.textContent.includes('This Hub does not support Preview; using standard sync.')`);
  await click('Close settings');
  await until(`return document.querySelectorAll('[data-session-pane]').length === 6`);
  await click('Browser and sign-in settings');
  // 2.2.3: real pointer movement in a six-pane page. Root typography and
  // synchronous storage must not change on every pointermove.
  await script(`document.querySelector('[data-font-preference="chat"] .font-scale-slider').scrollIntoView({block:'center'});
    window.__fontWrites=0; const original=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){ if(k.includes('font-preferences'))window.__fontWrites++; return original.call(this,k,v); }; return true;`);
  const slider = await script(`const r=document.querySelector('[data-font-preference="chat"] .font-scale-slider').getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y+r.height/2),width:Math.round(r.width)};`);
  const rootScale = await script(`return document.documentElement.style.getPropertyValue('--agentopsdeck-chat-font-scale')`);
  await pointer([{ type: 'pointerMove', duration: 0, x: slider.x + Math.round(slider.width * .43), y: slider.y }, { type: 'pointerDown', button: 0 },
    ...[.5,.6,.7,.8,.86].map(f => ({ type: 'pointerMove', duration: 100, x: slider.x + Math.round(slider.width*f), y: slider.y }))]);
  assert.equal(await script(`return document.documentElement.style.getPropertyValue('--agentopsdeck-chat-font-scale')`), rootScale);
  assert.equal(await script('return window.__fontWrites'), 0);
  const draft = Number(await script(`return document.querySelector('[data-font-preference="chat"] .font-scale-slider').value`));
  assert.ok(draft >= 125, `pointer drag did not move: ${draft}`);
  await pointer([{ type: 'pointerUp', button: 0 }]);
  assert.equal(Number(await script(`return document.documentElement.style.getPropertyValue('--agentopsdeck-chat-font-scale')`)), draft/100);
  assert.equal(await script('return window.__fontWrites'), 1);
  assert.equal(await script(`return document.documentElement.style.getPropertyValue('--agentopsdeck-sessions-font-scale')`), '1');
  const sliderElement = await request(`/session/${id}/element`, 'POST', { using: 'css selector', value: '[data-font-preference="chat"] .font-scale-slider' });
  await request(`/session/${id}/element/${Object.values(sliderElement)[0]}/value`, 'POST', { text: '\uE012' });
  assert.equal(Number(await script(`return document.querySelector('[data-font-preference="chat"] .font-scale-slider').value`)), draft - 1);
  await click('Close settings');
  // Completion is visible in both title bars; only focusing the other pane
  // acknowledges its unread state, without clearing the completed outcome.
  for (const index of [0,1]) Object.assign(sessions[index], { hasActiveRun: false, status: 'idle', runCompletedAt: now + 100,
    runtime: { ...sessions[index].runtime, phase: 'completed', threadActivity: 'idle' } });
  Object.assign(sessions[2], { hasActiveRun: false, status: 'failed', runtime: { ...sessions[2].runtime, phase: 'failed', threadActivity: 'idle' } });
  emit();
  await until(`return document.querySelector('[data-session-pane="${sessions[1].sessionKey}"] .session-state-header')?.dataset.sessionState==='unread'`);
  await until(`return document.querySelectorAll('[data-final-reply=true]').length === 2`);
  assert.equal(await script(`return document.querySelector('[data-session-pane="${sessions[2].sessionKey}"] .session-state-header').dataset.sessionState`), 'error');
  assert.equal(await script(`return document.querySelector('[data-session-pane="${sessions[0].sessionKey}"] .session-state-header').dataset.sessionState`), 'completed');
  assert.ok(await script(`return [...document.querySelectorAll('.session-state-header')].every(el => getComputedStyle(el).backgroundImage === 'none' && getComputedStyle(el).animationName === 'none')`));
  assert.ok(await script(`return [...document.querySelectorAll('.session-pane-caption')].every(el => getComputedStyle(el).backgroundImage.includes('gradient'))`));
  assert.ok(await script(`return getComputedStyle(document.querySelector('[data-final-reply=true] [data-message-bubble]')).backgroundImage.includes('gradient')`));
  await writeFile(resolve(evidence, 'desktop.png'), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
  await script(`document.querySelector('[data-session-card="${sessions[1].sessionKey}"]').click(); return true;`);
  await until(`return document.querySelector('[data-session-pane="${sessions[1].sessionKey}"] .session-state-header').dataset.sessionState==='completed'`);
  assert.equal(await script(`return document.querySelector('[data-session-pane="${sessions[1].sessionKey}"]').closest('[data-workspace-pane]').dataset.active`), 'true');
  assert.ok(await script(`return getComputedStyle(document.querySelector('[data-session-card][aria-current=true]')).outlineWidth==='2px'`));
  // Reload restores committed typography, not merely the local slider draft.
  await request(`/session/${id}/refresh`, 'POST', {});
  await until(`return Number(document.documentElement.style.getPropertyValue('--agentopsdeck-chat-font-scale')) === ${(draft-1)/100}`);
  await until(`return document.querySelectorAll('[data-session-pane]').length === 6 && document.querySelector('[data-session-pane="${sessions[1].sessionKey}"]').closest('[data-workspace-pane]').dataset.active === 'true'`);
  // A workspace link without a selected session restores the saved focus too.
  await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/` });
  await request(`/session/${id}/refresh`, 'POST', {});
  await until(`return document.querySelectorAll('[data-session-pane]').length === 6 && document.querySelector('[data-session-pane="${sessions[1].sessionKey}"]').closest('[data-workspace-pane]').dataset.active === 'true'`);
  // Unequal splits + two floats, including a collapsed float, survive metadata
  // loading and reload without changing the authenticated user's geometry.
  const floatingLayout = { id: 'current', name: 'Current', collapsedKeys: [sessions[4].sessionKey], workspace: {
    version: 1, panes, active: panes[5].id,
    dock: { kind: 'split', axis: 'horizontal', ratio: .57,
      first: { kind: 'split', axis: 'vertical', ratio: .46, first: leaf(0), second: leaf(1) },
      second: { kind: 'split', axis: 'vertical', ratio: .52, first: leaf(2), second: leaf(3) } },
    floating: [4, 5].map(i => ({ id: panes[i].id, x: .08 + (i - 4) * .15, y: .12, width: .4, height: .6 })),
  } };
  await delay(300);
  await script(`localStorage.setItem('agentopsdeck.current-layout.v2:${scope}',${JSON.stringify(JSON.stringify(floatingLayout))}); history.replaceState(null,'','/'); return true;`);
  await request(`/session/${id}/refresh`, 'POST', {});
  await until(`return document.querySelectorAll('[data-workspace-pane][data-floating=true]').length === 2 && document.querySelector('[data-workspace-pane][data-collapsed=true]') && document.querySelector('[data-session-pane="${sessions[5].sessionKey}"]').closest('[data-workspace-pane]').dataset.active === 'true'`);
  await delay(300);
  assert.deepEqual(await script(`return JSON.parse(localStorage.getItem('agentopsdeck.current-layout.v2:${scope}'))`), floatingLayout);
  await request(`/session/${id}/refresh`, 'POST', {});
  await until(`return document.querySelectorAll('[data-workspace-pane][data-floating=true]').length === 2 && document.querySelector('[data-workspace-pane][data-collapsed=true]')`);
  assert.deepEqual(await script(`return JSON.parse(localStorage.getItem('agentopsdeck.current-layout.v2:${scope}'))`), floatingLayout);
  assert.deepEqual(await script('return window.__errors'), []);
  console.log(JSON.stringify({ phase: 'desktop', currentLayoutRestored: true, focusRestored: true, floatingGeometryAndCollapseRestored: true, browserErrors: [] }));
  console.log(JSON.stringify({ defaultOff: true, sixPaneBatch: batchedReads, fastFramesNotBlocked: true, isolated503: true, no503Fanout: true, liveToggle: true, persistedAfterReload: true, unsupportedFallback: true,
    currentLayoutRestored: true, currentLayoutFocusRestored: true, fontPointerDrag: true, noGlobalReflowDuringDrag: true, oneSaveOnRelease: true, fontKeyboard: true, fontPersists: true, completedReplyTint: true, unreadToRead: true, titleErrorState: true, strongerFocus: true, evidence, browserErrors: [] }));
  } else {
  // Separate reduced-motion mobile process: no state borrowed from desktop.
  await request(`/session/${id}/window/rect`, 'POST', { width: 430, height: 920 });
  await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(`return document.querySelectorAll('[data-session-card]').length >= 6`);
  assert.ok(await script(`const title=document.querySelector('[data-session-card="${sessions[1].sessionKey}"][data-session-state=unread] .mobile-session-title-row'); return title && getComputedStyle(title).backgroundImage.includes('gradient') && getComputedStyle(title).animationName==='none';`));
  await script(`document.querySelector('[data-session-card="${sessions[3].sessionKey}"]').click(); return true;`);
  await until(`return document.querySelector('.session-state-header[data-session-state=running]')`);
  assert.equal(await script(`return matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
  assert.equal(await script(`return getComputedStyle(document.querySelector('.session-state-header')).animationName`), 'none');
  assert.equal(await script(`return getComputedStyle(document.querySelector('.session-state-header')).backgroundImage`), 'none');
  await click('Back to sessions');
  await script(`document.querySelector('[data-session-card="${sessions[1].sessionKey}"]').click(); return true;`);
  await until(`return document.querySelector('[data-final-reply=true] [data-message-bubble]') && document.querySelector('.session-state-header[data-session-state=completed]')`);
  await writeFile(resolve(evidence, 'mobile.png'), Buffer.from(await request(`/session/${id}/screenshot`), 'base64'));
  assert.deepEqual(await script('return window.__errors'), []);
  console.log(JSON.stringify({ mobile: true, reducedMotion: true, evidence, browserErrors: [] }));
  }
} catch (error) {
  console.error(formatBoundedBrowserDiagnostic(error, `workspace-sync-${scenario}`));
  throw error;
} finally {
  let teardownError;
  try {
    await harness.close();
  } catch (err) {
    teardownError = err;
    console.error(formatBoundedBrowserDiagnostic(err, 'workspace-sync-teardown'));
  }
  for (const timer of timers) clearTimeout(timer);
  for (const stream of streams) stream.end();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!process.env.AOD_KEEP_BROWSER_EVIDENCE) {
    await rm(evidence, { recursive: true, force: true }).catch(() => {});
  }
  if (teardownError) throw teardownError;
}

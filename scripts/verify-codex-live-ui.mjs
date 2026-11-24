// Actual production React app, isolated HTTP/SSE fixtures, no real credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createIsolatedGeckodriverHarness, formatBoundedBrowserDiagnostic } from './lib/isolated-geckodriver-harness.mjs';

const dist = resolve('apps/web/dist');
const key = 'codex:ui-regression';
const now = Date.now();
const session = { sessionKey: key, source: 'codex', agentId: 'codex', title: 'Live regression', status: 'running', hasActiveRun: true, runStartedAt: now - 5000, runtime: { turnId: 't1', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: now } };
const otherKey = 'codex:other-session';
const otherSession = { ...session, sessionKey: otherKey, title: 'Other session', status: 'idle', hasActiveRun: false, runtime: { ...session.runtime, phase: 'completed' } };
const extraSessions = [];
let otherMessages = [{ id: 'other-message', sessionKey: otherKey, role: 'assistant', text: 'Other session response.', status: 'sent', createdAt: now }];
let revision = 1;
let messages = [{ id: 'selected', sessionKey: key, role: 'assistant', phase: 'commentary', text: 'Selected text stays stable.', status: 'sent', createdAt: now }];
const streams = new Set();
let failStreams = 1;
let streamAttempts = 0;
const sentPayloads = [];
const fixtureRequests = [];
const sourcePath = '/fixture/generated/review.md';
const sourceUrl = `/api/hub/v1/sessions/${encodeURIComponent(key)}/messages/source-reference/media/${'b'.repeat(64)}`;
let sourceStatus = 404, sourceReads = 0;
let sourceApprovalAvailable = false, sourceTemporary = false;
let sendDelay = 0, notebookConflict = false;
let historyPending = 0, pendingResponses = 0;
let notebook = { resourceId: 'fixture-notebook', revision: 1, text: '- [ ] Aligned task\n\n' + Array.from({ length: 60 }, (_, i) => `Note paragraph ${i}`).join('\n\n'), updatedAt: now };
const server = createServer(async (req, res) => {
  fixtureRequests.push(`${req.method} ${req.url}`);
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === `${sourceUrl}/approval` && ['POST', 'DELETE'].includes(req.method)) {
    sourceTemporary = req.method === 'POST'; sourceStatus = sourceTemporary ? 200 : 404;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (path === sourceUrl) {
    sourceReads++;
    res.writeHead(sourceStatus, { 'Content-Type': 'application/json', ...(sourceApprovalAvailable && sourceStatus === 404 ? { 'X-AgentOpsDeck-Source-Error': 'outside-roots', 'X-AgentOpsDeck-Source-Approval': 'available' } : {}) });
    res.end(JSON.stringify(sourceStatus === 200
      ? { path: sourcePath, line: 1, startLine: 1, totalLines: 12, text: '# Review fixture\n' + Array.from({ length: 11 }, (_, i) => `Review line ${i + 2}`).join('\n'), modifiedAt: now, ...(sourceTemporary ? { temporaryApproval: true } : {}) }
      : { error: 'unavailable' }));
    return;
  }
  if (path.endsWith('/messages') && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    sentPayloads.push(JSON.parse(body));
    if (sendDelay) await new Promise(resolve => setTimeout(resolve, sendDelay));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'sent' }));
    return;
  }
  if (path.endsWith('/notebook') && req.method === 'PUT') {
    let body = ''; for await (const chunk of req) body += chunk;
    if (notebookConflict) {
      notebookConflict = false; notebook = { ...notebook, text: 'Remote notebook version', revision: notebook.revision + 1 };
      res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Conflict' })); return;
    }
    notebook = { ...notebook, text: JSON.parse(body).text, revision: notebook.revision + 1, updatedAt: Date.now() };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(notebook)); return;
  }
  if (path.endsWith('/events/stream')) {
    streamAttempts++;
    if (failStreams > 0) { failStreams--; res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: heartbeat\ndata: \n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  if (path.startsWith('/api/')) {
    if (req.method === 'GET' && path.endsWith('/messages') && decodeURIComponent(path).includes(key) && historyPending > 0) {
      assert.equal(req.headers['x-agentopsdeck-history-async'], '1');
      historyPending--; pendingResponses++;
      res.writeHead(202, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ code: 'history_preparing', retryAfterMs: 250 })); return;
    }
    const body = path === '/api/auth/status' ? { authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } }
      : path === '/api/hub/v1/workspace/preferences' ? { revision: 1, groups: [{ id: 'fixture-group', name: 'Fixture group' }], sessions: { [key]: { groupId: 'fixture-group' } } }
      : path === '/api/hub/v1/notebooks' ? { items: [], nextCursor: null }
      : path.endsWith('/notebook') ? notebook
      : path.endsWith('/sessions/state') ? { groups: [{ agentId: 'codex', sessions: [session, otherSession, ...extraSessions] }], updatedAt: now, revision: String(revision) }
      : path.endsWith('/messages') && decodeURIComponent(path).includes(otherKey) ? { messages: otherMessages, updatedAt: now, revision: String(revision) }
      : path.endsWith('/messages') ? { messages, totalCount: messages.length, updatedAt: now, revision: String(revision) }
      : path === '/api/agents' ? { agents: [] }
      : path === '/api/gateway/status' ? { ok: true, status: 'online', updatedAt: now }
      : {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  try {
    const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${dist}/`)) throw new Error('bad path');
    res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] ?? 'application/octet-stream' });
    const content = await readFile(file);
    res.end(extname(file) === '.html' ? content.toString().replace('<head>', `<head><script>
      window.__AGENTOPSDECK_API_BASE_URL__ = location.origin;
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.includes('.messages.')) throw new DOMException('Synthetic message-cache quota failure', 'QuotaExceededError');
        return originalSetItem.call(this, key, value);
      };
    </script>`) : content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let harness;
let id;
const request = (path, method = 'GET', body) => harness.request(path, method, body);
const script = (source) => request(`/session/${id}/execute/sync`, 'POST', { script: source, args: [] });
const until = (source) => harness.untilScript(script, source, { attempts: 120, intervalMs: 150 });
function emit(sessionKey = key) {
  revision++;
  const event = { id: String(revision), type: 'stream.reset', ts: Date.now(), sessionKey, payload: { reason: 'fixture' } };
  for (const stream of streams) stream.write(`id: ${revision}\nevent: stream.reset\ndata: ${JSON.stringify(event)}\n\n`);
}
try {
  harness = await createIsolatedGeckodriverHarness({ fixturePort: port, prefix: 'agentopsdeck-live-ui-' });
  // Headless Linux may otherwise report no pointer, silently skipping desktop
  // hover/composer regressions. Emulate the fine + hover desktop device here.
  id = await harness.createSession({ 'ui.primaryPointerCapabilities': 6, 'ui.allPointerCapabilities': 6 });
  await request(`/session/${id}/window/rect`, 'POST', { width: 1280, height: 900 });
  await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${port}/#/session/${encodeURIComponent(key)}` });
  assert.equal(await script(`return matchMedia('(hover: hover) and (pointer: fine)').matches`), true, 'Desktop composer tests must not silently skip on a pointerless headless browser');
  await until('return !!document.querySelector("[data-message-search-id=selected] .markdown-body p")');
  await script(`document.querySelector('[aria-label="Group actions"]').click(); return true;`);
  await until(`return !!document.querySelector('.action-menu-popover')`);
  assert.equal(await script(`const m = document.querySelector('.action-menu-popover'), r = m.getBoundingClientRect(); return m.parentElement === document.body && m.contains(document.elementFromPoint(r.x + 30, r.y + 20)) && m.contains(document.activeElement);`), true, 'Group menu escapes rail clipping and receives focus');
  await script(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
  assert.equal(await script(`return document.activeElement.getAttribute('aria-label')`), 'Group actions');
  await script(`document.querySelector('[aria-label="Session notebook"]').click(); return true;`);
  await until(`return !!document.querySelector('.notebook-rich-content [type=checkbox]')`);
  const hoverAt = async (x, y) => request(`/session/${id}/actions`, 'POST', { actions: [{ type: 'pointer', id: 'composer-mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, origin: 'viewport', x, y }] }] });
  const notePoint = await script(`const r = document.querySelector('.notebook-rich-content').getBoundingClientRect(); return { x: Math.round(r.x + 50), y: Math.round(r.y + 55) };`);
  const panePoint = await script(`const r = document.querySelector('[data-session-pane="${key}"] .message-selection-surface').getBoundingClientRect(); return { x: Math.round(r.x + 40), y: Math.round(r.y + 70) };`);
  await hoverAt(panePoint.x, panePoint.y);
  await until(`return document.activeElement.matches('.desktop-composer-textarea')`);
  await hoverAt(notePoint.x, notePoint.y);
  await until(`return document.activeElement.matches('.notebook-rich-content')`);
  await script(`document.activeElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })); return true;`);
  await hoverAt(panePoint.x, panePoint.y); await delay(250);
  assert.equal(await script(`return document.activeElement.matches('.notebook-rich-content')`), true, 'Hover never interrupts notebook IME');
  await script(`document.activeElement.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); return true;`);
  await hoverAt(panePoint.x + 1, panePoint.y);
  await until(`return document.activeElement.matches('.desktop-composer-textarea')`);
  await script(`const r = document.createRange(); r.selectNodeContents(document.querySelector('.message-selection-surface p')); getSelection().removeAllRanges(); getSelection().addRange(r); return true;`);
  await hoverAt(notePoint.x, notePoint.y); await delay(250);
  assert.equal(await script(`return !!getSelection().toString() && !document.activeElement.matches('.notebook-rich-content')`), true, 'Notebook hover preserves transcript text selection');
  await script(`getSelection().removeAllRanges(); return true;`);
  await hoverAt(notePoint.x + 1, notePoint.y);
  await until(`return document.activeElement.matches('.notebook-rich-content')`);
  assert.equal(await script(`const nav = document.querySelector('.primary-navigation'), a = nav.querySelector('nav button').getBoundingClientRect(), b = nav.querySelector('.saved-layouts summary').getBoundingClientRect(); return Math.abs(a.x + a.width / 2 - b.x - b.width / 2) < 1 && nav.getBoundingClientRect().width === 64 && nav.querySelector('.primary-navigation-content > button').getBoundingClientRect().width === 32;`), true, 'Navigation icons align on the narrower rail');
  assert.equal(await script(`return document.querySelector('.session-notebook').textContent.includes('not sent to the agent')`), false);
  for (const scale of [0.8, 1, 1.2]) {
    const delta = await script(`document.documentElement.style.setProperty('--agentopsdeck-notebooks-font-scale', '${scale}'); const li = document.querySelector('.notebook-rich-content li[data-type=taskItem]'), a = li.querySelector('input').getBoundingClientRect(), b = li.querySelector('p').getBoundingClientRect(); return Math.abs(a.y + a.height / 2 - b.y - b.height / 2);`);
    assert.ok(delta < 3, 'Task checkbox aligned with first line at ' + scale + ': ' + delta);
  }
  await script(`document.documentElement.style.removeProperty('--agentopsdeck-notebooks-font-scale'); const content = document.querySelector('.notebook-rich-content'); content.parentElement.scrollTop = 400; return true;`);
  assert.equal(await script(`const c = document.querySelector('.notebook-rich-content').parentElement.getBoundingClientRect(), b = document.querySelector('.notebook-format-bar').getBoundingClientRect(); return c.top >= b.bottom - 1;`), true, 'Formatting bar is outside the text scrollport');
  await script(`document.querySelector('[aria-label="Notebook appearance"]').click(); return true;`);
  await script(`document.querySelector('.notebook-auto-collapse input').click(); document.querySelector('[aria-label="Notebook appearance"]').click(); document.querySelector('.notebook-rich-content').focus(); document.execCommand('insertText', false, 'Focused notebook draft'); return true;`);
  await delay(1100);
  assert.equal(await script(`return document.activeElement.closest('.notebook-rich-content') !== null && getComputedStyle(document.querySelector('.notebook-body')).display !== 'none';`), true, 'Autosave must not steal notebook focus or auto-collapse while editing');
  notebookConflict = true;
  await script(`document.execCommand('insertText', false, 'Conflict draft'); return true;`);
  await until(`return !!document.querySelector('.notebook-conflict')`);
  assert.equal(await script(`const b = [...document.querySelectorAll('.notebook-conflict button')].find(b => b.textContent === 'Use saved version'), r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));`), true, 'Conflict actions are not covered by editor text');
  await script(`document.querySelector('.notebook-rich-content').blur(); return true;`);
  assert.equal(await script(`return getComputedStyle(document.querySelector('.notebook-body')).display !== 'none'`), true, 'Unresolved conflict prevents automatic collapse');
  await script(`[...document.querySelectorAll('.notebook-conflict button')].find(b => b.textContent === 'Use saved version').click(); return true;`);
  await until(`return !document.querySelector('.notebook-conflict') && document.querySelector('.notebook-rich-content').textContent.includes('Remote notebook version')`);
  await script(`document.querySelector('.session-notebook [aria-label="Close notebook"]').click(); return true;`);
  await delay(1500);
  await until('return !document.body.innerText.includes("Live connection lost") && !document.body.innerText.includes("Reconnecting live updates")');
  assert.ok(streamAttempts >= 2, 'A terminal SSE failure must create a new connection');
  const attemptsBeforeSwitch = streamAttempts;
  const selectedReads = () => fixtureRequests.filter(url => url.startsWith(`GET /api/hub/v1/sessions/${encodeURIComponent(key)}/messages?`) && !url.includes('before=')).length;
  const readsBeforeSwitch = selectedReads();
  await script(`location.hash = '/session/${encodeURIComponent(otherKey)}'; return true;`);
  await until('return document.body.innerText.includes("Other session response.")');
  assert.equal(await script('return document.body.innerText.includes("Live connection lost")'), false);
  await script(`location.hash = '/session/${encodeURIComponent(key)}'; return true;`);
  await until('return !!document.querySelector("[data-message-search-id=selected] .markdown-body p")');
  assert.equal(streamAttempts, attemptsBeforeSwitch, 'Session navigation must reuse a healthy stream');
  assert.equal(selectedReads(), readsBeforeSwitch, 'A fresh switch-back must reuse the known first page without another read');
  historyPending = 3;
  emit();
  await until('return !!document.querySelector("[data-message-search-id=selected] .markdown-body p")');
  for (let i = 0; i < 80 && pendingResponses < 3; i++) await delay(250);
  assert.equal(pendingResponses, 3, 'real browser retries negotiated preparation');
  assert.equal(await script('return !!document.querySelector("[data-message-search-id=selected] .markdown-body p") && !document.body.innerText.includes("Connector request failed")'), true,
    'preparation preserves mounted messages and does not show a failure');
  await delay(500);
  await script(`const node = document.querySelector('[data-message-search-id=selected] .markdown-body p').firstChild; window.selectedNode = node; const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 13); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true;`);
  await delay(250);
  messages = [{ ...messages[0], text: 'Selected text was updated.' }, { id: 'new', sessionKey: key, role: 'assistant', text: 'New message arrived.', status: 'sent', createdAt: now + 1000 }];
  emit();
  await until('return document.body.innerText.includes("New message arrived.")');
  assert.equal(await script('return getSelection().toString()'), 'Selected text');
  assert.equal(await script('return getSelection().anchorNode === window.selectedNode'), true);
  await script('getSelection().removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); return true;');
  await until('return document.body.innerText.includes("Selected text was updated.")');
  for (const connection of ['disconnected', 'connected']) {
    session.runtime = { ...session.runtime, phase: 'unknown', connection };
    emit();
    const label = connection === 'disconnected' ? 'Connection lost · run state unconfirmed' : 'Checking run state';
    await until(`return document.body.innerText.includes(${JSON.stringify(label)})`);
    assert.equal(await script(`return [...document.querySelectorAll('[role=status]')].filter(node => node.textContent.includes(${JSON.stringify(label)})).some(node => node.querySelector('.animate-pulse') || /· \\d+s/.test(node.textContent))`), false);
  }
  session.runtime = { ...session.runtime, phase: 'finalizing', sync: 'syncing' };
  emit();
  await until('return document.body.innerText.includes("syncing final response")');
  session.runtime = { ...session.runtime, phase: 'completed', sync: 'syncing' };
  session.status = 'idle'; session.hasActiveRun = false;
  emit();
  await until('return document.body.innerText.includes("Run finished · syncing history")');
  assert.equal(await script('return [...document.querySelectorAll("[role=status]")].filter(node => node.textContent.includes("syncing history")).some(node => node.querySelector(".animate-pulse") || /· \\d+s/.test(node.textContent))'), false);
  session.runtime = { ...session.runtime, phase: 'completed', sync: 'current' };
  session.status = 'idle'; session.hasActiveRun = false;
  emit();
  await until('return !document.body.innerText.includes("syncing final response") && !document.body.innerText.includes("Agent is working")');
  session.runtime = { ...session.runtime, sync: 'error', reason: 'Missing final snapshot' };
  emit();
  await until('return document.body.innerText.includes("Run finished · history sync incomplete")');
  assert.equal(await script('return document.body.innerText.includes("retrying…")'), false);
  assert.equal(await script('return [...document.querySelectorAll("[role=status]")].filter(node=>node.textContent.includes("history sync incomplete")).some(node=>node.querySelector(".animate-pulse") || /· \\d+s/.test(node.textContent))'), false);
  failStreams = 100;
  for (const stream of streams) stream.end();
  await until('return document.body.innerText.includes("Reconnecting live updates")');
  await until('return document.body.innerText.includes("Live connection lost")');
  failStreams = 0;
  await until('return !document.body.innerText.includes("Live connection lost") && !document.body.innerText.includes("Reconnecting live updates")');
  assert.equal(streams.size, 1);
  messages.push({ id: 'recovered', sessionKey: key, role: 'assistant', text: 'Reply after stream recovery.', status: 'sent', createdAt: now + 2000 });
  emit();
  await until('return document.body.innerText.includes("Reply after stream recovery.")');
  await script(`window.fixtureErrors = []; addEventListener('unhandledrejection', e => window.fixtureErrors.push(String(e.reason))); return true;`);
  const chooseFile = (selector, name, type, data = 'fixture payload') => script(`
    const input = document.querySelector(${JSON.stringify(selector)});
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(data)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true;
  `);
  await chooseFile('input[type=file]', 'desktop-report.docx', 'application/octet-stream');
  await until(String.raw`return !!document.querySelector('[aria-label="Remove desktop-report.docx"]')`);
  assert.deepEqual(await script('return window.fixtureErrors'), [], 'File selection must not access a released React event after await');
  sendDelay = 1400;
  await script(String.raw`document.querySelector('[aria-label="Send message"]').click(); return true;`);
  await script(`document.querySelector('[aria-label="Session notebook"]').click(); return true;`);
  await until(`return !!document.querySelector('.notebook-rich-content')`);
  await script(`document.querySelector('.notebook-rich-content').focus(); return true;`);
  await until(String.raw`return !document.querySelector('[aria-label="Remove desktop-report.docx"]')`);
  await delay(200);
  assert.equal(await script(`return !!document.activeElement.closest('.notebook-rich-editor')`), true, 'Delayed send acknowledgement must not steal note focus');
  await script(`document.querySelector('.session-notebook [aria-label="Close notebook"]').click(); return true;`);
  sendDelay = 0;
  assert.equal(sentPayloads.at(-1).media[0].mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(Buffer.from(sentPayloads.at(-1).media[0].dataUrl.split(',')[1], 'base64').toString(), 'fixture payload');
  await chooseFile('input[type=file]', 'desktop-report.docx', 'application/octet-stream');
  await until(String.raw`return !!document.querySelector('[aria-label="Remove desktop-report.docx"]')`);
  await script(String.raw`document.querySelector('[aria-label="Remove desktop-report.docx"]').click(); return true;`);
  messages.push({ id: 'video', sessionKey: key, role: 'assistant', text: 'Video fixture.', status: 'sent', createdAt: now + 3000, media: [
    { type: 'file', name: 'clip.mp4', mimeType: 'video/mp4', url: '/api/artifacts/abcdef0123456789', size: 32 },
    { type: 'file', name: 'remote.mp4', mimeType: 'video/mp4', url: 'https://example.invalid/remote.mp4', size: 32 },
  ] });
  emit();
  await until(String.raw`return !!document.querySelector('[aria-label="Load video player for clip.mp4"]')`);
  assert.equal(await script('return document.querySelectorAll("video").length'), 0, 'Do not eagerly load video players');
  assert.equal(await script(String.raw`return !!document.querySelector('[aria-label="Load video player for remote.mp4"]')`), false);
  await script(String.raw`document.querySelector('[aria-label="Load video player for clip.mp4"]').click(); return true;`);
  await until('return !!document.querySelector("video")');
  assert.equal(await script('return document.querySelector("video").controls'), true);
  await script('document.querySelector("video").dispatchEvent(new Event("error")); return true;');
  await until('return document.body.innerText.includes("This video codec is not supported")');
  assert.equal(await script(String.raw`return !!document.querySelector('a[download="clip.mp4"]')`), true);
  await request(`/session/${id}/window/rect`, 'POST', { width: 390, height: 844 });
  await until('return !!document.querySelector(".mobile-list-shell")');
  await script(`const card = [...document.querySelectorAll('button')].find(node => node.textContent.includes('Live regression')); if (!card) throw new Error('Missing mobile session card'); card.click(); return true;`);
  await until(String.raw`return !!document.querySelector('input[type=file][accept="image/*"]')`);
  await script(`document.querySelector('[aria-label="Back to sessions"]').click(); return true;`);
  await until('return !!document.querySelector(".mobile-list-shell")');
  await script(`const card = [...document.querySelectorAll('button')].find(node => node.textContent.includes('Other session')); if (!card) throw new Error('Missing other mobile session card'); card.click(); return true;`);
  await until('return document.body.innerText.includes("Other session response.")');
  await script(`document.querySelector('[aria-label="Back to sessions"]').click(); return true;`);
  await until('return !!document.querySelector(".mobile-list-shell")');
  await script(`const card = [...document.querySelectorAll('button')].find(node => node.textContent.includes('Live regression')); if (!card) throw new Error('Missing mobile session card'); card.click(); return true;`);
  await until('return document.body.innerText.includes("Reply after stream recovery.")');
  assert.equal(await script('return Object.keys(localStorage).some(key => key.includes(".messages."))'), false, 'Navigation recovery must not depend on a successful message-cache write');
  assert.equal(await script(String.raw`return !!document.querySelector('[aria-label="Attach image"]') && !!document.querySelector('[aria-label="Attach file"]')`), true);
  await chooseFile('input[type=file]:not([accept="image/*"])', 'mobile-audio.mp3', 'audio/mp3');
  await until(String.raw`return !!document.querySelector('[aria-label="Remove mobile-audio.mp3"]')`);
  await script('document.querySelector(".mobile-chat-composer").requestSubmit(); return true;');
  await until(String.raw`return !document.querySelector('[aria-label="Remove mobile-audio.mp3"]')`);
  assert.equal(sentPayloads.at(-1).media[0].mimeType, 'audio/mpeg');
  await chooseFile('input[type=file][accept="image/*"]', 'mobile-photo.png', 'image/png');
  await until(String.raw`return !!document.querySelector('[aria-label="Remove mobile-photo.png"]')`);
  assert.deepEqual(await script('return window.fixtureErrors'), []);
  assert.equal(await script('return document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile composer must not overflow horizontally');
  messages.push({ id: 'source-reference', sessionKey: key, role: 'assistant', text: `[Complete review](${sourcePath})`, status: 'sent', createdAt: now + 4000,
    media: [{ type: 'file', name: 'review.md', mimeType: 'application/json', url: sourceUrl, sourceReference: { path: sourcePath, line: 1, href: sourcePath } }] });
  emit();
  await until('return !!document.querySelector(".source-reference-unavailable")');
  assert.equal(await script('return document.querySelector(".source-reference-unavailable").textContent.includes("cached preview")'), false);
  assert.equal(await script('return !!document.querySelector(".source-reference-details")'), false);
  assert.equal(await script('return !!document.querySelector(".source-reference-unavailable a")'), false, 'Do not navigate local paths to the Hub origin');
  assert.equal(await script('return document.documentElement.scrollWidth <= innerWidth'), true);
  await script('const card = document.querySelector(".source-reference-unavailable"); [...card.querySelectorAll("button")].find(b => b.textContent === "Details").click(); return true;');
  await until('return document.querySelector(".source-reference-details")?.textContent.includes("download attachment")');
  assert.equal(await script('return document.documentElement.scrollWidth <= innerWidth'), true);
  sourceStatus = 200;
  await script('const card = document.querySelector(".source-reference-unavailable"); [...card.querySelectorAll("button")].find(b => b.textContent === "Retry").click(); return true;');
  await until('return document.querySelector(".source-inline-card .markdown-file")?.textContent.includes("Review fixture")');
  const previewFont = await script('return parseFloat(getComputedStyle(document.querySelector(".source-inline-card .md-paragraph")).fontSize)');
  await script('document.documentElement.style.setProperty("--agentopsdeck-chat-font-scale", "1.2"); return true;');
  assert.ok(await script(`return Math.abs(parseFloat(getComputedStyle(document.querySelector('.source-inline-card .md-paragraph')).fontSize) / ${previewFont} - 1.2) < .02;`), 'Inline Markdown preview follows chat font preferences');
  await script('document.documentElement.style.removeProperty("--agentopsdeck-chat-font-scale"); return true;');
  const readsAfterRetry = sourceReads;
  emit(); await delay(1800);
  assert.equal(sourceReads, readsAfterRetry, 'Message refresh must reuse the successful preview');
  await request(`/session/${id}/window/rect`, 'POST', { width: 1280, height: 900 });
  await request(`/session/${id}/url`, 'POST', { url: `http://127.0.0.1:${port}/#/session/${encodeURIComponent(key)}` });
  await until('return document.querySelector(".source-inline-card .markdown-file")?.textContent.includes("Review fixture")');
  assert.equal(sourceReads, readsAfterRetry, 'Reload must reuse scoped tab cache');
  sourceStatus = 403;
  await script('[...document.querySelector(".source-inline-card").querySelectorAll("button")].find(b => b.textContent === "Refresh source").click(); return true;');
  await until('return !!document.querySelector(".source-reference-unavailable")');
  assert.equal(await script('return !!document.querySelector(".source-inline-code, .source-inline-card .markdown-file")'), false, 'Denied reads must clear previously cached code and Markdown');
  assert.equal(await script('return document.querySelector(".source-reference-unavailable").textContent.includes("cached preview")'), false);
  // Multi-pane regression uses the real card drag handlers, not storage injection.
  sourceStatus = 404; sourceApprovalAvailable = true;
  await script(`const c = document.querySelector('.source-reference-unavailable'); [...c.querySelectorAll('button')].find(b => b.textContent === 'Retry').click(); return true;`);
  await until(`return [...document.querySelectorAll('.source-reference-unavailable button')].some(b => b.textContent === 'Allow preview')`);
  await script(`[...document.querySelectorAll('.source-reference-unavailable button')].find(b => b.textContent === 'Allow preview').click(); return true;`);
  await until(`return !!document.querySelector('dialog[open]')`);
  assert.equal(sourceTemporary, false, 'Merely opening the confirmation cannot grant file access');
  await script(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Allow preview').click(); return true;`);
  await until(`return !!document.querySelector('.source-inline-card .markdown-file') && [...document.querySelectorAll('.source-inline-card button')].some(b => b.textContent === 'Revoke access')`);
  await script(`[...document.querySelectorAll('.source-inline-card button')].find(b => b.textContent === 'Revoke access').click(); return true;`);
  await until(`return !!document.querySelector('dialog[open]')`);
  await script(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Revoke access').click(); return true;`);
  await until(`return !!document.querySelector('.source-reference-unavailable') && !document.querySelector('.source-inline-card .markdown-file')`);
  await request(`/session/${id}/window/rect`, 'POST', { width: 1500, height: 1000 });
  await until(`return document.querySelector('.session-workspace-surface').getBoundingClientRect().width > 700`);
  await delay(300); // ResizeObserver must publish the new docking geometry before drag.
  await script(`const card = document.querySelector('[data-session-card="${otherKey}"]').closest('[draggable=true]'); const dataTransfer = new DataTransfer(); card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer })); const surface = document.querySelector('.session-workspace-surface'), r = surface.getBoundingClientRect(); for (const type of ['dragover', 'drop']) surface.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: r.right - 5, clientY: r.top + r.height / 2 })); return true;`);
  await until(`return document.querySelectorAll('[data-workspace-pane]').length === 2 && !!document.querySelector('[aria-label="Pane tools"]')`);
  assert.equal(await script(`return document.querySelector('[role=toolbar][aria-label="Chat layout"]').closest('#workspace-layout-tools') !== null`), true, 'Layout controls do not occupy a transcript row');
  assert.equal(await script(`return [...document.querySelectorAll('[data-desktop-chat-toolbar]')].every(h => h.getBoundingClientRect().height < 115)`), true, 'Narrow pane header remains two rows');
  await script(`document.querySelector('[data-session-pane="${key}"] [aria-label="Pane tools"]').click(); return true;`);
  await until(`return !!document.querySelector('.pane-tools-content:popover-open [aria-label="Session model"]')`);
  assert.equal(await script(`const p = document.querySelector('.pane-tools-content:popover-open'), r = p.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;`), true, 'Pane tools stay within viewport');
  await script(`document.querySelector('.pane-tools-content:popover-open').hidePopover(); document.activeElement.blur(); return true;`);
  if (await script(`return matchMedia('(hover: hover) and (pointer: fine)').matches`)) {
    await until(`return [...document.querySelectorAll('.desktop-message-form')].every(f => getComputedStyle(f).visibility === 'hidden')`);
    await script(`document.querySelector('[data-session-pane="${key}"] .composer-reveal').focus(); return true;`);
    await until(`return getComputedStyle(document.querySelector('[data-session-pane="${key}"] .desktop-message-form')).visibility === 'visible'`);
    await script(`document.querySelector('[data-session-pane="${key}"] textarea').focus(); return true;`);
    assert.equal(await script(`return getComputedStyle(document.querySelector('[data-session-pane="${otherKey}"] .desktop-message-form')).visibility`), 'hidden', 'Focusing one composer does not reveal another');
    await script(`document.activeElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })); return true;`);
    emit(); await delay(500);
    assert.equal(await script(`return document.activeElement.closest('[data-session-pane]')?.dataset.sessionPane`), key, 'Refresh cannot steal composer/IME focus');
    await script(`document.activeElement.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })); document.activeElement.blur(); return true;`);
  }
  messages = Array.from({ length: 8 }, (_, i) => ({ id: `circle-tool-${i}`, sessionKey: key, role: 'tool', toolName: 'exec', toolCallId: `circle-call-${i}`, toolPhase: 'result', text: `Circle fixture ${i}`, status: 'sent', createdAt: now + i }));
  emit();
  await until(`return document.querySelectorAll('.desktop-tool-chip--compact').length >= 2`);
  assert.equal(await script(`const compact = document.querySelector('.desktop-tool-chip--compact'), full = document.querySelector('.desktop-tool-chip:not(.desktop-tool-chip--compact)'), c = getComputedStyle(compact.querySelector('.desktop-tool-step')), f = getComputedStyle(full.querySelector('.desktop-tool-step')); return compact.children.length === 1 && ['borderRadius','width','height','backgroundColor','color','boxShadow'].every(k => c[k] === f[k]) && getComputedStyle(compact).backgroundColor === 'rgba(0, 0, 0, 0)';`), true, 'Compact tool is precisely the original circle with no outer background or labels');
  messages = [{ id: 'long-left', sessionKey: key, role: 'assistant', text: Array.from({ length: 80 }, (_, i) => `Left paragraph ${i}`).join('\n\n'), status: 'sent', createdAt: now + 5000 }];
  otherMessages = [{ ...otherMessages[0], text: Array.from({ length: 80 }, (_, i) => `Right paragraph ${i}`).join('\n\n') }];
  emit(); emit(otherKey);
  await until(`return document.querySelector('[data-session-pane="${key}"]').textContent.includes('Left paragraph 79') && document.querySelector('[data-session-pane="${otherKey}"]').textContent.includes('Right paragraph 79')`);
  const gap = sessionKey => `const e = document.querySelector('[data-session-pane="${sessionKey}"] .message-selection-surface'); return e.scrollHeight - e.clientHeight - e.scrollTop < 4;`;
  await until(gap(key)); await until(gap(otherKey));
  const finePointer = await script(`return matchMedia('(hover: hover) and (pointer: fine)').matches`);
  if (finePointer) {
    await script(`window.closedTranscriptHeight = document.querySelector('[data-session-pane="${key}"] .message-selection-surface').clientHeight; document.querySelector('[data-session-pane="${key}"] .composer-reveal').focus(); return true;`);
    await until(gap(key));
    assert.equal(await script(`const p = document.querySelector('[data-session-pane="${key}"]'), m = p.querySelector('.message-selection-surface'), f = p.querySelector('.desktop-message-form'); return m.clientHeight < window.closedTranscriptHeight - 70 && m.getBoundingClientRect().bottom <= f.getBoundingClientRect().top;`), true, 'Tall composer reserves space and keeps latest message above the form');
    await script(`document.activeElement.blur(); return true;`);
    await until(`return document.querySelector('[data-session-pane="${key}"] .message-selection-surface').clientHeight === window.closedTranscriptHeight`);
    const point = await script(`const r = document.querySelector('[data-session-pane="${key}"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * .88) };`);
    const movePointer = (x, y) => request(`/session/${id}/actions`, 'POST', { actions: [{ type: 'pointer', id: 'composer-mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 0, origin: 'viewport', x, y }] }] });
    await movePointer(point.x, point.y);
    await until(`return document.querySelector('[data-session-pane="${key}"] .message-selection-surface').clientHeight < window.closedTranscriptHeight - 70`);
    await until(gap(key));
    await delay(250);
    assert.equal(await script(`return getComputedStyle(document.querySelector('[data-session-pane="${key}"] .desktop-message-form')).visibility`), 'visible', 'Growing dock retains hover without reveal/hide oscillation');
    const messagePoint = await script(`const r = document.querySelector('[data-session-pane="${key}"] .message-selection-surface').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
    await movePointer(messagePoint.x, messagePoint.y);
    await script(`document.activeElement.blur(); const p = document.querySelector('[data-session-pane="${key}"] .message-selection-surface p'); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); return true;`);
    await delay(250);
    assert.equal(await script(`return !!getSelection().toString() && getComputedStyle(document.querySelector('[data-session-pane="${key}"] .desktop-message-form')).visibility === 'visible'`), true, 'Selecting a message anywhere in the pane keeps the revealed composer stable');
    await script('getSelection().removeAllRanges(); return true;');
    await movePointer(1, 1);
    await until(`return document.querySelector('[data-session-pane="${key}"] .message-selection-surface').clientHeight === window.closedTranscriptHeight`);
  }
  await script(`document.querySelector('[data-session-pane="${key}"] [aria-label="Session notebook"]').click(); return true;`);
  await until(`return !!document.querySelector('.session-notebook')`);
  await script(`document.querySelector('[data-session-pane="${key}"] [aria-label="Focus message"]').click(); return true;`);
  await until(`return document.activeElement === document.querySelector('.message-focus-panel')`);
  assert.equal(await script(`const n = document.querySelector('.session-notebook'), r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + 20, r.y + 20));`), true, 'Notebooks remain above and interactive outside Focus');
  assert.equal(await script(`return document.querySelector('.message-focus-content').textContent.includes('Left paragraph 79') && !document.querySelector('.message-focus-panel .queue-message-controls')`), true, 'Focus shows the full message without queue commands');
  await script(`const p = document.querySelector('.message-focus-content p'); window.focusReadingNode = p; const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); return true;`);
  messages[0] = { ...messages[0], text: messages[0].text + '\n\nStreaming after Focus opened' }; emit();
  await delay(500);
  assert.deepEqual(await script(`return { selected: !!getSelection().toString(), sameNode: window.focusReadingNode === document.querySelector('.message-focus-content p'), unchanged: !document.querySelector('.message-focus-content').textContent.includes('Streaming after Focus opened') };`), { selected: true, sameNode: true, unchanged: true }, 'Streaming does not replace the selected reading snapshot');
  await script(`getSelection().removeAllRanges(); return true;`);
  const copyElement = await request(`/session/${id}/element`, 'POST', { using: 'css selector', value: '.message-focus-panel [aria-label="Copy message"]' });
  await request(`/session/${id}/element/${copyElement['element-6066-11e4-a52e-4f735466cecf']}/click`, 'POST', {});
  await until(`return document.querySelector('.message-focus-panel [role=status]').textContent === 'Copied'`);
  await script(`document.querySelector('[data-message-focus]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true;`);
  await until(`return !document.querySelector('[data-message-focus]')`);
  await script(`document.querySelector('.session-notebook [aria-label="Close notebook"]').click(); return true;`);
  await script(`const e = document.querySelector('[data-session-pane="${key}"] .message-selection-surface'); e.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -240 })); e.scrollTop -= 240; e.dispatchEvent(new Event('scroll')); window.pausedScroll = e.scrollTop; return true;`);
  if (finePointer) {
    await script(`document.querySelector('[data-session-pane="${key}"] .composer-reveal').focus(); return true;`);
    await delay(200);
    assert.equal(await script(`return Math.abs(document.querySelector('[data-session-pane="${key}"] .message-selection-surface').scrollTop - window.pausedScroll) < 3`), true, 'Composer opening does not rearm paused transcript follow');
    await script(`document.activeElement.blur(); return true;`);
  }
  messages.push({ ...messages[0], id: 'left-tail', text: 'Left tail added', createdAt: now + 6000 });
  otherMessages.push({ ...otherMessages[0], id: 'right-tail', text: 'Right tail added', createdAt: now + 6000 });
  emit(); emit(otherKey);
  await until(`return document.querySelector('[data-session-pane="${otherKey}"]').textContent.includes('Right tail added')`);
  await until(gap(otherKey));
  assert.equal(await script(`return Math.abs(document.querySelector('[data-session-pane="${key}"] .message-selection-surface').scrollTop - window.pausedScroll) < 3;`), true, 'Paused left pane does not follow right-pane growth');
  await script(`document.querySelector('[data-session-pane="${key}"] [aria-label="Jump to latest messages"]').click(); return true;`);
  await until(gap(key));
  session.status = 'running'; session.hasActiveRun = true; session.runtime = { ...session.runtime, phase: 'running', sync: 'current', reason: 'Pane run regression' }; emit();
  await until(`return document.querySelector('[data-session-pane="${key}"]')?.textContent.includes('Pane run regression')`);
  session.status = 'idle'; session.hasActiveRun = false; session.runtime = { ...session.runtime, phase: 'completed' }; emit();
  await until(`return document.querySelector('[data-session-pane="${key}"]').closest('[data-workspace-pane]').dataset.completed === 'true'`);
  assert.equal(await script(`return document.querySelector('[data-session-pane="${otherKey}"]').closest('[data-workspace-pane]').dataset.completed`), 'false', 'Historical Done pane must not flash');
  await script(`document.querySelector('[aria-label="Minimize navigation"]').click(); return true;`);
  await until(`return !!document.querySelector('[aria-label="Expand navigation"]')`);
  await script(`document.querySelector('[aria-label="Expand navigation"]').click(); return true;`);
  // Layout updates preserve identity and capture edited geometry, not just a name.
  await script(`document.querySelector('[aria-label="Resize panes"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); document.querySelector('[aria-label="Saved layouts"]').click(); [...document.querySelectorAll('.saved-layouts-menu button')].find(b => b.textContent.includes('Save current layout')).click(); return true;`);
  await until(`return !!document.querySelector('dialog[open] input')`);
  await script(`const e = document.querySelector('dialog[open] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'Regression layout'); e.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await script(`document.querySelector('dialog[open] form').requestSubmit(); return true;`);
  await until(`return !document.querySelector('dialog[open]')`);
  await script(`document.querySelector('[aria-label="Layout presets"]').click(); [...document.querySelectorAll('.session-workspace-preset-menu button')].find(b => b.textContent.includes('Equalize panes')).click(); return true;`);
  await until(`const p = [...document.querySelectorAll('[data-workspace-pane]')].map(e => e.getBoundingClientRect().width); return Math.abs(p[0] - p[1]) < 2;`);
  await script(`document.querySelector('[aria-label="Saved layouts"]').click(); document.querySelector('[aria-label="Update with current layout Regression layout"]').click(); return true;`);
  await until(`return !!document.querySelector('dialog[open]')`);
  await script(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === 'Update with current layout').click(); return true;`);
  await until(`return !document.querySelector('dialog[open]')`);
  await script(`document.querySelector('[aria-label="Resize panes"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); document.querySelector('[aria-label="Saved layouts"]').click(); document.querySelector('.saved-layout-row > button').click(); return true;`);
  await until(`const p = [...document.querySelectorAll('[data-workspace-pane]')].map(e => e.getBoundingClientRect().width); return Math.abs(p[0] - p[1]) < 2;`);
  await script(`document.activeElement?.blur(); document.querySelector('[aria-label="Collapse session list"]').click(); return true;`);
  await until(`return document.querySelector('#desktop-session-list').inert`);
  await script(`document.querySelector('[data-rail-reveal]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })); return true;`);
  await until(`return document.querySelector('#desktop-session-list').dataset.hoverRevealed === 'true'`);
  await script(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
  await until(`return document.querySelector('#desktop-session-list').inert`);
  await script(`document.querySelector('[aria-label="Expand session list"]').click(); return true;`);
  messages.push({ id: 'queue-inline', sessionKey: key, role: 'user', text: 'Original queued text', status: 'queued', queueDisposition: 'waiting', queueVersion: 'v1', createdAt: now + 7000 }); emit();
  await until(`return !!document.querySelector('[data-queued-message-id="queue-inline"]')`);
  await script(`[...document.querySelectorAll('[data-queued-message-id="queue-inline"] button')].find(b => b.textContent === 'Edit').click(); return true;`);
  await until(`return !!document.querySelector('textarea[aria-label="Edit queued message"]')`);
  assert.equal(await script(`const e = document.querySelector('textarea[aria-label="Edit queued message"]'); return e.value === 'Original queued text' && !document.querySelector('dialog[open]') && !e.closest('[data-message-search-id]').querySelector('.markdown-body');`), true, 'Queue editing replaces the original message body in place');
  await script(`[...document.querySelectorAll('.queue-edit-footer button')].find(b => b.textContent === 'Keep original').click(); return true;`);
  await until(`return !document.querySelector('textarea[aria-label="Edit queued message"]')`);
  await script(`location.hash = '#/tab/sessions'; return true;`);
  await until(`return document.querySelectorAll('[data-workspace-pane]').length === 0`);
  await delay(300);
  await script(`const card = document.querySelector('[data-session-card="${key}"]').closest('[draggable=true]'), dataTransfer = new DataTransfer(); card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer })); const surface = document.querySelector('.session-workspace-surface'), r = surface.getBoundingClientRect(); for (const type of ['dragover', 'drop']) surface.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 5, clientY: r.top + r.height / 2 })); return true;`);
  await until(`return document.querySelectorAll('[data-workspace-pane]').length === 1 && !!document.querySelector('.session-workspace-vacancy')`);
  assert.equal(await script(`const p = document.querySelector('[data-workspace-pane]').getBoundingClientRect(), v = document.querySelector('.session-workspace-vacancy').getBoundingClientRect(), s = document.querySelector('.session-workspace-surface').getBoundingClientRect(); return p.x < v.x && Math.abs(p.width / s.width - .5) < .02 && Math.abs(v.width - p.width) < 2;`), true, 'First card can occupy only the left half of an empty workspace');
  console.log(JSON.stringify({ previewFontScaling: true, emptyWorkspaceHalfDrop: true }));
  // Build the full 6+2 workspace using sidebar drops, then save/restore it.
  await request(`/session/${id}/window/rect`, 'POST', { width: 2400, height: 1500 });
  extraSessions.push(...Array.from({ length: 6 }, (_, i) => ({ ...otherSession, sessionKey: `codex:extra-${i}`, title: `Extra ${i}` })));
  emit();
  await until(`return !!document.querySelector('[data-session-card="codex:extra-5"]')`);
  async function dropCard(sessionKey, targetExpression) {
    await script(`const card = document.querySelector('[data-session-card="${sessionKey}"]').closest('[draggable=true]'), dataTransfer = new DataTransfer(); card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer })); const surface = document.querySelector('.session-workspace-surface'); const { x, y } = (() => { ${targetExpression} })(); for (const type of ['dragover', 'drop']) surface.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y })); return true;`);
  }
  await dropCard(otherKey, `const r = document.querySelector('.session-workspace-vacancy').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await until(`return document.querySelectorAll('[data-workspace-pane]').length === 2`);
  for (let i = 0; i < 4; i++) {
    await dropCard(`codex:extra-${i}`, `const r = document.querySelector('[data-workspace-pane]').getBoundingClientRect(); return { x: r.right - 5, y: r.y + r.height / 2 };`);
    await until(`return document.querySelectorAll('[data-workspace-pane]').length === ${i + 3}`);
    await script(`document.querySelector('[aria-label="Layout presets"]').click(); document.querySelector('button[aria-label="Grid layout"]').click(); return true;`);
  }
  await until(`const panes = [...document.querySelectorAll('[data-workspace-pane]')].map(e => e.getBoundingClientRect()); return panes.length === 6 && panes.every(p => p.width >= 300 && p.height >= 360) && new Set(panes.map(p => Math.round(p.y))).size === 2 && new Set(panes.map(p => Math.round(p.x))).size === 3;`);
  for (let i = 4; i < 6; i++) {
    await dropCard(`codex:extra-${i}`, `const r = document.querySelector('[data-workspace-pane]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    await until(`return document.querySelectorAll('[data-workspace-pane]').length === ${i + 3}`);
  }
  assert.equal(await script(`return document.querySelectorAll('[data-workspace-pane][data-floating=true]').length`), 2);
  await script(`document.querySelector('[aria-label="Saved layouts"]').click(); document.querySelector('.saved-layout-new').click(); return true;`);
  await until(`return !!document.querySelector('dialog[open] input')`);
  await script(`const e = document.querySelector('dialog[open] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'Six plus two'); e.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await script(`document.querySelector('dialog[open] form').requestSubmit(); return true;`);
  await until(`return !document.querySelector('dialog[open]')`);
  await script(`location.hash = '#/tab/sessions'; return true;`);
  await until(`return document.querySelectorAll('[data-workspace-pane]').length === 0`);
  await script(`document.querySelector('[aria-label="Saved layouts"]').click(); [...document.querySelectorAll('.saved-layout-row > button')].find(b => b.textContent.includes('Six plus two')).click(); return true;`);
  await until(`return document.querySelectorAll('[data-workspace-pane]').length === 8 && document.querySelectorAll('[data-workspace-pane][data-floating=true]').length === 2`);
  await script(`window.workspaceHosts = [...document.querySelectorAll('[data-workspace-pane]')]; document.querySelector('[aria-label="Layout presets"]').click(); document.querySelector('button[aria-label="Grid layout"]').click(); return true;`);
  assert.equal(await script(`return window.workspaceHosts.every(e => e.isConnected)`), true, 'Rearranging eight sessions retains their existing editor hosts');
  await request(`/session/${id}/window/rect`, 'POST', { width: 2400, height: 1000 });
  await until(`return document.querySelectorAll('[data-workspace-pane][data-floating=false][data-dense=true]').length === 6`);
  await script(`const p = document.querySelector('[data-session-pane="${key}"]'); window.smallTranscriptHeight = p.querySelector('.message-selection-surface').clientHeight; p.querySelector('.composer-reveal').focus(); return true;`);
  await until(`return getComputedStyle(document.querySelector('[data-session-pane="${key}"] .desktop-message-form')).visibility === 'visible'`);
  assert.equal(await script(`const p = document.querySelector('[data-session-pane="${key}"]'); return getComputedStyle(p.querySelector('.desktop-message-form')).position === 'absolute' && p.querySelector('.message-selection-surface').clientHeight === window.smallTranscriptHeight`), true, 'Short grid panes keep the compact overlay instead of consuming the transcript');
  await script(`document.activeElement.blur(); return true;`);
  console.log(JSON.stringify({ sixDockedTwoFloating: true, threeByTwoGrid: true, eightPaneSaveRestore: true, tallComposerReservesSpace: finePointer, pausedComposerScrollPreserved: finePointer }));
  assert.deepEqual(await script('return window.fixtureErrors ?? []'), []);
  console.log(JSON.stringify({ selectionStable: true, newMessagesDuringSelection: true, releasedSelectionCatchesUp: true, statusOnlyRefresh: true, syncErrorVisible: true, disconnectVisible: true, terminalFailureRecovered: true, sessionSwitchReusesStream: true, firstPageSwitchbackReuse: true, recoveryReceivesMessages: true, desktopFileReselect: true, attachmentPayloads: true, mobilePhotoAndFile: true, lazyVideoAndDownloadFallback: true, sourceUnavailableCompact: true, sourceRetryAndCache: true, sourceApprovalAndRevoke: true, sourceRevocationClearsCache: true, groupMenuTopmost: true, notebookTaskAlignment: true, notebookFocusAndConflict: true, paneDragAndOverflow: true, paneIndependentAutoscroll: true, paneComposerFocus: true, paneCompletion: true, savedLayoutUpdateAndEqualize: true, railHover: true, inlineQueueEdit: true, noUnhandledRejections: true }));
} catch (error) {
  console.error(formatBoundedBrowserDiagnostic(error, 'codex-live-ui'));
  throw error;
} finally {
  let teardownError;
  if (harness) {
    try {
      await harness.close();
    } catch (err) {
      teardownError = err;
      console.error(formatBoundedBrowserDiagnostic(err, 'codex-live-ui-teardown'));
    }
  }
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (teardownError) throw teardownError;
}

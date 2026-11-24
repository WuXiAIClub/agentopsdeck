// Opt-in interoperability probe against the real upstream editor. Sends synthetic content only.
// Not part of offline regression, and never opens a AgentOpsDeck Hub, cookie, or private document.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { exportDrawio } from '../src/lib/workspace-drawio.ts';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
if (process.env.AOD_TEST_DRAWIO_UPSTREAM !== '1') throw Error('Set AOD_TEST_DRAWIO_UPSTREAM=1 to run the synthetic public-editor probe');
const id = randomUUID(), child = randomUUID();
const xml = exportDrawio({ format: 'agentopsdeck-drawing', version: 1, title: 'Synthetic interoperability check',
  nodes: [{ id, x: 32, y: 32, width: 200, height: 100, text: 'Synthetic root', color: '#dbeafe' },
    { id: child, x: 300, y: 64, width: 160, height: 64, text: 'Synthetic child', color: '#123456' }],
  edges: [{ id: randomUUID(), from: id, to: child }] });
const browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  const shell = 'http://127.0.0.1:19287';
  await context.route(`${shell}/**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic draw.io probe</title><body style="margin:0"></body>' }));
  await page.goto(shell);
  await page.evaluate(xml => {
    const editorOrigin = 'https://embed.diagrams.net';
    const frame = document.createElement('iframe'); frame.style.cssText = 'width:100vw;height:100vh;border:0';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.referrerPolicy = 'no-referrer';
    window.probeEvents = [];
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.origin !== editorOrigin || typeof event.data !== 'string') return;
      let data; try { data = JSON.parse(event.data); } catch { return; }
      window.probeEvents.push(data);
      if (data.event === 'init') frame.contentWindow.postMessage(JSON.stringify({ action: 'load', xml, autosave: 1 }), editorOrigin);
    });
    frame.src = `${editorOrigin}/?embed=1&proto=json&spin=1&noExitBtn=1&offline=1&lang=en`;
    document.body.append(frame);
  }, xml);
  const editor = page.frameLocator('iframe');
  await editor.getByText('Synthetic root', { exact: true }).first().waitFor({ timeout: 60000 });
  await editor.getByText('Synthetic root', { exact: true }).first().dblclick();
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('Edited synthetic root'); await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.probeEvents.some(e => e.event === 'autosave' && e.xml?.includes('Edited synthetic root')));
  if (process.env.AOD_TEST_DRAWIO_SAVE === '1') {
    // Exercise native embedded Save (not a synthetic postMessage). Keyboard uses the same editor action.
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForFunction(() => window.probeEvents.some(e => e.event === 'save' && e.xml?.includes('Edited synthetic root')));
  }
  // Always inspect autosave XML; the optional branch above additionally verifies native Save.
  // Neither probe is acceptance of a deployed AgentOpsDeck/self-hosted editor combination.
  const result = await page.evaluate(() => {
    const saved = window.probeEvents.findLast(e => e.event === 'autosave' && e.xml?.includes('Edited synthetic root'));
    const doc = new DOMParser().parseFromString(saved.xml, 'application/xml');
    const cell = doc.querySelector('mxCell[vertex="1"]');
    return { eventNames: window.probeEvents.map(e => e.event), root: doc.documentElement.tagName,
      vertices: doc.querySelectorAll('mxCell[vertex="1"]').length, edges: doc.querySelectorAll('mxCell[edge="1"]').length, label: cell?.getAttribute('value'),
      style: cell?.getAttribute('style'), geometry: cell?.querySelector('mxGeometry')?.outerHTML,
      nativeXML: saved.xml };
  });
  assert.equal(result.vertices, 2); assert.equal(result.edges, 1); assert.equal(result.label, 'Edited synthetic root');
  await page.screenshot({ path: '/tmp/agentopsdeck-233-c2b-upstream-drawio.png' });
  // The returned sample is synthetic and helps verify exactly which native attributes must be preserved.
  console.log(JSON.stringify({ status: 'PASS', actualUpstreamEditor: true, nativeSaveVerified: process.env.AOD_TEST_DRAWIO_SAVE === '1', ...result }));
} finally { await browser.close(); }

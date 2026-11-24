#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const distDir = resolve(root, 'apps/web/dist');
const assetsDir = resolve(distDir, 'assets');
if (!existsSync(assetsDir)) {
  console.error('Missing apps/web/dist/assets. Run `pnpm --filter @agentopsdeck/web build` first.');
  process.exit(1);
}
const cssAsset = readdirSync(assetsDir).find((name) => name.endsWith('.css'));
if (!cssAsset) {
  console.error('No built CSS asset found in apps/web/dist/assets.');
  process.exit(1);
}

const proofDir = resolve(root, 'tmp/mobile-overflow-proof');
rmSync(proofDir, { recursive: true, force: true });
mkdirSync(proofDir, { recursive: true });
const cssText = readFileSync(resolve(assetsDir, cssAsset), 'utf8');
const longToken = 'LONGTOKEN_'.repeat(80);
const pills = Array.from({ length: 18 }, (_, i) => `<button class="mobile-tool-pill mobile-tool-pill--generic"><span>${i + 1}</span><strong>${longToken}</strong><em>9999ms</em></button>`).join('');
const rows = Array.from({ length: 4 }, () => `<tr><td>${longToken}</td><td>${longToken}</td><td>${longToken}</td></tr>`).join('');
const requestedWidths = process.argv.find((arg) => arg.startsWith('--widths='))
  ?.slice('--widths='.length)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const widthsToVerify = requestedWidths?.length ? requestedWidths : [360, 390, 430, 1280];

function escapeSrcdoc(html) {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function innerFixture() {
  const tabletToolNodes = Array.from({ length: 16 }, (_, index) => `<span class="desktop-tool-node" role="listitem"><button type="button" class="desktop-tool-chip desktop-tool-chip--generic"><span class="desktop-tool-step">${index + 1}</span><span class="desktop-tool-label">${longToken}</span><em class="desktop-tool-agent-hint">agent</em><strong>99k</strong></button><span class="desktop-tool-link desktop-tool-link--generic desktop-tool-link--timed"><span>999ms</span></span></span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${cssText}</style>
<style>html,body,#root{margin:0;min-height:100%;}.proof-wide-media{width:900px;height:80px;background:#ddd;} .tablet-proof-shell{display:none;} @media (min-width:700px){.chat-shell{display:none}.tablet-proof-shell{display:grid}}</style>
</head><body><div id="root"><main class="chat-shell">
<header class="chat-header"><button>‹</button><div class="chat-title"><h1>${longToken}</h1><p>${longToken}</p></div></header>
<section class="messages">
  <article class="message assistant"><span>assistant</span><div class="markdown-body text-[0.84rem] leading-5 min-w-0 break-words max-w-full text-slate-800">
    <p>https://example.com/${longToken}/${longToken}</p>
    <p><code class="rounded-md border px-1.5 py-0.5 text-[0.86em] font-semibold break-words break-all whitespace-pre-wrap">${longToken}</code></p>
    <pre class="mb-3 overflow-x-auto rounded-2xl last:mb-0 max-w-full min-w-0"><code class="block overflow-x-auto whitespace-pre rounded-2xl border p-3 text-xs leading-5 shadow-inner max-w-full min-w-0">${longToken}\n${longToken}</code></pre>
    <div class="mb-3 overflow-x-auto rounded-2xl border border-slate-200 last:mb-0 max-w-full min-w-0"><table class="min-w-full text-left text-xs"><tbody>${rows}</tbody></table></div>
  </div><div class="message-media"><a><img class="proof-wide-media" alt="wide fixture" /></a></div><a class="file-chip">${longToken}</a></article>
  <article class="message user"><span>user</span><p>${longToken}</p></article>
  <details class="mobile-tool-output" open><summary><span>${longToken}</span></summary><pre>${longToken}\n${longToken}</pre></details>
  <div class="mobile-tool-strip"><div class="mobile-tool-strip-scroll">${pills}</div><pre class="mobile-tool-strip-detail">${longToken}\n${longToken}</pre></div>
  <details class="message internal-output compact-tool-output" open><summary><span>${longToken}</span><strong>tool</strong></summary><pre>${longToken}</pre></details>
  <details class="message archived-message assistant" open><summary><span>${longToken}</span><strong>more</strong></summary><p>${longToken}</p></details>
</section>
<div class="delivery-mode"><span>${longToken}</span><button>Web only</button><button class="active">Send</button></div>
<form class="composer"><button>🎙</button><textarea>${longToken}</textarea><button>↑</button></form>
</main><section class="tablet-proof-shell fixed inset-0 min-w-0 overflow-hidden bg-slate-950 text-slate-950 grid-cols-[56px_minmax(172px,216px)_minmax(0,1fr)] md:grid-cols-[60px_minmax(190px,228px)_minmax(0,1fr)] xl:grid-cols-[80px_minmax(270px,330px)_minmax(0,1fr)]" aria-label="Tablet shell proof">
  <aside class="relative z-10 flex min-h-0 flex-col items-center gap-3 border-r border-white/55 bg-white/35 px-1.5 py-4 md:gap-3 md:px-1.5 md:py-4 xl:gap-5 xl:px-3 xl:py-5"><button class="aod-blue-gradient grid h-10 w-10 place-items-center rounded-[1.15rem] text-base font-black text-white xl:h-12 xl:w-12">C</button></aside>
  <aside class="relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-white/60 bg-white/48"><div class="border-b border-white/60 px-3 pb-2.5 pt-3 xl:px-5 xl:pb-4 xl:pt-5"><div class="flex items-start justify-between gap-2 xl:gap-3"><div class="min-w-0"><h1 class="truncate text-base font-black leading-none tracking-[-0.05em] text-slate-950 xl:text-xl">Sessions</h1><p class="mt-1.5 text-[0.68rem] text-slate-500 xl:text-xs">99/999 sessions · now</p></div><button class="h-7 shrink-0 rounded-2xl px-2 text-[0.68rem] xl:h-8 xl:px-3 xl:text-xs">New</button></div><div class="relative mt-3 xl:mt-4"><input class="h-9 w-full rounded-2xl border-white/80 bg-white/60 pl-8 pr-8 text-xs shadow-none xl:h-10 xl:pl-10 xl:pr-9 xl:text-sm" value="${longToken}" /></div></div><div class="min-h-0 flex-1 overflow-auto p-2 xl:p-4"><article class="grid gap-1.5 overflow-hidden rounded-[1.45rem] border border-white/70 bg-white/64 p-2.5 xl:gap-2 xl:p-3"><strong class="truncate text-[0.8rem] xl:text-sm">${longToken}</strong><small>${longToken}</small></article></div></aside>
  <main class="relative z-10 min-h-0 min-w-0 overflow-hidden p-2 md:p-3 xl:p-5"><section class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/70 bg-white/64 md:rounded-[1.6rem] xl:rounded-[2rem]"><header class="tablet-proof-header shrink-0 border-b border-white/60 bg-white/55 px-3 py-2 md:px-4 xl:px-5 xl:py-3"><div class="flex min-w-0 flex-col gap-2 xl:flex-row xl:items-start xl:justify-between xl:gap-4"><div class="min-w-0 flex-1"><div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 xl:gap-x-3"><h2 class="truncate text-base font-black leading-none tracking-[-0.04em] text-slate-950 xl:text-xl">${longToken}</h2><div class="inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 rounded-2xl border border-white/75 bg-white/72 px-1.5 py-1 shadow-sm xl:flex-nowrap xl:rounded-full xl:px-2" data-proof-cluster="status"><span class="h-2 w-2 shrink-0 rounded-full bg-emerald-400"></span><span class="whitespace-nowrap text-[0.66rem] font-black uppercase tracking-[0.1em] text-slate-400">ctx</span><strong class="whitespace-nowrap font-mono text-[0.68rem] font-black text-slate-800">999k/999k</strong><span class="whitespace-nowrap text-[0.66rem] font-semibold text-slate-500">compact 999</span><span class="whitespace-nowrap text-[0.66rem] font-semibold text-slate-500">999 msgs</span></div></div><p class="mt-1.5 truncate text-xs font-semibold text-blue-700">Using · ${longToken}</p></div><div class="flex min-w-0 flex-wrap items-center justify-start gap-1.5 xl:shrink-0 xl:justify-end xl:gap-2" data-proof-cluster="actions"><button class="h-7 rounded-2xl px-2 text-[0.68rem] font-black xl:h-8 xl:px-3 xl:text-xs">Delete</button><button class="h-7 rounded-2xl px-2 text-[0.68rem] font-black xl:h-8 xl:px-3 xl:text-xs">Compact</button><div class="flex max-w-full items-center gap-1.5"><input class="h-8 w-28 rounded-2xl border-white/80 bg-white/70 pl-9 pr-8 text-xs shadow-none md:w-32 xl:w-44" value="${longToken}" /></div></div></div></header><section class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-2 md:px-6 md:py-3 xl:px-5"><div class="desktop-tool-timeline"><div class="desktop-tool-track">${tabletToolNodes}</div></div></section></section></main>
</section></div></body></html>`;
}

function outerFixture(width) {
  const srcdoc = escapeSrcdoc(innerFixture());
  return `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;background:#eee;} iframe{display:block;width:${width}px;height:900px;border:0;background:white;}</style></head><body><iframe title="viewport-${width}" srcdoc="${srcdoc}"></iframe></body></html>`;
}

const fixturePort = 5179;
const fixtureServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${fixturePort}`);
  const width = Number(url.searchParams.get('width') ?? '360');
  const html = outerFixture(width);
  const file = resolve(proofDir, `fixture-${width}.html`);
  writeFileSync(file, html);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((resolve) => fixtureServer.listen(fixturePort, '127.0.0.1', resolve));

const gecko = spawn('geckodriver', ['--port', '4447'], { stdio: ['ignore', 'pipe', 'pipe'] });
const base = 'http://127.0.0.1:4447';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path, method = 'GET', body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return json.value ?? json;
}
async function waitForGecko() {
  for (let i = 0; i < 60; i += 1) {
    try { await request('/status'); return; } catch { await sleep(250); }
  }
  throw new Error('geckodriver did not become ready');
}

let sessionId;
try {
  await waitForGecko();
  const session = await request('/session', 'POST', {
    capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } } },
  });
  sessionId = session.sessionId;
  const widths = widthsToVerify;
  const results = [];
  await request(`/session/${sessionId}/window/rect`, 'POST', { width: 1400, height: 1000, x: 0, y: 0 });
  for (const width of widths) {
    await request(`/session/${sessionId}/url`, 'POST', { url: `http://127.0.0.1:${fixturePort}/fixture.html?width=${width}` });
    await sleep(700);
    const result = await request(`/session/${sessionId}/execute/sync`, 'POST', {
      script: `
        const frame = document.querySelector('iframe');
        const doc = frame.contentDocument;
        const win = frame.contentWindow;
        const widest = [...doc.querySelectorAll('body *')]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { tag: el.tagName.toLowerCase(), cls: el.className || '', width: Math.ceil(r.width), scrollWidth: el.scrollWidth };
          })
          .sort((a, b) => Math.max(b.width, b.scrollWidth) - Math.max(a.width, a.scrollWidth))[0];
        return {
          requestedWidth: arguments[0],
          iframeClientWidth: frame.clientWidth,
          innerWidth: win.innerWidth,
          docScrollWidth: doc.scrollingElement.scrollWidth,
          bodyScrollWidth: doc.body.scrollWidth,
          widest,
          chatShellWidth: Math.ceil(doc.querySelector('.chat-shell').getBoundingClientRect().width),
          messageWidth: Math.ceil(doc.querySelector('.message').getBoundingClientRect().width),
          preClientWidth: doc.querySelector('pre').clientWidth,
          preScrollWidth: doc.querySelector('pre').scrollWidth,
          headerOverlap: (() => {
            const header = doc.querySelector('.tablet-proof-header');
            if (!header || getComputedStyle(header).display === 'none') return false;
            const clusters = [...header.querySelectorAll('[data-proof-cluster]')].map((el) => ({ name: el.getAttribute('data-proof-cluster'), rect: el.getBoundingClientRect() }));
            for (let i = 0; i < clusters.length; i += 1) {
              for (let j = i + 1; j < clusters.length; j += 1) {
                const a = clusters[i].rect;
                const b = clusters[j].rect;
                const separated = a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
                if (!separated) return clusters[i].name + '/' + clusters[j].name;
              }
            }
            return false;
          })()
        };
      `,
      args: [width],
    });
    results.push(result);
  }
  console.log('COD-056 mobile overflow proof fixtures:', proofDir);
  for (const row of results) {
    const ok = row.innerWidth === row.requestedWidth && row.docScrollWidth <= row.innerWidth && !row.headerOverlap;
    console.log(`${ok ? 'PASS' : 'FAIL'} width=${row.requestedWidth} iframe=${row.iframeClientWidth} innerWidth=${row.innerWidth} docScrollWidth=${row.docScrollWidth} bodyScrollWidth=${row.bodyScrollWidth} chatShell=${row.chatShellWidth} message=${row.messageWidth} preClient=${row.preClientWidth} preScroll=${row.preScrollWidth} headerOverlap=${row.headerOverlap || 'none'} widest=${row.widest.tag}.${String(row.widest.cls).replace(/\s+/g, '.')}:${row.widest.width}/${row.widest.scrollWidth}`);
    if (!ok) process.exitCode = 1;
  }
} finally {
  if (sessionId) {
    try { await request(`/session/${sessionId}`, 'DELETE'); } catch {}
  }
  gecko.kill('SIGTERM');
  await new Promise((resolve) => fixtureServer.close(resolve));
}

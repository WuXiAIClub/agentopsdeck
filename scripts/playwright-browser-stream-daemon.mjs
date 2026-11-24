#!/usr/bin/env node
/**
 * Playwright Headless Chromium Streaming Daemon for AgentOpsDeck Desktop Browser.
 *
 * Bridges live command files (`browser-stream/cmd.json`) written via the
 * connector file API or HTTP route to a real Headless Chromium instance,
 * writing live JPEG frame snapshots (`browser-stream/state.json`) only to
 * explicitly configured output directories or the private command directory.
 */

import { randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserStreamConfig } from './lib/browser-stream-config.mjs';
import { runtimeOptions } from './start-workspace-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const streamConfig = browserStreamConfig();
const CHROMIUM_EXECUTABLE = streamConfig.chromiumExecutable;
const CMD_FILES = streamConfig.commandFiles;
const CMD_FILE = CMD_FILES[0];
const OUTPUT_DIRS = streamConfig.outputDirectories;
export function streamLaunchOptions(executablePath, environment = process.env, uid = process.getuid?.()) {
  const { headless, chromiumSandbox } = runtimeOptions(environment, uid);
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new Error('An absolute independently installed Chromium executable is required');
  }
  return { executablePath, headless, chromiumSandbox,
    args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] };
}

const copy = streamConfig.language === 'zh-CN' ? {
  heading: 'AgentOpsDeck 云端流式浏览器', description: '通过服务端 Chromium 画面流访问网站。浏览器与操作系统权限由部署者管理。',
  search: '搜索与资讯', encyclopedia: '百科', community: '开发者社区', papers: '论文预印本', example: '标准连通性测试页',
} : {
  heading: 'AgentOpsDeck streaming browser', description: 'Browse websites through server-side Chromium frames. Browser and operating-system permissions are managed by the operator.',
  search: 'Search and news', encyclopedia: 'Encyclopedia', community: 'Developer community', papers: 'Research preprints', example: 'Example connectivity page',
};

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  tablet: { width: 820, height: 1080 },
  mobile: { width: 390, height: 844 },
};

const START_PAGE_HTML = `<!doctype html>
<html lang="${streamConfig.language}">
<head>
  <meta charset="utf-8" />
  <title>AgentOpsDeck Cloud Browser · Playwright Stream</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 20% 20%, #1e293b 0%, #0f172a 60%, #020617 100%);
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.14);
      border: 1px solid rgba(56, 189, 248, 0.35);
      color: #38bdf8;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 18px;
    }
    h1 {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 10px;
    }
    p.sub {
      color: #94a3b8;
      font-size: 15px;
      max-width: 640px;
      text-align: center;
      line-height: 1.6;
      margin-bottom: 32px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 14px;
      width: 100%;
      max-width: 780px;
    }
    .card {
      background: rgba(30, 41, 59, 0.72);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 14px;
      padding: 16px;
      text-decoration: none;
      color: #f1f5f9;
      transition: all 0.16s ease;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .card strong { font-size: 15px; color: #38bdf8; }
    .card span { font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="badge">● Playwright Chromium Headless Stream · Zero-Iframe</div>
  <h1>${copy.heading}</h1>
  <p class="sub">${copy.description}</p>
  <div class="grid">
    <a class="card" href="https://www.bing.com"><strong>Bing Search</strong><span>bing.com · ${copy.search}</span></a>
    <a class="card" href="https://news.ycombinator.com"><strong>Hacker News</strong><span>news.ycombinator.com</span></a>
    <a class="card" href="https://en.wikipedia.org"><strong>Wikipedia</strong><span>en.wikipedia.org · ${copy.encyclopedia}</span></a>
    <a class="card" href="https://github.com/trending"><strong>GitHub Trending</strong><span>github.com/trending</span></a>
    <a class="card" href="https://developer.mozilla.org"><strong>MDN Web Docs</strong><span>developer.mozilla.org</span></a>
    <a class="card" href="https://www.v2ex.com"><strong>V2EX</strong><span>v2ex.com · ${copy.community}</span></a>
    <a class="card" href="https://arxiv.org"><strong>arXiv.org</strong><span>arxiv.org · ${copy.papers}</span></a>
    <a class="card" href="https://example.com"><strong>Example.com</strong><span>${copy.example}</span></a>
  </div>
</body>
</html>`;

export async function writeAtomicJson(targetPath, data) {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
    throw new Error('Absolute target path required for atomic JSON write');
  }
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const dirStat = await lstat(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error('Refusing atomic JSON write through non-directory or symlinked parent');
  }
  const existingStat = await lstat(targetPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existingStat?.isSymbolicLink()) {
    throw new Error('Refusing atomic JSON overwrite of symbolic link');
  }
  const tmp = `${targetPath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(tmp, flags, 0o600);
    await handle.writeFile(JSON.stringify(data), 'utf8');
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(tmp, targetPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export function buildStreamFrameState({
  seq,
  frameSeq,
  updatedAt,
  url,
  title,
  viewportMode,
  width,
  height,
  canGoBack,
  canGoForward,
  loading = false,
  frameDataUrl,
  extra = {},
}) {
  const hasError = typeof extra?.error === 'string' && extra.error.length > 0;
  const status = typeof extra?.status === 'string' && extra.status.length > 0
    ? extra.status
    : (hasError ? 'error' : 'streaming');
  return {
    ok: !hasError,
    ...extra,
    status,
    engine: 'playwright-chromium',
    seq,
    frameSeq,
    updatedAt,
    url,
    title,
    viewportMode,
    width,
    height,
    canGoBack,
    canGoForward,
    loading,
    frameDataUrl,
  };
}

async function main() {
  const launchOptions = streamLaunchOptions(CHROMIUM_EXECUTABLE);
  const pwModulePath = path.join(REPO_ROOT, 'apps', 'server', 'node_modules', 'playwright-core', 'index.mjs');
  const { chromium } = await import(pwModulePath);

  const cmdDir = path.dirname(CMD_FILE);
  await mkdir(cmdDir, { recursive: true, mode: 0o700 });
  await chmod(cmdDir, 0o700);
  if (!existsSync(CMD_FILE)) {
    await writeAtomicJson(CMD_FILE, { seq: 0, kind: 'init', ts: Date.now() });
  }

  let browser;
  let context;
  let page;
  let currentViewportMode = 'desktop';
  let currentViewport = VIEWPORTS.desktop;
  let lastProcessedSeq = -1;
  let frameSeq = 0;
  let lastCaptureAt = 0;
  let isCapturing = false;
  let isExecuting = false;
  let historyStack = ['about:home'];
  let historyIndex = 0;

  async function ensureBrowser() {
    if (browser && page && !page.isClosed()) return;
    try {
      if (browser) await browser.close().catch(() => {});
    } catch {}
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({
      viewport: currentViewport,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
    await page.setContent(START_PAGE_HTML, { waitUntil: 'domcontentloaded' });
  }

  async function captureAndPublish(extra = {}) {
    if (isCapturing) return;
    isCapturing = true;
    try {
      await ensureBrowser();
      const buf = await page.screenshot({
        type: 'jpeg',
        quality: 74,
         scale: 'css',
      });
      const rawUrl = page.url();
      const displayUrl = rawUrl === 'about:blank' ? (historyStack[historyIndex] || 'about:home') : rawUrl;
      const title = (await page.title().catch(() => '')) || 'Cloud Browser';
      frameSeq += 1;
      lastCaptureAt = Date.now();
      const payload = buildStreamFrameState({
        seq: lastProcessedSeq,
        frameSeq,
        updatedAt: lastCaptureAt,
        url: displayUrl,
        title,
        viewportMode: currentViewportMode,
        width: currentViewport.width,
        height: currentViewport.height,
        canGoBack: historyIndex > 0,
        canGoForward: historyIndex < historyStack.length - 1,
        loading: false,
        frameDataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
        extra,
      });
      await Promise.all(
        OUTPUT_DIRS.map((dir) => writeAtomicJson(path.join(dir, 'state.json'), payload)),
      );
    } catch (err) {
      // Keep running on transient capture errors
    } finally {
      isCapturing = false;
    }
  }

  async function navigateTo(targetUrl, pushHistory = true) {
    await ensureBrowser();
    const trimmed = String(targetUrl || '').trim();
    if (!trimmed || trimmed === 'about:home' || trimmed === 'about:blank') {
      await page.setContent(START_PAGE_HTML, { waitUntil: 'domcontentloaded' });
      if (pushHistory && historyStack[historyIndex] !== 'about:home') {
        historyStack = historyStack.slice(0, historyIndex + 1);
        historyStack.push('about:home');
        historyIndex = historyStack.length - 1;
      }
      return;
    }
    let normalized = trimmed;
    if (!/^https?:\/\//i.test(normalized)) {
      if (normalized.includes('.') && !normalized.includes(' ')) {
        normalized = `https://${normalized}`;
      } else {
        normalized = `https://www.bing.com/search?q=${encodeURIComponent(normalized)}`;
      }
    }
    try {
      await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 14000 });
    } catch {
      // Even on partial load timeout, screenshot what rendered
    }
    const finalUrl = page.url();
    const recorded = finalUrl && finalUrl !== 'about:blank' ? finalUrl : normalized;
    if (pushHistory && historyStack[historyIndex] !== recorded) {
      historyStack = historyStack.slice(0, historyIndex + 1);
      historyStack.push(recorded);
      historyIndex = historyStack.length - 1;
    }
  }

  async function handleCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    await ensureBrowser();
    const kind = cmd.kind || cmd.action;
    if (kind === 'init') {
      await captureAndPublish();
      return;
    }
    if (kind === 'navigate' && typeof cmd.url === 'string') {
      await navigateTo(cmd.url, true);
    } else if (kind === 'back') {
      if (historyIndex > 0) {
        historyIndex -= 1;
        await navigateTo(historyStack[historyIndex], false);
      } else {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      }
    } else if (kind === 'forward') {
      if (historyIndex < historyStack.length - 1) {
        historyIndex += 1;
        await navigateTo(historyStack[historyIndex], false);
      } else {
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      }
    } else if (kind === 'reload') {
      if (historyStack[historyIndex] === 'about:home') {
        await page.setContent(START_PAGE_HTML, { waitUntil: 'domcontentloaded' });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      }
    } else if (kind === 'viewport' && VIEWPORTS[cmd.viewportMode || cmd.mode]) {
      const nextMode = cmd.viewportMode || cmd.mode;
      currentViewportMode = nextMode;
      currentViewport = VIEWPORTS[nextMode];
      await page.setViewportSize(currentViewport).catch(() => {});
    } else if (kind === 'click') {
      const x = Math.max(0, Math.min(currentViewport.width - 1, Math.round(Number(cmd.x) || 0)));
      const y = Math.max(0, Math.min(currentViewport.height - 1, Math.round(Number(cmd.y) || 0)));
      const beforeUrl = page.url();
      await page.mouse.click(x, y).catch(() => {});
      await new Promise((r) => setTimeout(r, 260));
      const afterUrl = page.url();
      if (afterUrl && afterUrl !== 'about:blank' && afterUrl !== beforeUrl) {
        historyStack = historyStack.slice(0, historyIndex + 1);
        historyStack.push(afterUrl);
        historyIndex = historyStack.length - 1;
      }
    } else if (kind === 'scroll') {
      const dx = Math.round(Number(cmd.dx ?? cmd.deltaX) || 0);
      const dy = Math.round(Number(cmd.dy ?? cmd.deltaY) || 0);
      await page.mouse.wheel(dx, dy).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
    } else if ((kind === 'text' || kind === 'type') && typeof cmd.text === 'string') {
      if (cmd.clearFirst) {
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
      }
      await page.keyboard.insertText(cmd.text).catch(() => {});
      if (cmd.submit) {
        await page.keyboard.press('Enter').catch(() => {});
        await new Promise((r) => setTimeout(r, 350));
      }
    } else if ((kind === 'key' || kind === 'press') && typeof cmd.key === 'string') {
      await page.keyboard.press(cmd.key).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
    }
    await captureAndPublish();
  }

  await ensureBrowser();
  await captureAndPublish();

  setInterval(async () => {
    if (isExecuting) return;
    for (const candidateFile of CMD_FILES) {
      try {
        const raw = await readFile(candidateFile, 'utf8');
        const cmd = JSON.parse(raw);
        const cmdKey = String(cmd?.id ?? cmd?.seq ?? raw);
        if (cmdKey && cmdKey !== String(lastProcessedSeq)) {
          isExecuting = true;
          lastProcessedSeq = cmdKey;
          try {
            await handleCommand(cmd);
          } finally {
            isExecuting = false;
          }
          return;
        }
      } catch {
        // Ignore partial read
      }
    }
    if (Date.now() - lastCaptureAt > 2500 && !isExecuting) {
      await captureAndPublish();
    }
  }, 160);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Playwright stream daemon failed; verify isolated egress, non-root sandbox support and independent Chromium configuration.');
    process.exitCode = 1;
  });
}

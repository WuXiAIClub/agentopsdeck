import { createCacheStorage } from '/android-cache.mjs';
import { installLanCrypto } from '/android-lan-crypto.mjs';
import { installResourceRouting } from '/android-resource-routing.mjs';
import { installVoiceRecording } from '/android-speech.mjs';
import { publicOrigin, lanOrigins } from '/android-connection.mjs';

const bridge = window.AgentOpsDeckNative;
const downloadMessage = (english, chinese) => {
  let locale = navigator.language;
  try { locale = window.localStorage.getItem('agentopsdeck.locale') || locale; } catch {}
  return String(locale).toLowerCase().startsWith('zh') ? chinese : english;
};
if (bridge) installResourceRouting(window, document, publicOrigin, lanOrigins);
const send = packet => bridge.postMessage(JSON.stringify(packet));
const speechReply = bridge ? installVoiceRecording(window, send) : () => {};
const cryptoReply = bridge && location.protocol === 'http:' ? installLanCrypto(window.crypto, send) : () => {};
let cache;
const startedAt = performance.now();
const performanceStats = { apiReads: 0, notModified: 0, failures: 0, moduleReadyMs: 0 };
if (bridge) {
  cache = createCacheStorage({}, send, setTimeout, clearTimeout, key => {
    window.dispatchEvent(new CustomEvent('agentopsdeck:cache-hydrated', { detail: { key } }));
  });
  window.__AGENTOPSDECK_CACHE_STORAGE__ = cache;
  bridge.onmessage = event => {
    try {
      const packet = JSON.parse(event.data);
      cryptoReply(packet); speechReply(packet); cache.receive(packet);
    } catch {}
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const tracked = url.origin === location.origin && url.pathname.startsWith('/api/')
      && String(init?.method ?? input?.method ?? 'GET').toUpperCase() === 'GET';
    if (tracked) performanceStats.apiReads++;
    try {
      const response = await originalFetch(input, init);
      if (tracked && response.status === 304) performanceStats.notModified++;
      if (tracked && !response.ok && response.status !== 304) performanceStats.failures++;
      return response;
    } catch (error) { if (tracked) performanceStats.failures++; throw error; }
  };
}
const reportMetrics = () => { if (bridge) send({ type: 'client.metrics', metrics: { ...performanceStats, ...cache.metrics } }); };
window.addEventListener('agentopsdeck:android-metrics', reportMetrics);
window.__AGENTOPSDECK_ANDROID_READY__ = () => {
  performanceStats.moduleReadyMs = Math.round(performance.now() - startedAt);
  if (bridge) send({ type: 'client.ready' });
  reportMetrics();
};

window.__AGENTOPSDECK_ANDROID__ = true;
try { if (!window.localStorage.getItem('agentopsdeck.locale')) window.localStorage.setItem('agentopsdeck.locale', navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'); } catch {}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register = () => Promise.reject(new DOMException('Bundled Android assets do not use a service worker', 'NotSupportedError'));
  await navigator.serviceWorker.getRegistrations().then(registrations =>
    Promise.all(registrations.map(registration => registration.unregister()))
  ).catch(() => {});
}

window.addEventListener('agentopsdeck:android-pause', () => { cache?.flush(); reportMetrics(); });
window.addEventListener('pagehide', () => cache?.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') cache?.flush();
});
let lastWake = -Infinity;
let resumeTimer;
const recordWake = () => { lastWake = performance.now(); };
window.addEventListener('focus', recordWake, true);
window.addEventListener('pageshow', recordWake, true);
window.addEventListener('online', recordWake, true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) recordWake(); }, true);
window.addEventListener('agentopsdeck:android-resume', () => {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    if (!document.hidden && performance.now() - lastWake > 750) window.dispatchEvent(new Event('focus'));
    reportMetrics();
  }, 200);
});

const MAX_BLOB_BYTES = 24 * 1024 * 1024;
let blobDownloadBusy = false;
const readBoundedBlob = async response => {
  const declared = Number(response.headers?.get('content-length') ?? -1);
  if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) return null;
  const mime = response.headers?.get('content-type') || 'application/octet-stream';
  if (!response.body?.getReader) {
    const fallback = await response.blob();
    return fallback.size > MAX_BLOB_BYTES ? null : fallback;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BLOB_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: mime });
};
const originalClick = HTMLAnchorElement.prototype.click;
if (bridge) HTMLAnchorElement.prototype.click = function () {
  const routed = window.__AGENTOPSDECK_RESOURCE_URL__(this.href);
  if (routed !== this.href) this.href = routed;
  if (!this.href.startsWith('blob:') || !this.download) return originalClick.call(this);
  if (blobDownloadBusy) return;
  blobDownloadBusy = true;
  const name = this.download;
  fetch(this.href).then(readBoundedBlob).then(blob => {
    if (!blob || blob.size > MAX_BLOB_BYTES) {
      blobDownloadBusy = false;
      alert(downloadMessage('This file is larger than 24 MB. Use the original download link or open this session in your browser.', '文件超过 24 MB，请使用原始下载链接或在浏览器打开此会话。'));
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => { blobDownloadBusy = false; };
    reader.onload = () => send({ type: 'download.blob', name, mime: blob.type || 'application/octet-stream', base64: String(reader.result).split(',')[1] });
    reader.readAsDataURL(blob);
  }).catch(() => {
    blobDownloadBusy = false;
    alert(downloadMessage('Unable to prepare this download. Please retry.', '无法准备下载，请重试。'));
  });
};

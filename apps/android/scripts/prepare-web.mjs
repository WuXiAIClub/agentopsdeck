import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { adaptSpeechComposer } from '../web/speech-composer.mjs';

const androidRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = path.resolve(process.argv[2] || path.join(androidRoot, '..', '..'));
const webRoot = path.join(sourceRoot, 'apps', 'web');
process.chdir(webRoot);
const requireWeb = createRequire(path.join(webRoot, 'package.json'));
const vite = await import(pathToFileURL(requireWeb.resolve('vite')));
const loaded = await vite.loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(webRoot, 'vite.config.ts'));
if (!loaded) throw new Error('Unable to load the existing web frontend configuration');
const output = path.join(androidRoot, 'app', 'src', 'main', 'assets', 'web');
let cacheAdapted = false;
let videoAdapted = false;
let resourceAdapted = false;
let speechAdapted = false;
let speechErrorsAdapted = false;
let historyAdapted = false;
let hydrationAdapted = false;
const nativeVideo = await readFile(path.join(androidRoot, 'web', 'VideoPlayer.tsx'), 'utf8');
await vite.build({
  ...loaded.config,
  configFile: false,
  root: webRoot,
  base: '/',
  plugins: [...(loaded.config.plugins || []), {
    name: 'agentopsdeck-android-cache',
    enforce: 'pre',
    transform(code, id) {
      code = code.replace(/\r\n/g, '\n');
      if (id.replaceAll('\\', '/').endsWith('/src/lib/session-utils.ts')) {
        const check = 'if (!window.isSecureContext)';
        if (!code.includes(check)) throw new Error('Voice availability check changed; review Android compatibility');
        speechAdapted = true;
        return code.replace(check, 'if (!window.isSecureContext && !(window as any).__AGENTOPSDECK_NATIVE_SPEECH__)');
      }
      if (id.replaceAll('\\', '/').endsWith('/src/main.tsx')) {
        const check = "if (error === 'not-allowed' || error === 'service-not-allowed')";
        if (!code.includes(check)) throw new Error('Voice error handler changed; review Android compatibility');
        speechErrorsAdapted = true;
        code = adaptSpeechComposer(code);
        const hydrationPoint = '  const homeSessions = useMemo(';
        if (!code.includes(hydrationPoint)) throw new Error('Mobile cache hydration changed; review Android compatibility');
        hydrationAdapted = true;
        code = code.replace(hydrationPoint, `  useEffect(() => {
    const hydrate = () => {
      const restored = initialSessionsState();
      setSessionsState(current => current.updatedAt === 0 ? restored : current);
      if (!selectedKeyRef.current) {
        const route = readHashRoute();
        const wanted = route.sessionKey || (!route.tab ? readSavedMobileSessionKey() : undefined);
        const session = restored.groups.flatMap(group => group.sessions).find(item => item.sessionKey === wanted);
        if (session) {
          selectedKeyRef.current = session.sessionKey;
          latestSelectedSession.current = session;
          setSelectedState(session);
          setMessageState(messageStateForSession(session.sessionKey, messageLimitRef.current));
        }
      }
      const key = selectedKeyRef.current;
      if (key) setMessageState(current => current.sessionKey === key && current.loading && current.items.length === 0
        ? messageStateForSession(key, messageLimitRef.current) : current);
    };
    window.addEventListener('agentopsdeck:cache-hydrated', hydrate);
    hydrate();
    return () => window.removeEventListener('agentopsdeck:cache-hydrated', hydrate);
  }, []);
` + hydrationPoint);
        return code.replace(check, "if (error === 'service-timeout') return '系统语音识别服务启动超时，请检查手机的系统语音服务，或使用输入法语音输入。';\n  if (error === 'service-not-allowed') return '手机系统语音识别服务不可用，请安装或启用支持中文的语音识别服务，也可改用输入法语音输入。';\n  if (error === 'language-not-supported') return '系统语音识别服务不支持当前语言，请在系统设置中安装对应语言或更换语音识别服务。';\n  if (error === 'not-allowed')")
          .replace('Microphone or speech recognition permission denied. Check this site’s browser permissions.', '麦克风权限被拒绝，请在安卓设置 → 应用 → AgentOpsDeck → 权限中允许麦克风，并确认系统麦克风总开关已开启。')
          .replace('The browser’s speech recognition service is unreachable. Check your connection or type your message instead.', '系统语音识别服务连接失败，请检查网络或改用输入法语音输入。');
      }
      if (id.replaceAll('\\', '/').endsWith('/src/api.ts')) {
        const sendEntry = '  sendMessage: (sessionKey: SessionTarget,';
        if (!code.includes(sendEntry)) throw new Error('Message API changed; review Android voice upload');
        code = code.replace(sendEntry, `  sendVoiceMessage: (sessionKey: SessionTarget, audio: { contentBase64: string; mimeType: string },
    idempotencyKey: string, deliveryMode: SendDeliveryMode, signal: AbortSignal) =>
    json<SendMessageResponse>(\`\${sessionAddress(sessionKey).path}/voice\`, {
      method: 'POST', timeoutMs: 150_000, signal,
      body: JSON.stringify({ audio, idempotencyKey, deliveryMode }),
    }),
` + sendEntry);
        const mediaEntry = 'export function mediaUrl(url: string) {';
        const downloadEntry = 'export async function downloadMediaUrl(url: string) {';
        if (!code.includes(mediaEntry) || !code.includes(downloadEntry)) throw new Error('Media URL helpers changed; review Android compatibility');
        resourceAdapted = true;
        const historyPoint = '  const previousHistory = historyKey ? conditionalHistoryCache.get(historyKey) : undefined;';
        const persistPoint = "  if (historyKey && response.status !== 304 && snapshotEpoch === snapshotGeneration && baseVersion?.valid) conditionalHistoryCache.put(historyKey, response.headers.get('etag'), body);";
        if (!code.includes(historyPoint) || !code.includes(persistPoint) || !code.includes('  activeRecoveryScope = next;') || !code.includes('  let body: any;\n  try {')) throw new Error('History persistence hooks changed; review Android compatibility');
        historyAdapted = true;
        code = code.replace('  activeRecoveryScope = next;', '  activeRecoveryScope = next;\n  (window as any).__AGENTOPSDECK_CACHE_STORAGE__?.setScope(next);');
        code = code.replace(historyPoint, '  let previousHistory = historyKey ? conditionalHistoryCache.get(historyKey) : undefined;');
        code = code.replace('  let body: any;\n  try {', `  let body: any;
  try {
  if (historyKey && !previousHistory) {
    const saved = await (window as any).__AGENTOPSDECK_CACHE_STORAGE__?.history(scope, path);
    if (epoch !== recoveryGeneration || snapshotEpoch !== snapshotGeneration || !version?.valid)
      throw new DOMException('History authority changed', 'AbortError');
    if (saved) {
      conditionalHistoryCache.put(historyKey, saved.etag, saved.page);
      previousHistory = conditionalHistoryCache.get(historyKey);
    }
  }`);
        code = code.replaceAll('conditionalHistoryCache.remove(historyKey);', '(conditionalHistoryCache.remove(historyKey), (window as any).__AGENTOPSDECK_CACHE_STORAGE__?.removeHistory(scope, path));');
        code = code.replace(persistPoint, `  if (historyKey && response.status !== 304 && snapshotEpoch === snapshotGeneration && baseVersion?.valid) {
    conditionalHistoryCache.put(historyKey, response.headers.get('etag'), body);
    (window as any).__AGENTOPSDECK_CACHE_STORAGE__?.saveHistory(scope, path, response.headers.get('etag'), body);
  }`);
        const route = '\n  url = (window as any).__AGENTOPSDECK_RESOURCE_URL__?.(url) ?? url;';
        return code.replace(mediaEntry, mediaEntry + route).replace(downloadEntry, downloadEntry + route);
      }
      if (id.replaceAll('\\', '/').endsWith('/src/components/VideoPlayer.tsx')) {
        videoAdapted = true;
        return nativeVideo;
      }
      if (!id.replaceAll('\\', '/').endsWith('/src/lib/session-cache.ts')) return;
      if (!code.includes('const ls = window.localStorage;')) throw new Error('Web cache adapter changed; review Android compatibility');
      for (const marker of ['${safeHash(namespace())}', 'function enforceBounds(store: Storage): void {', 'export function clearAllCachedData(): void {', 'export function clearCachedNodeData(connectionIds: ReadonlySet<string>): void {']) {
        if (!code.includes(marker)) throw new Error('Native cache lifecycle hook changed: ' + marker);
      }
      cacheAdapted = true;
      return code.replace('const ls = window.localStorage;', 'const ls = (window as any).__AGENTOPSDECK_CACHE_STORAGE__ ?? window.localStorage;')
        .replace('${safeHash(namespace())}', 'android')
        .replace('function enforceBounds(store: Storage): void {', 'function enforceBounds(store: Storage): void {\n  if ((window as any).__AGENTOPSDECK_CACHE_STORAGE__) return;')
        .replace('export function clearAllCachedData(): void {', 'export function clearAllCachedData(): void {\n  void (window as any).__AGENTOPSDECK_CACHE_STORAGE__?.clear();')
        .replace('export function clearCachedNodeData(connectionIds: ReadonlySet<string>): void {', 'export function clearCachedNodeData(connectionIds: ReadonlySet<string>): void {\n  if (connectionIds.size) void (window as any).__AGENTOPSDECK_CACHE_STORAGE__?.clear();')
        .replace('const MAX_CACHED_SESSIONS = 40;', 'const MAX_CACHED_SESSIONS = 80;')
        .replace('const MAX_TOTAL_CACHE_BYTES = 4 * 1024 * 1024;', 'const MAX_TOTAL_CACHE_BYTES = 16 * 1024 * 1024;');
    },
  }],
  build: { ...loaded.config.build, outDir: output, emptyOutDir: true },
});
if (!cacheAdapted) throw new Error('Native cache adapter was not applied');
if (!videoAdapted) throw new Error('Native video adapter was not applied');
if (!resourceAdapted) throw new Error('Native resource URL adapter was not applied');
if (!speechAdapted) throw new Error('Native speech adapter was not applied');
if (!speechErrorsAdapted) throw new Error('Native speech error adapter was not applied');
if (!historyAdapted || !hydrationAdapted) throw new Error('Native persistent history adapter was not applied');
let html = await readFile(path.join(output, 'index.html'), 'utf8');
const entry = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/);
if (!entry) throw new Error('Web entry module not found');
html = html.replace(entry[0], `<script type="module">await import('/android-runtime.js'); await import(${JSON.stringify(entry[1])}); window.__AGENTOPSDECK_ANDROID_READY__?.();</script>`);
await writeFile(path.join(output, 'index.html'), html);
await copyFile(path.join(androidRoot, 'web', 'android-runtime.js'), path.join(output, 'android-runtime.js'));
await copyFile(path.join(androidRoot, 'web', 'cache-storage.mjs'), path.join(output, 'android-cache.mjs'));
await copyFile(path.join(androidRoot, 'web', 'lan-crypto.mjs'), path.join(output, 'android-lan-crypto.mjs'));
await copyFile(path.join(androidRoot, 'web', 'resource-routing.mjs'), path.join(output, 'android-resource-routing.mjs'));
await copyFile(path.join(androidRoot, 'web', 'voice-recording.mjs'), path.join(output, 'android-speech.mjs'));
const pkg = JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8'));
await writeFile(path.join(output, 'android-build.json'), JSON.stringify({ frontendVersion: pkg.version, builtAt: new Date().toISOString(), nativeCache: true }, null, 2));
console.log(`Android UI prepared from AgentOpsDeck ${pkg.version}; source files and backend are unchanged.`);

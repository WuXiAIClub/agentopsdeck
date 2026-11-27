import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const activity = source('apps/android/app/src/main/java/com/agentopsdeck/MainActivity.java');
const transfer = source('apps/android/app/src/main/java/com/agentopsdeck/AuthenticatedDownload.java');
const coordinator = source('apps/ios/Sources/DownloadCoordinator.swift');
const controller = source('apps/ios/Sources/WebViewController.swift');

test('NAT-004 source: credentials are sent only after same-origin redirect validation, never delegated', () => {
  assert.doesNotMatch(activity, /DownloadManager|DOWNLOAD_SERVICE|setDestinationInExternalPublicDir/);
  assert.match(transfer, /MAX_REDIRECTS = 3/);
  assert.match(transfer, /setInstanceFollowRedirects\(false\)/);
  assert.match(transfer, /getRawUserInfo\(\) == null/);
  assert.match(transfer, /port\(origin\) == port\(candidate\)/);
  assert.ok(transfer.indexOf('if (!sameOrigin(origin, target))') < transfer.indexOf('next.setRequestProperty("Cookie", cookie)'));
  assert.match(transfer, /target = target.resolve\(new URI\(location\)\)/);
  for (const status of [301, 302, 303, 307, 308]) assert.match(transfer, new RegExp(`status == ${status}`));
});

test('NAT-004 source: actual bytes are limited before each private write and incomplete files removed', () => {
  assert.match(transfer, /MAX_BYTES = 64L \* 1024 \* 1024/);
  assert.match(transfer, /declared > MAX_BYTES/);
  assert.match(transfer, /count > MAX_BYTES - total/);
  assert.ok(transfer.indexOf('count > MAX_BYTES - total') < transfer.indexOf('output.write(buffer, 0, count)'));
  assert.match(transfer, /total != declared/);
  assert.match(transfer, /!complete && file != null\) file.delete\(\)/);
  assert.match(transfer, /TimeUnit.MINUTES.toNanos\(5\)/);
  assert.match(transfer, /setReadTimeout\(15000\)/);
  assert.match(transfer, /declared >= 0 && count > declared - total/);
  assert.match(transfer, /encoding != null && !encoding.equalsIgnoreCase\("identity"\)/);
});

test('NAT-004 source: redirect cookies are resolved for the validated target and identity is checked again', () => {
  const boundary = transfer.slice(transfer.indexOf('for (int redirects'), transfer.indexOf('File fetch'));
  assert.ok(boundary.indexOf('if (!sameOrigin(origin, target))') < boundary.indexOf('cookies.apply(target.toASCIIString())'));
  assert.match(boundary, /String cookie = cookies.apply\(target.toASCIIString\(\)\);\s+check\(current\);\s+if \(cookie != null\) next.setRequestProperty\("Cookie", cookie\)/);
  assert.match(activity, /BooleanSupplier current = \(\) -> generation == webGeneration && identity == downloadGeneration\s+&& java.util.Objects.equals\(cookie, CookieManager.getInstance\(\).getCookie\(url\)\)/);
});

test('native source: delayed blob exports are generation-fenced and failed staging is removed', () => {
  const blob = activity.slice(activity.indexOf('} else if (type.equals("download.blob"))'), activity.indexOf('} else if (type.equals("client.ready"))'));
  assert.ok(blob.indexOf('encoded.length() > 32 * 1024 * 1024') < blob.indexOf('Base64.decode(encoded'));
  assert.match(blob, /catch \(Exception error\) \{ file.delete\(\); throw error; \}/);
  assert.match(blob, /generation == webGeneration && requestDownloadGeneration == downloadGeneration\s+&& !destroyed && !isFinishing\(\)\) saveFile/);
  assert.match(blob, /else file.delete\(\)/);
  assert.match(activity, /DownloadFileName.resolve\("", null, name\)/);
  assert.match(activity, /safeName.length\(\) > 200/);
  const external = activity.slice(activity.indexOf('private void openExternal'), activity.indexOf('onRequestPermissionsResult'));
  assert.ok(external.indexOf('uri.getUserInfo() != null') < external.indexOf('startActivity'));
});

test('iOS source: retired WebViews cannot navigate, update status, show dialogs or prompt capture', () => {
  for (const [start, end, rejection] of [
    ['decidePolicyFor navigationAction', 'decidePolicyFor navigationResponse', 'decisionHandler(.cancel)'],
    ['decidePolicyFor navigationResponse', 'navigationAction: WKNavigationAction, didBecome', 'decisionHandler(.cancel)'],
    ['runJavaScriptAlertPanelWithMessage', 'runJavaScriptConfirmPanelWithMessage', 'completionHandler()'],
    ['runJavaScriptConfirmPanelWithMessage', 'runJavaScriptTextInputPanelWithPrompt', 'completionHandler(false)'],
    ['runJavaScriptTextInputPanelWithPrompt', 'requestMediaCapturePermissionFor origin', 'completionHandler(nil)'],
  ]) {
    const section = controller.slice(controller.indexOf(start), controller.indexOf(end));
    assert.ok(section.includes(`guard webView === self.webView else { ${rejection}; return }`), start);
  }
  assert.match(controller, /guard webView === self.webView else \{ decisionHandler\(\.deny\); return \}/);
});

test('NAT-004 source: session cancellation disconnects, confirmation rechecks identity and cookie', () => {
  assert.match(transfer, /cancelled \|\| Thread.currentThread\(\).isInterrupted\(\) \|\| !current.getAsBoolean\(\)/);
  assert.match(transfer, /synchronized void cancel\(\) \{\s+cancelled = true;\s+disconnect\(\)/);
  assert.match(activity, /identity == downloadGeneration/);
  assert.match(activity, /!current.getAsBoolean\(\) \|\| !java.util.Objects.equals\(cookie, CookieManager.getInstance\(\).getCookie\(url\)\)/);
  for (const method of ['createWebView', 'onDestroy']) assert.match(activity, new RegExp(`${method}\\(\\) \\{\\s+cancelDownloads\\(\\)`));
  assert.match(activity, /Objects.equals\(activeCacheScope, next\)\) \{\s+cancelDownloads\(\)/);
  assert.match(activity, /setPositiveButton\("Clear", \(dialog, which\) -> \{\s+cancelDownloads\(\)/);
});

test('NAT-004 source: one staging/save slot, explicit export, no legacy storage permission', () => {
  assert.match(activity, /activeDownload != null \|\| pendingFile != null \|\| savePickerOpen \|\| saveInProgress/);
  assert.match(activity, /transfer.fetch\(url, CookieManager.getInstance\(\)::getCookie, userAgent, getCacheDir\(\), current\)/);
  assert.match(activity, /Intent.ACTION_CREATE_DOCUMENT/);
  assert.match(activity, /identity != downloadGeneration\) throw new IllegalStateException\("Save cancelled"\)/);
  assert.doesNotMatch(source('apps/android/app/src/main/AndroidManifest.xml'), /WRITE_EXTERNAL_STORAGE/);
  assert.match(activity, /item.getItemId\(\) == 1001\) \{ cancelDownloads\(\)/);
});

test('NAT-005 source: data delegate rejects byte overflow before private writes; bounded admission includes shares', () => {
  for (const literal of ['maxFileBytes: Int64 = 64 * 1024 * 1024', 'maxTotalBytes: Int64 = 128 * 1024 * 1024',
    'maxTransfers = 2', 'maxPendingShares = 2', 'reservedBytes <= Self.maxTotalBytes - Self.maxFileBytes',
    'pendingShares.count + transfers.count + (activeShare == nil ? 0 : 1) < Self.maxPendingShares']) assert.ok(coordinator.includes(literal), literal);
  assert.match(coordinator, /URLSessionDataDelegate/);
  assert.doesNotMatch(coordinator, /WKDownloadDelegate|decideDestinationUsing|downloadTask\(/);
  assert.match(coordinator, /response.expectedContentLength <= Self.maxFileBytes/);
  const sink = coordinator.slice(coordinator.indexOf('didReceive data: Data)'), coordinator.indexOf('willPerformHTTPRedirection'));
  assert.match(sink, /count <= Self.maxFileBytes - transfer.bytes/);
  assert.match(sink, /count <= \(transfer.expectedBytes \?\? Self.maxFileBytes\) - transfer.bytes/);
  assert.match(sink, /reservedBytes <= Self.maxTotalBytes/);
  assert.match(sink, /else \{\s+fail\(transfer\)\s+return\s+\}/);
  assert.ok(sink.indexOf('count <= Self.maxFileBytes - transfer.bytes') < sink.indexOf('try handle.write(contentsOf: data)'));
  assert.ok(sink.indexOf('try handle.write(contentsOf: data)') < sink.indexOf('transfer.bytes += count'));
  assert.match(coordinator, /bytes == transfer.bytes/);
  assert.match(coordinator, /transfer.expectedBytes.map \{ bytes == \$0 \} \?\? true/);
  assert.match(coordinator, /FileHandle\(forWritingTo: file\)/);
  assert.match(coordinator, /\.posixPermissions: 0o600, \.protectionKey: FileProtectionType.complete/);
  assert.match(coordinator, /Content-Encoding"\) \?\? "identity"/);
  for (const field of ['urlCache', 'httpCookieStorage', 'urlCredentialStorage']) assert.ok(coordinator.includes(`configuration.${field} = nil`));
  assert.match(coordinator, /URLSessionConfiguration.ephemeral/);
  assert.match(coordinator, /delegateQueue: \.main/);
  assert.match(coordinator, /willCacheResponse[\s\S]*?completionHandler\(nil\)/);
  assert.match(coordinator, /timeIntervalSince\(transfer.started\) > 300/);
});

test('NAT-005 source: controlled GET/cookies/redirects and identity cancellation reject stale callbacks and clean partials', () => {
  assert.match(coordinator, /guard !cancelled, transfers.count/);
  assert.match(coordinator, /cancelled = true;?\s+monitor\?\.invalidate\(\)/);
  assert.match(coordinator, /if let share = activeShare \{ try\? FileManager.default.removeItem\(at: share.directory\)/);
  assert.match(coordinator, /shareController\?\.dismiss\(animated: false\)/);
  assert.match(coordinator, /transfer.task\?\.cancel\(\)\s+try\? transfer.handle\?\.close\(\)\s+transfer.handle = nil/);
  assert.match(coordinator, /func fail[\s\S]*?discard\(transfer\)/);
  assert.match(coordinator, /session\?\.invalidateAndCancel\(\)/);
  assert.match(coordinator, /download.cancel \{ _ in \}/);
  assert.match(coordinator, /download.originalRequest[\s\S]*?endpoint.contains\(url\)/);
  assert.match(coordinator, /original.httpMethod \?\? "GET"\) == "GET", original.httpBody == nil, original.httpBodyStream == nil/);
  assert.match(coordinator, /cookieStore.getAllCookies[\s\S]*?self.transfers\[transfer.identifier\] === transfer/);
  assert.match(coordinator, /cookiesDidChange[\s\S]*?cancelWork\(\)/);
  assert.match(coordinator, /cookieStore\?\.remove\(self\)/);
  assert.match(coordinator, /transfer.task === task/);
  const redirect = coordinator.slice(coordinator.indexOf('willPerformHTTPRedirection'), coordinator.indexOf('didReceive challenge:'));
  assert.match(redirect, /transfer.redirects < 3, \[301, 302, 303, 307, 308\]/);
  assert.ok(redirect.indexOf('endpoint.contains(url)') < redirect.indexOf('completionHandler(request)'));
  assert.match(redirect, /completionHandler\(nil\)\s+fail\(transfer\)/);
  assert.ok(coordinator.indexOf('guard !cancelled, endpoint.contains(url)') < coordinator.indexOf('forHTTPHeaderField: "Cookie"'));
  assert.match(coordinator, /cancelAuthenticationChallenge, nil/);
  assert.match(coordinator, /self.activeShare\?\.directory == share.directory/);
  assert.match(controller, /let coordinator = downloads\s+let cookieStore = webView.configuration.websiteDataStore.httpCookieStore\s+webView.startDownload/);
  assert.equal((controller.match(/guard webView === self.webView/g) ?? []).length, 14);
  assert.match(controller, /NSLocalizedString\("cancel_downloads"/);
  assert.match(controller, /deinit \{\s+downloads\?\.cancelAll\(\)/);
});

function keys(text, pattern) {
  return [...text.matchAll(pattern)].map(match => match[1]).sort();
}

test('NAT-006 source: download/connection UI and iOS permissions have paired nonempty EN/CN resources', () => {
  const resources = ['values', 'values-zh-rCN'].map(locale => new Map(
    [...source(`apps/android/app/src/main/res/${locale}/strings.xml`).matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g)]
      .map(match => [match[1], match[2]])));
  assert.deepEqual([...resources[0].keys()].sort(), [...resources[1].keys()].sort());
  for (const [name, english] of resources[0]) {
    const chinese = resources[1].get(name);
    assert.ok(english.trim() && chinese.trim(), name);
    assert.deepEqual(english.match(/%\d+\$[sd]/g), chinese.match(/%\d+\$[sd]/g), name);
  }
  for (const binding of activity.matchAll(/R\.string\.((?:connection_|lan_|public_origin_)\w+)/g)) {
    assert.ok(resources.every(locale => locale.has(binding[1])), binding[1]);
  }
  for (const name of ['Localizable', 'InfoPlist']) {
    const english = keys(source(`apps/ios/Resources/en.lproj/${name}.strings`), /"([^"]+)" = "[^"]+";/g);
    assert.equal(english.length, 4);
    assert.deepEqual(english, keys(source(`apps/ios/Resources/zh-Hans.lproj/${name}.strings`), /"([^"]+)" = "[^"]+";/g));
  }
  for (const locale of ['en', 'zh-Hans']) assert.ok(source('apps/ios/project.yml').includes(`Resources/${locale}.lproj`));
  const runtime = source('apps/android/web/android-runtime.js');
  assert.match(runtime, /navigator.language\?\.toLowerCase\(\).startsWith\('zh'\) \? 'zh-CN' : 'en'/);
  assert.match(runtime, /localStorage.getItem\('agentopsdeck.locale'\) \|\| locale/);
  assert.match(runtime, /String\(locale\).toLowerCase\(\).startsWith\('zh'\) \? chinese : english/);
  assert.equal((runtime.match(/alert\(downloadMessage\('[^']+', '[^']+'\)\)/g) ?? []).length, 2);
});

test('NAT-006 source: custom installer labels are bilingual', () => {
  const installer = source('native/windows/installer/packaging/AgentOpsDeck.iss');
  for (const key of ['DesktopShortcut', 'LaunchAOD']) {
    assert.match(installer, new RegExp(`english\\.${key}=.+`));
    assert.match(installer, new RegExp(`chinesesimp\\.${key}=.+`));
    assert.ok(installer.includes(`{cm:${key}}`));
  }
});

test('NAT-007 source: independent version policies do not bless old pins or fabricate a core seal', () => {
  const policies = ['apps/android', 'apps/ios', 'native/windows/installer'].map(path => JSON.parse(source(`${path}/VERSION-POLICY.json`)));
  assert.equal(JSON.parse(source('package.json')).version, '1.0.0');
  for (const policy of policies) {
    assert.equal(policy.coreSourceVersion, '1.0.0');
    assert.equal(policy.status, 'historical-source-scaffold');
    assert.equal(policy.releaseApproved, false);
    assert.equal(policy.sealedCore, null);
    assert.ok(policy.policyEnglish && policy.policyChinese);
  }
  assert.match(source('apps/android/app/build.gradle'), new RegExp(`versionName '${policies[0].wrapperVersion.replaceAll('.', '\\.')}'`));
  assert.match(source('apps/android/app/build.gradle'), new RegExp(`versionCode ${policies[0].wrapperBuild}\\b`));
  assert.ok(source('apps/ios/Config/Client.xcconfig').includes(`MARKETING_VERSION = ${policies[1].wrapperVersion}`));
  assert.ok(source('apps/ios/Config/Client.xcconfig').includes(`CURRENT_PROJECT_VERSION = ${policies[1].wrapperBuild}`));
  assert.equal(policies[2].historicalPinsAreAODReleaseEvidence, false);
  assert.match(source('native/windows/installer/packaging/AgentOpsDeck.iss'), /^#error Native release blocked:/m);
});

test('NAT-PENDING-006 source: Android executors are bounded, blob staging reserves the download slot, and runtime blob reads are streaming-bounded', () => {
  assert.doesNotMatch(activity, /Executors\.newSingleThreadExecutor\(\)/);
  assert.match(activity, /boundedExecutor\(int capacity\)/);
  assert.match(activity, /new ArrayBlockingQueue<>\(capacity\)/);
  assert.match(activity, /blobStagingInProgress\.compareAndSet\(false, true\)/);
  const runtime = source('apps/android/web/android-runtime.js');
  assert.match(runtime, /let blobDownloadBusy = false;/);
  assert.match(runtime, /response\.headers\?\.get\('content-length'\)/);
  assert.match(runtime, /response\.body\.getReader\(\)/);
  assert.match(runtime, /total > MAX_BLOB_BYTES/);
});

test('NAT-PENDING-009 source: iOS DownloadCoordinator tracks failed directory cleanups in reserved byte quota', () => {
  assert.match(coordinator, /failedCleanupBytes: \[URL: Int64\] = \[:\]/);
  assert.match(coordinator, /retainedFailedCleanupBytes/);
  assert.match(coordinator, /removeDirectory\(_ directory: URL, fallbackBytes: Int64 = 0\)/);
  assert.match(coordinator, /retryFailedCleanups\(\)/);
});

test('NAT-PENDING-010 source: iOS Info.plist disables arbitrary loads in favor of local networking and WebViewController checks subframe endpoints', () => {
  const plist = source('apps/ios/Resources/Info.plist');
  assert.match(plist, /<key>NSAllowsArbitraryLoads<\/key><false\/>/);
  assert.match(plist, /<key>NSAllowsLocalNetworking<\/key><true\/>/);
  assert.match(controller, /navigationAction\.targetFrame\?\.isMainFrame == false[\s\S]*?endpoint\.contains\(url\)/);
  assert.doesNotMatch(controller, /!navigationResponse\.isForMainFrame \|\| endpoint\.contains\(url\)/);
});

test('NAT-FINAL-001 source: Android MainActivity invalidates fileCallback on WebView replacement and guards callbacks by current view and generation', () => {
  assert.match(activity, /private int fileCallbackGeneration;/);
  assert.match(activity, /if \(fileCallback != null\) \{\s*fileCallback\.onReceiveValue\(null\);\s*fileCallback = null;\s*\}\s*int generation = \+\+webGeneration;/);
  assert.match(activity, /onPageStarted[\s\S]*?view != currentWebView \|\| view != webView \|\| generation != webGeneration/);
  assert.match(activity, /shouldOverrideUrlLoading[\s\S]*?view != currentWebView \|\| view != webView \|\| generation != webGeneration/);
  assert.match(activity, /onShowFileChooser[\s\S]*?view != currentWebView \|\| view != webView \|\| generation != webGeneration/);
  assert.match(activity, /fileCallbackGeneration = generation;/);
  assert.match(activity, /setDownloadListener[\s\S]*?currentWebView != webView \|\| generation != webGeneration/);
  assert.match(activity, /fileCallbackGeneration == webGeneration && webView != null && !destroyed/);
});

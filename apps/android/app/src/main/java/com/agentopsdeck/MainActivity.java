package com.agentopsdeck;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String SHELL_PATH = "/__agentopsdeck_android__/index.html";
    private static final int PICK_FILE = 10;
    private static final int SAVE_FILE = 11;
    private static final int SPEECH_PERMISSION = 13;
    private static ExecutorService boundedExecutor(int capacity) {
        return new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(capacity), new ThreadPoolExecutor.AbortPolicy());
    }
    private final ExecutorService storageWorker = boundedExecutor(64);
    private final ExecutorService downloadWorker = boundedExecutor(4);
    private final ExecutorService utilityWorker = boundedExecutor(16);
    private final AtomicBoolean blobStagingInProgress = new AtomicBoolean(false);
    private volatile String activeCacheScope;
    private WebView webView;
    private CacheStore cacheStore;
    private SharedPreferences preferences;
    private TextView title;
    private String origin;
    private ValueCallback<Uri[]> fileCallback;
    private int fileCallbackGeneration;
    private File pendingFile;
    private View videoView;
    private WebChromeClient.CustomViewCallback videoCallback;
    private LinearLayout root;
    private volatile int webGeneration;
    private volatile AuthenticatedDownload activeDownload;
    private AlertDialog downloadDialog;
    private volatile int downloadGeneration;
    private int pendingSaveGeneration;
    private boolean savePickerOpen;
    private volatile boolean saveInProgress;
    private NativeVideoPlayer nativeVideo;
    private NativeVoiceRecorder nativeSpeech;
    private final ExecutorService connectionWorker = boundedExecutor(4);
    private final Handler connectionHandler = new Handler(Looper.getMainLooper());
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private AlertDialog connectionDialog;
    private String suggestedOrigin;
    private int connectionGeneration;
    private boolean foreground;
    private boolean destroyed;
    private boolean manualConnectionPending;
    private final Runnable networkChanged = () -> {
        if (foreground && webView != null) selectConnection(false);
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("client", MODE_PRIVATE);
        origin = ServerAddress.normalize(preferences.getString("origin", ServerAddress.DEFAULT));
        String lastLan = preferences.getString("lastLan", "");
        if (ServerAddress.isLan(lastLan) && preferences.getBoolean("lanEnabled", false) && isWifiConnection()) origin = lastLan;
        cacheStore = new CacheStore(this);
        nativeVideo = new NativeVideoPlayer(this);
        nativeSpeech = new NativeVoiceRecorder(this, SPEECH_PERMISSION);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(12), 0, dp(4), 0);
        toolbar.setBackgroundColor(Color.rgb(29, 78, 216));
        title = new TextView(this);
        title.setTextColor(Color.WHITE);
        title.setTextSize(13);
        title.setOnClickListener(view -> showConnectionChoices());
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(42), 1));
        title.setGravity(Gravity.CENTER_VERTICAL);
        Button menu = new Button(this);
        menu.setText("\u22ee");
        menu.setTextColor(Color.WHITE);
        menu.setTextSize(22);
        menu.setBackgroundColor(Color.TRANSPARENT);
        menu.setContentDescription("Client settings");
        menu.setOnClickListener(this::showMenu);
        toolbar.addView(menu, new LinearLayout.LayoutParams(dp(48), dp(42)));
        root.addView(toolbar);
        setContentView(root);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        createWebView();
        scheduleConnectionCheck();
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { scheduleConnectionCheck(); }
            @Override public void onLost(Network network) { scheduleConnectionCheck(); }
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                scheduleConnectionCheck();
            }
        };
        try { connectivity.registerDefaultNetworkCallback(networkCallback); }
        catch (RuntimeException error) { networkCallback = null; }
        if (!preferences.contains("lanEnabled")) root.post(this::editLan);
        root.requestApplyInsets();
    }

    private void scheduleConnectionCheck() {
        connectionHandler.removeCallbacks(networkChanged);
        connectionHandler.postDelayed(networkChanged, 1000);
    }

    private void selectConnection(boolean connect) {
        selectConnection(connect, false);
    }

    private void selectConnection(boolean connect, boolean userRequested) {
        if (destroyed) return;
        if (!connect && !userRequested && (manualConnectionPending
                || (connectionDialog != null && connectionDialog.isShowing()))) return;
        int generation = ++connectionGeneration;
        String publicOrigin = ServerAddress.normalize(preferences.getString("origin", ServerAddress.DEFAULT));
        boolean enabled = preferences.getBoolean("lanEnabled", false);
        String currentOrigin = origin;
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        boolean wifi = capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        if (connect) title.setText("AgentOpsDeck · 正在选择连接…");
        connectionWorker.execute(() -> {
            String selected = ConnectionRouter.select(publicOrigin, enabled, wifi, currentOrigin, ServerProbe::reachable);
            runOnUiThread(() -> {
                if (destroyed || generation != connectionGeneration) return;
                if (connect || webView == null) {
                    if (connectionDialog != null) { connectionDialog.dismiss(); connectionDialog = null; }
                    origin = selected;
                    createWebView();
                } else if (origin.equals(selected)) {
                    suggestedOrigin = null;
                    updateConnectionTitle();
                    if (connectionDialog != null) { connectionDialog.dismiss(); connectionDialog = null; }
                    if (userRequested) Toast.makeText(this, "当前已使用优先线路", Toast.LENGTH_SHORT).show();
                } else {
                    suggestedOrigin = selected;
                    updateConnectionTitle();
                    if (!foreground || !ConnectionRouter.shouldOfferSwitch(origin, selected, userRequested)) return;
                    if (connectionDialog != null) connectionDialog.dismiss();
                    connectionDialog = new AlertDialog.Builder(this).setTitle("切换连接线路？")
                            .setMessage("可切换到 " + selected + "。切换会重新加载页面；请先确认没有正在发送的消息或上传。不会自动重发消息，服务器任务继续运行。")
                            .setNegativeButton("暂不切换", null)
                            .setPositiveButton("切换连接", (dialog, which) -> {
                                origin = selected;
                                createWebView();
                            }).show();
                }
            });
        });
    }

    private void updateConnectionTitle() {
        title.setText("AgentOpsDeck · " + (ServerAddress.isLan(origin) ? "局域网 · " : "公网 · ") + Uri.parse(origin).getHost()
                + (suggestedOrigin == null ? "" : " · 可切换"));
        title.setContentDescription("当前连接 " + origin + "，点击检查并选择线路");
    }

    private boolean isWifiConnection() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    private void showConnectionChoices() {
        if (destroyed || manualConnectionPending) return;
        ++connectionGeneration;
        if (connectionDialog != null) connectionDialog.dismiss();
        String[] choices = ConnectionRouter.manualOrigins(
                preferences.getString("origin", ServerAddress.DEFAULT),
                preferences.getBoolean("lanEnabled", false), isWifiConnection());
        String[] labels = new String[choices.length];
        for (int index = 0; index < choices.length; index++) {
            labels[index] = (choices[index].equals(origin) ? "当前 · " : "")
                    + (ServerAddress.isLan(choices[index]) ? "局域网 · " : "公网 · ") + choices[index];
        }
        connectionDialog = new AlertDialog.Builder(this).setTitle("手动选择连接线路")
                .setItems(labels, (dialog, which) -> confirmConnection(choices[which]))
                .setNegativeButton("取消", null).show();
    }

    private void confirmConnection(String selected) {
        if (selected.equals(origin)) return;
        connectionDialog = new AlertDialog.Builder(this).setTitle("切换连接线路？")
                .setMessage("切换到 " + selected + " 将重新加载页面，请先保存草稿并确认消息发送或上传已结束。不会自动重发消息，服务器任务继续运行。不同地址可能需要单独登录。")
                .setNegativeButton("取消", null)
                .setPositiveButton("切换", (dialog, which) -> connectManually(selected)).show();
    }

    private void connectManually(String selected) {
        if (destroyed || manualConnectionPending) return;
        if (ServerAddress.isLan(selected)
                && (!preferences.getBoolean("lanEnabled", false) || !isWifiConnection())) {
            Toast.makeText(this, "请连接可信 Wi-Fi 并启用局域网连接", Toast.LENGTH_LONG).show();
            return;
        }
        int generation = ++connectionGeneration;
        manualConnectionPending = true;
        title.setText("AgentOpsDeck · 正在检查所选线路…");
        connectionWorker.execute(() -> {
            boolean reachable = !ServerAddress.isLan(selected) || ServerProbe.reachable(selected);
            runOnUiThread(() -> {
                manualConnectionPending = false;
                if (destroyed || generation != connectionGeneration) return;
                updateConnectionTitle();
                if (!foreground) return;
                if (!reachable || (ServerAddress.isLan(selected) && !isWifiConnection())) {
                    Toast.makeText(this, "所选局域网线路暂不可达，保留当前连接", Toast.LENGTH_LONG).show();
                    return;
                }
                origin = selected;
                createWebView();
            });
        });
    }

    private void editLan() {
        boolean enabled = preferences.getBoolean("lanEnabled", false);
        new AlertDialog.Builder(this).setTitle("局域网优先连接")
                .setMessage("仅在可信 Wi-Fi 下尝试电脑地址：\n192.0.2.24:8790\n192.0.2.82:8790\n\n不可达时使用公网 HTTPS 地址。局域网 HTTP 不加密，请确认这两个地址属于你的 AgentOpsDeck 电脑。首次局域网连接需要单独登录，不会复制公网登录凭据或缓存。\n\n启动和手动重连自动选择；使用中不弹窗打断，不自动切换。顶部显示可切换时，点击顶部连接信息手动选择；不会重发操作。电脑 IP 变化后需更新地址白名单，建议在路由器固定 IP。\n\n当前：" + (enabled ? "已启用" : "未启用"))
                .setNegativeButton("仅用公网", (dialog, which) -> {
                    preferences.edit().putBoolean("lanEnabled", false).apply();
                    selectConnection(webView == null, true);
                })
                .setNeutralButton("取消", null)
                .setPositiveButton("信任并启用", (dialog, which) -> {
                    preferences.edit().putBoolean("lanEnabled", true).apply();
                    selectConnection(webView == null, true);
                }).show();
    }

    private void createWebView() {
        cancelDownloads();
        ++connectionGeneration;
        activeCacheScope = null;
        suggestedOrigin = null;
        if (ServerAddress.isLan(origin)) preferences.edit().putString("lastLan", origin).apply();
        nativeVideo.close();
        nativeSpeech.cancel();
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        int generation = ++webGeneration;
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
        }
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString() + " AgentOpsDeckAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "AgentOpsDeckNative", Collections.singleton(origin),
                    (view, message, sourceOrigin, mainFrame, reply) -> {
                        if (!mainFrame || view != webView || generation != webGeneration || !origin.equals(sourceOrigin.toString())) return;
                        String data = message.getData();
                        if (data == null || data.length() > 36 * 1024 * 1024) return;
                        if (data.length() <= 2048) {
                            try {
                                JSONObject request = new JSONObject(data);
                                String type = request.optString("type");
                                if (type.equals("speech.start") || type.equals("speech.stop") || type.equals("speech.abort") || type.equals("speech.finish")) {
                                    if (!destroyed) nativeSpeech.handle(request, response -> {
                                        if (generation == webGeneration && !destroyed) reply.postMessage(response);
                                    });
                                    return;
                                }
                            } catch (org.json.JSONException ignored) {}
                        }
                        boolean isBlobDownload = data.startsWith("{\"type\":\"download.blob\"") || data.contains("\"type\":\"download.blob\"");
                        if (isBlobDownload) {
                            if (activeDownload != null || pendingFile != null || savePickerOpen || saveInProgress || downloadDialog != null
                                    || !blobStagingInProgress.compareAndSet(false, true)) {
                                Toast.makeText(this, getString(com.agentopsdeck.R.string.download_busy), Toast.LENGTH_SHORT).show();
                                return;
                            }
                        }
                        String requestOrigin = origin;
                        int requestDownloadGeneration = downloadGeneration;
                        ExecutorService worker = data.startsWith("{\"type\":\"crypto.sha256\"") || isBlobDownload
                                ? utilityWorker : storageWorker;
                        try {
                            worker.execute(() -> {
                                if (generation != webGeneration) {
                                    if (isBlobDownload) blobStagingInProgress.set(false);
                                    return;
                                }
                                try {
                                    JSONObject request = new JSONObject(data);
                                    String type = request.getString("type");
                                    if (type.equals("cache.scope")) {
                                    String next = request.optString("scope", "");
                                    if (!next.matches("[a-f0-9]{64}")) next = null;
                                    if (!java.util.Objects.equals(activeCacheScope, next)) {
                                        cancelDownloads();
                                    }
                                    if (activeCacheScope != null && !activeCacheScope.equals(next)) {
                                        cacheStore.clearAll();
                                        runOnUiThread(() -> nativeVideo.clearCache());
                                    }
                                    activeCacheScope = next;
                                } else if (type.equals("cache.get") || type.equals("cache.write") || type.equals("cache.clear")) {
                                    String scope = request.optString("scope", "");
                                    if (!scope.equals(activeCacheScope == null ? "" : activeCacheScope)) throw new IllegalStateException("Cache account changed");
                                    JSONObject result = new JSONObject().put("type", "cache.result").put("id", request.getString("id"));
                                    if (type.equals("cache.get")) result.put("value", cacheStore.read(requestOrigin, request.getString("key"), activeCacheScope));
                                    else if (type.equals("cache.write")) cacheStore.apply(requestOrigin, request.getJSONArray("changes"), activeCacheScope);
                                    else { cancelDownloads(); cacheStore.clearAll(); runOnUiThread(() -> nativeVideo.clearCache()); }
                                    String response = result.toString();
                                    runOnUiThread(() -> { if (generation == webGeneration) reply.postMessage(response); });
                                } else if (type.equals("crypto.sha256")) {
                                    String id = request.getString("id");
                                    if (id.length() > 64) return;
                                    byte[] bytes = android.util.Base64.decode(request.getString("base64"), android.util.Base64.DEFAULT);
                                    if (bytes.length > 24 * 1024 * 1024) return;
                                    byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes);
                                    String response = new JSONObject().put("type", "crypto.result").put("id", id)
                                            .put("base64", android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP)).toString();
                                    runOnUiThread(() -> { if (generation == webGeneration) reply.postMessage(response); });
                                } else if (type.equals("download.blob")) {
                                    if (!isBlobDownload && (activeDownload != null || pendingFile != null || savePickerOpen || saveInProgress || downloadDialog != null
                                            || !blobStagingInProgress.compareAndSet(false, true))) {
                                        throw new IllegalStateException("Download busy");
                                    }
                                    try {
                                        if (generation != webGeneration || requestDownloadGeneration != downloadGeneration
                                                || activeDownload != null || pendingFile != null || savePickerOpen || saveInProgress || downloadDialog != null) {
                                            throw new IllegalStateException("Download busy");
                                        }
                                        String encoded = request.getString("base64");
                                        if (encoded.length() > 32 * 1024 * 1024) throw new IllegalArgumentException("File exceeds 24 MB");
                                        byte[] bytes = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT);
                                        if (bytes.length > 24 * 1024 * 1024) throw new IllegalArgumentException("File exceeds 24 MB");
                                        File file = File.createTempFile("download-", ".tmp", getCacheDir());
                                        try (OutputStream output = new FileOutputStream(file)) { output.write(bytes); }
                                        catch (Exception error) { file.delete(); throw error; }
                                        String name = request.optString("name", "download");
                                        String mime = request.optString("mime", "application/octet-stream");
                                        runOnUiThread(() -> {
                                            try {
                                                if (generation == webGeneration && requestDownloadGeneration == downloadGeneration
                                                        && !destroyed && !isFinishing()) saveFile(file, name, mime);
                                                else file.delete();
                                            } finally {
                                                blobStagingInProgress.set(false);
                                            }
                                        });
                                    } catch (Exception error) {
                                        blobStagingInProgress.set(false);
                                        throw error;
                                    }
                                } else if (type.equals("client.ready")) {
                                    runOnUiThread(() -> { if (generation == webGeneration) updateConnectionTitle(); });
                                } else if (type.equals("client.metrics")) {
                                    JSONObject supplied = request.getJSONObject("metrics"), safe = new JSONObject();
                                    for (String key : new String[]{"apiReads", "notModified", "failures", "moduleReadyMs", "hits", "misses", "reads", "writes", "retries", "readMs"}) {
                                        long value = supplied.optLong(key, 0);
                                        safe.put(key, Math.max(0, Math.min(value, 86400000)));
                                    }
                                    preferences.edit().putString("performance", safe.toString()).apply();
                                } else if (type.equals("video.play")) {
                                    Uri videoUrl = Uri.parse(resourceUrl(request.getString("url"), requestOrigin));
                                    if (!sameOrigin(videoUrl) || videoUrl.getUserInfo() != null) return;
                                    String name = request.optString("name", "Video");
                                    runOnUiThread(() -> {
                                        if (generation != webGeneration) return;
                                        nativeVideo.open(videoUrl.toString(), name, CookieManager.getInstance().getCookie(origin),
                                                webView.getSettings().getUserAgentString(), activeCacheScope);
                                    });
                                }
                                } catch (Exception error) {
                                    if (isBlobDownload) blobStagingInProgress.set(false);
                                    try {
                                        JSONObject failed = new JSONObject(data);
                                        if (failed.optString("type").startsWith("cache.")) {
                                            String response = new JSONObject().put("type", "cache.result").put("id", failed.optString("id"))
                                                    .put("error", "Local cache operation failed").toString();
                                            runOnUiThread(() -> { if (generation == webGeneration) reply.postMessage(response); });
                                        } else runOnUiThread(() -> Toast.makeText(this, "Local operation failed; please retry", Toast.LENGTH_LONG).show());
                                    } catch (org.json.JSONException ignored) {}
                                }
                            });
                        } catch (RejectedExecutionException rejected) {
                            if (isBlobDownload) blobStagingInProgress.set(false);
                        }
                    });
        }
        WebView currentWebView = webView;
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (view != currentWebView || view != webView || generation != webGeneration) return;
                nativeSpeech.cancel();
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("http".equalsIgnoreCase(url.getScheme()) && !sameOrigin(url)) {
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
                            new ByteArrayInputStream(new byte[0]));
                }
                if (!sameOrigin(url) || !request.getMethod().equals("GET")) return null;
                String path = url.getPath();
                if (path == null || path.contains("..") || path.indexOf('\\') >= 0) return null;
                if (path.equals("/android-connection.mjs")) {
                    String config = "export const publicOrigin=" + JSONObject.quote(preferences.getString("origin", ServerAddress.DEFAULT))
                            + ";export const lanOrigins=" + new org.json.JSONArray(java.util.Arrays.asList(ServerAddress.LAN_ORIGINS)) + ";";
                    return new WebResourceResponse("text/javascript", "UTF-8", 200, "OK",
                            Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(config.getBytes(StandardCharsets.UTF_8)));
                }
                if (path.equals(SHELL_PATH)) return asset("index.html", "text/html");
                if (path.startsWith("/assets/") || path.equals("/android-runtime.js") || path.equals("/android-cache.mjs") || path.equals("/android-lan-crypto.mjs") || path.equals("/android-resource-routing.mjs") || path.equals("/android-speech.mjs")
                        || path.equals("/manifest.webmanifest") || path.startsWith("/pwa-icon")) {
                    return asset(path.substring(1), mimeType(path));
                }
                return null;
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (view != currentWebView || view != webView || generation != webGeneration) return true;
                Uri url = Uri.parse(resourceUrl(request.getUrl().toString(), origin));
                if (!request.isForMainFrame()) return false;
                if (sameOrigin(url)) {
                    if (url.getPath() != null && url.getPath().startsWith("/api/")) {
                        download(url.toString(), null, null);
                        return true;
                    }
                    if (!SHELL_PATH.equals(url.getPath())) {
                        view.loadUrl(origin + SHELL_PATH + (url.getEncodedFragment() == null ? "" : "#" + url.getEncodedFragment()));
                        return true;
                    }
                    return false;
                }
                openExternal(url);
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (view != currentWebView || view != webView || generation != webGeneration) {
                    if (callback != null) callback.onReceiveValue(null);
                    return false;
                }
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                fileCallbackGeneration = generation;
                try { startActivityForResult(params.createIntent(), PICK_FILE); }
                catch (ActivityNotFoundException error) { fileCallback.onReceiveValue(null); fileCallback = null; }
                return true;
            }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (videoView != null) { callback.onCustomViewHidden(); return; }
                videoView = view;
                videoCallback = callback;
                root.setVisibility(View.GONE);
                addContentView(view, new android.view.ViewGroup.LayoutParams(-1, -1));
            }
            @Override public void onHideCustomView() { hideVideo(); }
        });
        webView.setDownloadListener((url, userAgent, disposition, mime, size) -> {
            if (currentWebView != webView || generation != webGeneration) return;
            download(url, disposition, mime);
        });
        root.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        updateConnectionTitle();
        webView.loadUrl(origin + SHELL_PATH);
    }

    private WebResourceResponse asset(String name, String mime) {
        try {
            InputStream stream = getAssets().open("web/" + name);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", name.startsWith("assets/") ? "private, max-age=31536000, immutable" : "no-cache");
            headers.put("X-Content-Type-Options", "nosniff");
            if (mime.equals("text/html")) {
                headers.put("Content-Security-Policy", "object-src 'none'; base-uri 'self'; form-action 'self'");
            }
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream);
        } catch (Exception error) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(),
                    new ByteArrayInputStream("Missing bundled asset".getBytes(StandardCharsets.UTF_8)));
        }
    }

    private boolean sameOrigin(Uri url) {
        try { return ServerAddress.normalizeConnection(url.buildUpon().path("").query(null).fragment(null).build().toString()).equals(origin); }
        catch (IllegalArgumentException error) { return false; }
    }

    private String resourceUrl(String url, String currentOrigin) {
        return ResourceAddress.route(url, currentOrigin, preferences.getString("origin", ServerAddress.DEFAULT));
    }

    private static String mimeType(String path) {
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".webmanifest")) return "application/manifest+json";
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(path));
        return mime == null ? "application/octet-stream" : mime;
    }

    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add("Server address");
        menu.getMenu().add("局域网优先 / 连接设置");
        menu.getMenu().add("手动选择连接线路");
        menu.getMenu().add("Reconnect / reload");
        menu.getMenu().add("Open in browser");
        menu.getMenu().add("性能与缓存");
        menu.getMenu().add("Clear local data and sign out");
        menu.getMenu().add("About / offline behavior");
        menu.getMenu().add(0, 1001, 0, com.agentopsdeck.R.string.cancel_downloads);
        menu.setOnMenuItemClickListener(item -> {
            if (item.getItemId() == 1001) { cancelDownloads(); return true; }
            switch (item.getTitle().toString()) {
                case "Server address": editServer(); break;
                case "局域网优先 / 连接设置": editLan(); break;
                case "手动选择连接线路": showConnectionChoices(); break;
                case "Reconnect / reload":
                    new AlertDialog.Builder(this).setTitle("重新选择连接并加载？")
                            .setMessage("请先确认消息发送或上传已结束。不会自动重发操作，服务器任务不受影响。")
                            .setNegativeButton("取消", null)
                            .setPositiveButton("重连", (dialog, which) -> selectConnection(true)).show();
                    break;
                case "Open in browser": openExternal(Uri.parse(origin)); break;
                case "性能与缓存": showPerformance(); break;
                case "Clear local data and sign out": clearLocalData(); break;
                default:
                    new AlertDialog.Builder(this).setTitle("AgentOpsDeck " + BuildConfig.VERSION_NAME)
                            .setMessage("Bundled AgentOpsDeck web UI with native SQLite history cache. Agent execution stays on your server.\n\nForeground: existing event stream and adaptive refresh. Background: no always-on connection or push notification promise. Reopening reconnects automatically.\n\nSign in using the existing access key. Passkeys depend on WebView and server domain support. Clearing local data never deletes server sessions.")
                            .setPositiveButton("OK", null).show();
            }
            return true;
        });
        menu.show();
    }

    private void editServer() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(preferences.getString("origin", ServerAddress.DEFAULT));
        input.setPadding(dp(20), dp(16), dp(20), dp(16));
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("HTTPS server address").setView(input)
                .setMessage("Connect to your existing AgentOpsDeck backend. No backend changes are required.")
                .setNegativeButton("Cancel", null).setPositiveButton("Connect", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                String next = ServerAddress.normalize(input.getText().toString());
                if (!preferences.getString("origin", ServerAddress.DEFAULT).equals(next)) {
                    preferences.edit().putString("origin", next).putBoolean("lanEnabled", false).apply();
                    selectConnection(false, true);
                }
                dialog.dismiss();
            } catch (IllegalArgumentException error) { input.setError(error.getMessage()); }
        }));
        dialog.show();
    }

    private void clearLocalData() {
        new AlertDialog.Builder(this).setTitle("Clear local data?")
                .setMessage("Remove this app's cached chats, browser storage and sign-in cookies. Server sessions and running agents are not deleted.")
                .setNegativeButton("Cancel", null).setPositiveButton("Clear", (dialog, which) -> {
                    cancelDownloads();
                    ++webGeneration;
                    if (webView == null) return;
                    webView.stopLoading();
                    root.removeView(webView);
                    webView.destroy();
                    webView = null;
                    nativeVideo.clearCache();
                    activeCacheScope = null;
                    storageWorker.execute(() -> {
                        cacheStore.clearAll();
                        runOnUiThread(() -> {
                            WebStorage.getInstance().deleteAllData();
                            CookieManager.getInstance().removeAllCookies(ignored -> {
                                CookieManager.getInstance().flush();
                                createWebView();
                            });
                        });
                    });
                }).show();
    }

    private void showPerformance() {
        if (webView != null) webView.evaluateJavascript("window.dispatchEvent(new Event('agentopsdeck:android-metrics'))", null);
        storageWorker.execute(() -> {
            try {
                JSONObject stats = cacheStore.stats();
                JSONObject metrics = new JSONObject(preferences.getString("performance", "{}"));
                String text = "本次界面模块就绪：" + metrics.optLong("moduleReadyMs") + " ms（不含系统启动）"
                        + "\nAPI GET：" + metrics.optLong("apiReads") + "，304：" + metrics.optLong("notModified")
                        + "\n磁盘读取：" + metrics.optLong("reads") + "，累计 " + metrics.optLong("readMs") + " ms"
                        + "\n内存命中：" + metrics.optLong("hits") + "，写入重试：" + metrics.optLong("retries")
                        + "\n缓存条目：" + stats.optLong("entries") + "，消息行：" + stats.optLong("messages")
                        + "\n聊天缓存：" + stats.optLong("bytes") / (1024 * 1024) + " / 96 MB"
                        + "\n媒体缓存上限：512 MB，按最近使用淘汰。"
                        + "\n仅在本机保存计数，不记录消息正文、链接或凭据。";
                runOnUiThread(() -> { if (!destroyed) new AlertDialog.Builder(this).setTitle("性能与缓存")
                        .setMessage(text).setNegativeButton("关闭", null)
                        .setPositiveButton("清理媒体缓存", (dialog, which) -> nativeVideo.clearCache()).show(); });
            } catch (Exception ignored) {}
        });
    }

    private void download(String url, String disposition, String mime) {
        startDownload(resourceUrl(url, origin), disposition, mime);
    }

    private void startDownload(String url, String disposition, String mime) {
        Uri uri = Uri.parse(url);
        if (!sameOrigin(uri)) { openExternal(uri); return; }
        if (activeDownload != null || pendingFile != null || savePickerOpen || saveInProgress || downloadDialog != null || blobStagingInProgress.get()) {
            Toast.makeText(this, getString(com.agentopsdeck.R.string.download_busy), Toast.LENGTH_SHORT).show();
            return;
        }
        AuthenticatedDownload transfer = new AuthenticatedDownload();
        activeDownload = transfer;
        String cookie = CookieManager.getInstance().getCookie(url);
        String userAgent = webView.getSettings().getUserAgentString();
        int generation = webGeneration;
        int identity = downloadGeneration;
        java.util.function.BooleanSupplier current = () -> generation == webGeneration && identity == downloadGeneration
                && java.util.Objects.equals(cookie, CookieManager.getInstance().getCookie(url));
        java.util.function.Function<String, String> cookies = CookieManager.getInstance()::getCookie;
        Toast.makeText(this, getString(com.agentopsdeck.R.string.download_checking), Toast.LENGTH_SHORT).show();
        downloadWorker.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = transfer.open(url, cookies, userAgent, "HEAD", current);
                int status = connection.getResponseCode();
                if (status == 405 || status == 501) {
                    connection.disconnect();
                    connection = transfer.open(url, cookies, userAgent, "GET", current);
                    status = connection.getResponseCode();
                }
                if (status < 200 || status >= 300) throw new IllegalStateException("Download HTTP " + status);
                if (connection.getContentLengthLong() > AuthenticatedDownload.MAX_BYTES) throw new IllegalStateException("Download exceeds limit");
                String header = connection.getHeaderField("Content-Disposition");
                String contentType = connection.getContentType();
                String resolvedDisposition = header != null ? header : disposition;
                String resolvedMime = contentType != null ? contentType.split(";", 2)[0].trim() : mime;
                if (resolvedDisposition == null && ("text/html".equalsIgnoreCase(resolvedMime) || "application/json".equalsIgnoreCase(resolvedMime))) {
                    throw new IllegalStateException("Server returned a page rather than a file");
                }
                String name = DownloadFileName.resolve(url, resolvedDisposition, URLUtil.guessFileName(url, resolvedDisposition, resolvedMime));
                String extension = name.lastIndexOf('.') >= 0 ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(java.util.Locale.ROOT) : "";
                String inferredMime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
                if (inferredMime != null && (resolvedMime == null || resolvedMime.equalsIgnoreCase("application/octet-stream"))) resolvedMime = inferredMime;
                String finalMime = resolvedMime;
                runOnUiThread(() -> {
                    if (current.getAsBoolean() && !isFinishing() && !isDestroyed()) confirmDownload(url, name, finalMime, cookie, userAgent, transfer, current);
                });
            } catch (Exception error) {
                if (activeDownload == transfer) activeDownload = null;
                runOnUiThread(() -> {
                    if (current.getAsBoolean() && !isFinishing() && !isDestroyed()) Toast.makeText(this, getString(com.agentopsdeck.R.string.download_failed), Toast.LENGTH_LONG).show();
                });
            } finally { if (connection != null) connection.disconnect(); transfer.disconnect(); }
        });
    }

    private void confirmDownload(String url, String name, String mime, String cookie, String userAgent,
                                 AuthenticatedDownload transfer, java.util.function.BooleanSupplier current) {
        downloadDialog = new AlertDialog.Builder(this).setTitle(com.agentopsdeck.R.string.download_title)
                .setMessage(name + "\n\n" + getString(com.agentopsdeck.R.string.download_retention))
                .setNegativeButton(android.R.string.cancel, (dialog, which) -> cancelDownloads())
                .setPositiveButton(com.agentopsdeck.R.string.download_action, (dialog, which) -> {
                    if (!current.getAsBoolean() || !java.util.Objects.equals(cookie, CookieManager.getInstance().getCookie(url))) {
                        cancelDownloads();
                        return;
                    }
                    downloadDialog = null;
                    Toast.makeText(this, com.agentopsdeck.R.string.download_started, Toast.LENGTH_SHORT).show();
                    downloadWorker.execute(() -> {
                        try {
                            File file = transfer.fetch(url, CookieManager.getInstance()::getCookie, userAgent, getCacheDir(), current);
                            runOnUiThread(() -> {
                                if (activeDownload == transfer) activeDownload = null;
                                if (current.getAsBoolean() && !isFinishing() && !isDestroyed()
                                        && java.util.Objects.equals(cookie, CookieManager.getInstance().getCookie(url))) {
                                    saveFile(file, name, mime == null ? "application/octet-stream" : mime);
                                } else file.delete();
                            });
                        } catch (Exception error) {
                            if (activeDownload == transfer) activeDownload = null;
                            runOnUiThread(() -> {
                                if (current.getAsBoolean() && !isDestroyed()) Toast.makeText(this, com.agentopsdeck.R.string.download_failed, Toast.LENGTH_LONG).show();
                            });
                        }
                    });
                }).setOnCancelListener(dialog -> cancelDownloads()).show();
    }

    private void cancelDownloads() {
        ++downloadGeneration;
        blobStagingInProgress.set(false);
        AuthenticatedDownload transfer = activeDownload;
        activeDownload = null;
        if (transfer != null) transfer.cancel();
        runOnUiThread(() -> {
            if (downloadDialog != null) { downloadDialog.dismiss(); downloadDialog = null; }
            if (pendingFile != null) { pendingFile.delete(); pendingFile = null; }
        });
    }

    private void saveFile(File file, String name, String mime) {
        if (pendingFile != null || savePickerOpen || saveInProgress) {
            file.delete();
            Toast.makeText(this, "Finish the current save first", Toast.LENGTH_SHORT).show();
            return;
        }
        pendingFile = file;
        pendingSaveGeneration = downloadGeneration;
        savePickerOpen = true;
        String safeName = DownloadFileName.resolve("", null, name);
        if (safeName.length() > 200) safeName = safeName.substring(0, 200);
        String safeMime = mime != null && mime.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+") ? mime : "application/octet-stream";
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(safeMime).putExtra(Intent.EXTRA_TITLE, safeName);
        try { startActivityForResult(intent, SAVE_FILE); }
        catch (ActivityNotFoundException error) { pendingFile.delete(); pendingFile = null; savePickerOpen = false; }
    }

    private void openExternal(Uri uri) {
        if (uri.getUserInfo() != null) return;
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())
                && !"mailto".equalsIgnoreCase(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show(); }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == SPEECH_PERMISSION) {
            nativeSpeech.permissionResult(results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED);
            return;
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        nativeSpeech.activityResult(requestCode, resultCode, data);
        if (requestCode == PICK_FILE && fileCallback != null) {
            ValueCallback<Uri[]> callback = fileCallback;
            fileCallback = null;
            if (fileCallbackGeneration == webGeneration && webView != null && !destroyed) {
                callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            } else {
                callback.onReceiveValue(null);
            }
        }
        if (requestCode == SAVE_FILE) savePickerOpen = false;
        if (requestCode == SAVE_FILE && pendingFile != null) {
            int identity = pendingSaveGeneration;
            File source = pendingFile;
            pendingFile = null;
            if (identity != downloadGeneration || resultCode != RESULT_OK || data == null || data.getData() == null) { source.delete(); return; }
            Uri destination = data.getData();
            saveInProgress = true;
            storageWorker.execute(() -> {
                try (InputStream input = new FileInputStream(source); OutputStream output = getContentResolver().openOutputStream(destination)) {
                    if (output == null) throw new IllegalStateException("No output stream");
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (identity != downloadGeneration) throw new IllegalStateException("Save cancelled");
                        output.write(buffer, 0, count);
                    }
                    runOnUiThread(() -> Toast.makeText(this, "File saved", Toast.LENGTH_SHORT).show());
                } catch (Exception error) {
                    runOnUiThread(() -> Toast.makeText(this, "Unable to save file", Toast.LENGTH_LONG).show());
                } finally { source.delete(); saveInProgress = false; }
            });
        }
    }

    private void hideVideo() {
        if (videoView == null) return;
        ((android.view.ViewGroup) videoView.getParent()).removeView(videoView);
        videoView = null;
        root.setVisibility(View.VISIBLE);
        videoCallback.onCustomViewHidden();
        videoCallback = null;
    }

    @Override public void onBackPressed() {
        if (videoView != null) hideVideo();
        else if (webView != null && webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true);
    }

    @Override protected void onPause() {
        foreground = false;
        connectionHandler.removeCallbacks(networkChanged);
        nativeVideo.pause();
        if (webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('agentopsdeck:android-pause'))", null);
            webView.onPause();
        }
        nativeSpeech.pause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (webView != null) scheduleConnectionCheck();
        if (nativeVideo != null) nativeVideo.resume();
        if (nativeSpeech != null) nativeSpeech.resume();
        if (webView != null) {
            webView.onResume();
            webView.evaluateJavascript("window.dispatchEvent(new Event('agentopsdeck:android-resume'))", null);
        }
    }

    @Override protected void onDestroy() {
        cancelDownloads();
        destroyed = true;
        ++connectionGeneration;
        connectionHandler.removeCallbacksAndMessages(null);
        if (connectionDialog != null) connectionDialog.dismiss();
        if (networkCallback != null) connectivity.unregisterNetworkCallback(networkCallback);
        connectionWorker.shutdownNow();
        nativeVideo.destroy();
        nativeSpeech.destroy();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (pendingFile != null) pendingFile.delete();
        ++webGeneration;
        if (webView != null) webView.destroy();
        storageWorker.execute(cacheStore::close);
        storageWorker.shutdown();
        downloadWorker.shutdownNow();
        utilityWorker.shutdownNow();
        super.onDestroy();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}

package com.agentopsdeck;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;
import java.io.File;
import java.net.HttpURLConnection;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class NativeVideoPlayer {
    private static SimpleCache sharedCache;
    private final Activity activity;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final SharedPreferences preferences;
    private volatile int generation;
    private volatile HttpURLConnection connection;
    private Dialog dialog;
    private ExoPlayer player;
    private String playbackKey;
    private boolean foreground = true;
    private boolean destroyed;

    NativeVideoPlayer(Activity activity) {
        this.activity = activity;
        preferences = activity.getSharedPreferences("media-cache", Context.MODE_PRIVATE);
        File[] leftovers = activity.getCacheDir().listFiles((directory, name) -> name.startsWith("video-") && name.endsWith(".media"));
        if (leftovers != null) for (File file : leftovers) file.delete();
    }

    private static synchronized SimpleCache cache(Context context) {
        if (sharedCache == null) sharedCache = new SimpleCache(new File(context.getCacheDir(), "media-v2"),
                new LeastRecentlyUsedCacheEvictor(512L * 1024 * 1024), new StandaloneDatabaseProvider(context.getApplicationContext()));
        return sharedCache;
    }

    void open(String url, String name, String cookie, String userAgent, String scope) {
        if (destroyed) return;
        close();
        int request = generation;
        FrameLayout frame = showDialog(name);
        TextView status = new TextView(activity);
        status.setTextColor(Color.WHITE); status.setBackgroundColor(Color.BLACK); status.setGravity(Gravity.CENTER);
        status.setText("正在校验视频权限与版本…");
        frame.addView(status, new FrameLayout.LayoutParams(-1, -1));
        worker.execute(() -> {
            HttpURLConnection active = null;
            try {
                if (request != generation) return;
                active = PrivateMediaDataSource.connect(url, cookie, userAgent); connection = active;
                active.setRequestProperty("Range", "bytes=0-0");
                int code = active.getResponseCode();
                if (code != 200 && code != 206) throw new IllegalStateException("视频请求失败（HTTP " + code + "），请检查登录或链接。");
                String type = active.getContentType();
                if (type == null || !(type.startsWith("video/") || type.startsWith("application/octet-stream"))) throw new IllegalStateException("返回的不是视频，请检查链接。");
                long length = active.getContentLengthLong();
                if (code == 206) {
                    Matcher match = Pattern.compile("bytes 0-0/(\\d+)").matcher(String.valueOf(active.getHeaderField("Content-Range")));
                    if (!match.matches()) throw new IllegalStateException("视频分段响应无效，请重试。");
                    length = Long.parseLong(match.group(1));
                }
                String etag = active.getHeaderField("ETag"), modified = active.getHeaderField("Last-Modified");
                String validator = etag != null ? "etag:" + etag : modified != null && length > 0 ? "modified:" + modified + ":" + length : "open:" + java.util.UUID.randomUUID();
                String key = MediaCacheKey.create(url, scope, cookie, validator);
                SimpleCache mediaCache = cache(activity);
                active.disconnect();
                activity.runOnUiThread(() -> {
                    if (request != generation) return;
                    playbackKey = key;
                    PlayerView view = new PlayerView(activity);
                    view.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
                    frame.addView(view, 0, new FrameLayout.LayoutParams(-1, -1));
                    CacheDataSource.Factory source = new CacheDataSource.Factory().setCache(mediaCache)
                            .setUpstreamDataSourceFactory(() -> new PrivateMediaDataSource(url, cookie, userAgent, etag, modified))
                            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
                    ExoPlayer target = new ExoPlayer.Builder(activity).build(); player = target;
                    view.setPlayer(target);
                    target.addListener(new Player.Listener() {
                        @Override public void onPlaybackStateChanged(int state) {
                            if (player != target) return;
                            if (state == Player.STATE_READY || state == Player.STATE_ENDED) status.setVisibility(View.GONE);
                        }
                        @Override public void onPlayerError(PlaybackException error) {
                            if (player != target) return;
                            status.setVisibility(View.VISIBLE);
                            status.setText("视频加载失败（" + error.getErrorCodeName() + "）。请检查网络或下载后播放。");
                        }
                    });
                    status.setText("正在读取视频，可复用已缓存片段…");
                    target.setMediaSource(new ProgressiveMediaSource.Factory(source).createMediaSource(
                            new MediaItem.Builder().setUri(url).setCustomCacheKey(key).build()));
                    target.seekTo(savedPosition(key));
                    target.prepare(); target.setPlayWhenReady(foreground);
                });
            } catch (Exception error) {
                activity.runOnUiThread(() -> { if (request == generation) status.setText(error instanceof IllegalStateException ? error.getMessage() : "视频连接失败，请检查网络并重试。"); });
            } finally {
                if (active != null) active.disconnect();
                if (connection == active) connection = null;
            }
        });
    }

    private long savedPosition(String key) {
        try { return new JSONObject(preferences.getString("positions", "{}")).optLong(key, 0); }
        catch (Exception ignored) { return 0; }
    }

    private void savePosition() {
        if (player == null || playbackKey == null) return;
        try {
            JSONObject positions = new JSONObject(preferences.getString("positions", "{}"));
            long position = player.getCurrentPosition(), duration = player.getDuration();
            if (duration > 0 && duration - position < 1500) position = 0;
            positions.remove(playbackKey);
            if (positions.length() >= 80) positions.remove(positions.keys().next());
            positions.put(playbackKey, position);
            preferences.edit().putString("positions", positions.toString()).apply();
        } catch (Exception ignored) {}
    }

    private FrameLayout showDialog(String name) {
        dialog = new Dialog(activity, android.R.style.Theme_Material_NoActionBar);
        LinearLayout layout = new LinearLayout(activity); layout.setOrientation(LinearLayout.VERTICAL); layout.setBackgroundColor(Color.BLACK);
        Button close = new Button(activity); close.setText("关闭视频 · " + name); close.setOnClickListener(view -> close()); layout.addView(close);
        FrameLayout frame = new FrameLayout(activity); layout.addView(frame, new LinearLayout.LayoutParams(-1, 0, 1));
        dialog.setContentView(layout); dialog.setOnDismissListener(ignored -> close());
        dialog.show();
        if (dialog.getWindow() != null) {
            dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); dialog.getWindow().setLayout(-1, -1);
        }
        return frame;
    }

    void pause() { foreground = false; savePosition(); if (player != null) player.pause(); }
    void resume() { foreground = true; }
    void close() {
        ++generation;
        HttpURLConnection active = connection; if (active != null) active.disconnect();
        savePosition();
        if (player != null) { player.release(); player = null; }
        playbackKey = null;
        Dialog previous = dialog; dialog = null;
        if (previous != null) { previous.setOnDismissListener(null); previous.dismiss(); }
    }

    void clearCache() {
        if (destroyed) return;
        close(); preferences.edit().clear().apply();
        worker.execute(() -> {
            try {
                SimpleCache mediaCache = cache(activity);
                for (String key : mediaCache.getKeys()) mediaCache.removeResource(key);
            } catch (Exception ignored) {}
        });
    }

    void destroy() { destroyed = true; close(); worker.shutdown(); }
}

package com.agentopsdeck;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.widget.FrameLayout;
import androidx.media3.common.MediaItem;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.Assume;
import org.json.JSONObject;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public class NativeVideoPlayerTest {
    @Test public void authenticatedBridgeStreamsAndRetainsCache() throws Exception {
        String url = InstrumentationRegistry.getArguments().getString("videoUrl");
        Assume.assumeNotNull(url);
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        Field nativeField = MainActivity.class.getDeclaredField("nativeVideo");
        Field webField = MainActivity.class.getDeclaredField("webView");
        Field videoField = NativeVideoPlayer.class.getDeclaredField("player");
        Field cacheField = NativeVideoPlayer.class.getDeclaredField("sharedCache");
        for (Field field : new Field[] {nativeField, webField, videoField, cacheField}) field.setAccessible(true);
        NativeVideoPlayer player = (NativeVideoPlayer) nativeField.get(activity);
        try {
            Thread.sleep(5000);
            String packet = new JSONObject().put("type", "video.play").put("url", url).put("name", "Existing video test").toString();
            instrumentation.runOnMainSync(() -> {
                try { ((WebView) webField.get(activity)).evaluateJavascript("window.AgentOpsDeckNative.postMessage(" + JSONObject.quote(packet) + ")", null); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
            AtomicInteger position = new AtomicInteger();
            for (int attempt = 0; attempt < 120 && position.get() < 300; attempt++) {
                Thread.sleep(1000);
                instrumentation.runOnMainSync(() -> {
                    try {
                        ExoPlayer target = (ExoPlayer) videoField.get(player);
                        if (target != null) position.set((int) target.getCurrentPosition());
                    } catch (Exception error) { throw new RuntimeException(error); }
                });
            }
            assertTrue("Authenticated video plays", position.get() >= 300);
            instrumentation.runOnMainSync(player::close);
            androidx.media3.datasource.cache.SimpleCache cache = (androidx.media3.datasource.cache.SimpleCache) cacheField.get(null);
            assertNotNull(cache);
            assertTrue("Closing retains private media bytes", cache.getCacheSpace() > 0);
        } finally {
            instrumentation.runOnMainSync(() -> { player.close(); activity.finish(); });
        }
    }

    @Test public void localVideoRendersFramesAndPauses() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        File fixture = new File(context.getCacheDir(), "native-video-test.mp4");
        try (InputStream input = instrumentation.getContext().getAssets().open("video-test.mp4");
                FileOutputStream output = new FileOutputStream(fixture)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
        NativeVideoPlayer[] holder = new NativeVideoPlayer[1];
        AtomicBoolean rendered = new AtomicBoolean();
        PlayerView[] video = new PlayerView[1];
        try {
            instrumentation.runOnMainSync(() -> {
                holder[0] = new NativeVideoPlayer(activity);
                try {
                    java.lang.reflect.Method method = NativeVideoPlayer.class.getDeclaredMethod("showDialog", String.class);
                    method.setAccessible(true);
                    FrameLayout frame = (FrameLayout) method.invoke(holder[0], "Video rendering test");
                    ExoPlayer target = new ExoPlayer.Builder(activity).build();
                    target.addListener(new androidx.media3.common.Player.Listener() {
                        @Override public void onRenderedFirstFrame() { rendered.set(true); }
                    });
                    Field playerField = NativeVideoPlayer.class.getDeclaredField("player"); playerField.setAccessible(true); playerField.set(holder[0], target);
                    PlayerView view = new PlayerView(activity); view.setPlayer(target); frame.addView(view, new FrameLayout.LayoutParams(-1, -1));
                    view.setUseController(false); video[0] = view;
                    target.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(fixture))); target.prepare(); target.play();
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            Field field = NativeVideoPlayer.class.getDeclaredField("player");
            field.setAccessible(true);
            AtomicInteger position = new AtomicInteger();
            for (int attempt = 0; attempt < 60 && (position.get() < 500 || !rendered.get()); attempt++) {
                Thread.sleep(500);
                instrumentation.runOnMainSync(() -> {
                    try { position.set((int) ((ExoPlayer) field.get(holder[0])).getCurrentPosition()); }
                    catch (Exception error) { throw new RuntimeException(error); }
                });
            }
            assertTrue("Native video advances playback", position.get() >= 500);
            assertTrue("Decoder renders a first video frame", rendered.get());
            Bitmap[] framePixels = new Bitmap[1];
            AtomicInteger copyResult = new AtomicInteger(-1);
            CountDownLatch copied = new CountDownLatch(1);
            instrumentation.runOnMainSync(() -> {
                android.view.SurfaceView surface = (android.view.SurfaceView) video[0].getVideoSurfaceView();
                assertTrue("Native video surface is attached and shown", surface.isShown());
                framePixels[0] = Bitmap.createBitmap(surface.getWidth(), surface.getHeight(), Bitmap.Config.ARGB_8888);
                android.view.PixelCopy.request(surface, framePixels[0], result -> {
                    copyResult.set(result); copied.countDown();
                }, new android.os.Handler(android.os.Looper.getMainLooper()));
            });
            assertTrue("Native video frame is available for inspection", copied.await(20, TimeUnit.SECONDS));
            assertEquals(android.view.PixelCopy.SUCCESS, copyResult.get());
            Bitmap screenshot = framePixels[0];
            try (FileOutputStream output = new FileOutputStream(new File(context.getFilesDir(), "native-video-frame.png"))) {
                screenshot.compress(Bitmap.CompressFormat.PNG, 100, output);
            }
            int center = screenshot.getPixel(screenshot.getWidth() / 2, screenshot.getHeight() / 2);
            assertTrue("Red fixture is decoded onto the video surface, not black", Color.red(center) > 140 && Color.green(center) < 100);
            screenshot.recycle();
            instrumentation.runOnMainSync(() -> holder[0].pause());
            AtomicInteger paused = new AtomicInteger();
            Thread.sleep(500);
            instrumentation.runOnMainSync(() -> {
                try {
                    ExoPlayer target = (ExoPlayer) field.get(holder[0]);
                    assertFalse(target.getPlayWhenReady());
                    paused.set((int) target.getCurrentPosition());
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            Thread.sleep(500);
            instrumentation.runOnMainSync(() -> {
                try { assertTrue(Math.abs(((ExoPlayer) field.get(holder[0])).getCurrentPosition() - paused.get()) < 200); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
        } finally {
            instrumentation.runOnMainSync(() -> { if (holder[0] != null) holder[0].destroy(); activity.finish(); });
            fixture.delete();
        }
    }
}

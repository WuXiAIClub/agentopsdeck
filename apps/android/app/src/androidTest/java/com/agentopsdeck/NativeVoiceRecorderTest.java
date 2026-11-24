package com.agentopsdeck;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeVoiceRecorderTest {
    private final class FakeHost implements NativeVoiceRecorder.Host {
        boolean granted = true;
        int requests;
        public boolean granted() { return granted; }
        public void requestPermission() { requests++; }
        public File directory() { return InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(); }
    }
    private static final class FakeCapture implements NativeVoiceRecorder.Capture {
        File file;
        int stops;
        int releases;
        boolean fails;
        public void start(File target) throws Exception { file = target; Files.write(file.toPath(), new byte[128]); }
        public void stop() { stops++; if (fails) throw new IllegalStateException(); }
        public void release() { releases++; }
    }
    private final FakeHost host = new FakeHost();
    private final List<FakeCapture> captures = new ArrayList<>();
    private final List<JSONObject> packets = new ArrayList<>();
    private NativeVoiceRecorder recorder;
    private CountDownLatch audio;
    private void main(Runnable action) { InstrumentationRegistry.getInstrumentation().runOnMainSync(action); }
    @Before public void setup() {
        audio = new CountDownLatch(1);
        main(() -> recorder = new NativeVoiceRecorder(host, () -> { FakeCapture capture = new FakeCapture(); captures.add(capture); return capture; }));
    }
    @After public void cleanup() { main(() -> recorder.destroy()); }
    private void send(String type, String id) {
        try {
            recorder.handle(new JSONObject().put("type", "speech." + type).put("id", id), value -> {
                try {
                    JSONObject packet = new JSONObject(value);
                    packets.add(packet);
                    if (packet.optString("event").equals("audio")) audio.countDown();
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } catch (Exception error) { throw new AssertionError(error); }
    }
    private long events(String name) { return packets.stream().filter(packet -> packet.optString("event").equals(name)).count(); }

    @Test public void stopsOnceAndReturnsM4aWithoutSystemSpeech() throws Exception {
        main(() -> { send("start", "one"); send("stop", "one"); send("stop", "one"); });
        assertTrue(audio.await(5, TimeUnit.SECONDS));
        main(() -> {
            assertEquals(1, captures.get(0).stops);
            assertEquals(1, events("start"));
            assertEquals(1, events("audio"));
            JSONObject packet = packets.stream().filter(item -> item.optString("event").equals("audio")).findFirst().get();
            assertEquals("audio/mp4", packet.optString("mimeType"));
            assertFalse(packet.optString("base64").isEmpty());
            assertTrue(captures.get(0).file.exists());
            send("finish", "one");
            assertFalse(captures.get(0).file.exists());
        });
    }
    @Test public void deniedPermissionNeverStartsCapture() {
        main(() -> { host.granted = false; send("start", "one"); recorder.permissionResult(false);
            assertEquals(1, host.requests); assertTrue(captures.isEmpty()); assertEquals(1, events("error")); });
    }
    @Test public void stoppingDuringPermissionPromptCannotStartLater() {
        main(() -> { host.granted = false; send("start", "one"); send("stop", "one"); recorder.permissionResult(true);
            assertTrue(captures.isEmpty()); assertEquals(1, events("end")); });
    }
    @Test public void abortDeletesPrivateRecordingWithoutUploading() {
        main(() -> { send("start", "one"); File file = captures.get(0).file; send("abort", "one");
            assertFalse(file.exists()); assertEquals(0, events("audio")); assertEquals(1, captures.get(0).releases); });
    }
    @Test public void staleStopsCannotAffectNewRecording() {
        main(() -> { send("start", "one"); send("start", "two"); send("stop", "one");
            assertEquals(0, captures.get(1).stops); assertFalse(captures.get(0).file.exists()); });
    }
    @Test public void backgroundCancelsMicrophoneAndBlocksStart() {
        main(() -> { send("start", "one"); recorder.pause(); send("start", "two");
            assertEquals(1, captures.size()); assertEquals(0, events("audio")); assertFalse(captures.get(0).file.exists()); });
    }
    @Test public void failedStopReleasesCaptureAndDoesNotUpload() {
        main(() -> { send("start", "one"); captures.get(0).fails = true; send("stop", "one");
            assertEquals(1, events("error")); assertEquals(0, events("audio")); assertFalse(captures.get(0).file.exists()); });
    }
}

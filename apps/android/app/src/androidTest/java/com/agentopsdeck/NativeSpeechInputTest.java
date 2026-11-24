package com.agentopsdeck;

import static org.junit.Assert.*;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeSpeechInputTest {
    private static final class FakeHost implements NativeSpeechInput.Host {
        boolean granted = true;
        int requests;
        final List<String> notices = new ArrayList<>();
        public boolean granted() { return granted; }
        public void requestPermission() { requests++; }
        public void notice(String message) { notices.add(message); }
    }

    private static final class FakeEngine implements NativeSpeechInput.Engine {
        NativeSpeechInput.Listener listener;
        Intent intent;
        boolean stopped;
        int stops;
        boolean destroyed;
        boolean external;
        public void start(Intent intent) { this.intent = intent; }
        public void stop() { stopped = true; stops++; }
        public void destroy() { destroyed = true; }
        public boolean ownsActivity() { return external; }
    }

    private final FakeHost host = new FakeHost();
    private final List<FakeEngine> engines = new ArrayList<>();
    private final List<JSONObject> packets = new ArrayList<>();
    private boolean available = true;
    private boolean requiresPermission = true;
    private boolean external;
    private NativeSpeechInput speech;

    private void main(Runnable action) { InstrumentationRegistry.getInstrumentation().runOnMainSync(action); }

    @Before public void setup() {
        main(() -> speech = new NativeSpeechInput(host, new NativeSpeechInput.Factory() {
            public boolean available() { return available; }
            public boolean requiresPermission() { return requiresPermission; }
            public NativeSpeechInput.Engine create(NativeSpeechInput.Listener listener) {
                FakeEngine engine = new FakeEngine();
                engine.listener = listener;
                engine.external = external;
                engines.add(engine);
                return engine;
            }
        }));
    }

    @After public void cleanup() { main(() -> speech.destroy()); }

    private void send(String type, String id) {
        try {
            JSONObject request = new JSONObject().put("type", "speech." + type).put("id", id)
                    .put("lang", "zh-CN").put("interimResults", true);
            speech.handle(request, data -> {
                try { packets.add(new JSONObject(data)); }
                catch (Exception error) { throw new AssertionError(error); }
            });
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private Bundle transcript(String text) {
        Bundle bundle = new Bundle();
        bundle.putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, new ArrayList<>(List.of(text)));
        return bundle;
    }

    @Test public void permissionGrantedAfterDialogPauseStartsOnceAndReturnsChineseResults() {
        main(() -> {
            host.granted = false;
            send("start", "first");
            assertEquals(1, host.requests);
            assertTrue(engines.isEmpty());
            speech.pause();
            host.granted = true;
            speech.permissionResult(true);
            assertTrue(engines.isEmpty());
            speech.resume();
            assertEquals(1, engines.size());
            FakeEngine engine = engines.get(0);
            assertEquals("zh-CN", engine.intent.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE));
            assertTrue(engine.intent.getBooleanExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false));
            engine.listener.onReadyForSpeech(new Bundle());
            engine.listener.onPartialResults(transcript("你好"));
            engine.listener.onResults(transcript("你好世界"));
            assertEquals("start", packets.get(0).optString("event"));
            assertFalse(packets.get(1).optBoolean("final"));
            assertEquals("你好世界", packets.get(2).optString("transcript"));
            assertTrue(packets.get(2).optBoolean("final"));
            assertEquals("end", packets.get(3).optString("event"));
            assertTrue(engine.destroyed);
        });
    }

    @Test public void permissionDenialEndsSessionAndRetryCanStart() {
        main(() -> {
            host.granted = false;
            send("start", "denied");
            speech.permissionResult(false);
            assertEquals("not-allowed", packets.get(0).optString("error"));
            assertEquals("end", packets.get(1).optString("event"));
            assertFalse(host.notices.isEmpty());
            host.granted = true;
            send("start", "retry");
            assertEquals(1, engines.size());
        });
    }

    @Test public void unavailableServiceDoesNotAskForMicrophoneOrStartEngine() {
        main(() -> {
            available = false;
            host.granted = false;
            send("start", "unavailable");
            assertEquals("service-not-allowed", packets.get(0).optString("error"));
            assertEquals(0, host.requests);
            assertTrue(engines.isEmpty());
            assertTrue(host.notices.get(0).contains("系统语音识别服务"));
        });
    }

    @Test public void stopFinishesWithFinalResultAndIgnoresStaleCallbacks() {
        main(() -> {
            send("start", "first");
            FakeEngine first = engines.get(0);
            send("stop", "first");
            assertTrue(first.stopped);
            first.listener.onResults(transcript("final"));
            assertTrue(first.destroyed);
            send("start", "second");
            int before = packets.size();
            first.listener.onError(SpeechRecognizer.ERROR_NETWORK);
            first.listener.onResults(transcript("stale"));
            send("abort", "first");
            assertEquals(before, packets.size());
            assertFalse(engines.get(1).destroyed);
            send("abort", "second");
            assertEquals("aborted", packets.get(before).optString("error"));
            assertTrue(engines.get(1).destroyed);
        });
    }

    @Test public void backgroundCancelsRecordingAndRejectsNewStarts() {
        main(() -> {
            send("start", "first");
            speech.pause();
            assertTrue(engines.get(0).destroyed);
            send("start", "background");
            assertEquals(1, engines.size());
            speech.resume();
            assertEquals(1, engines.size());
            send("start", "foreground");
            assertEquals(2, engines.size());
        });
    }

    @Test public void cancelledPermissionRequestNeverStartsAfterGrant() {
        main(() -> {
            host.granted = false;
            send("start", "pending");
            send("stop", "pending");
            host.granted = true;
            speech.permissionResult(true);
            assertTrue(engines.isEmpty());
            assertEquals("end", packets.get(0).optString("event"));
        });
    }

    @Test public void networkAndLanguageErrorsAreNotMisreportedAsPermissions() {
        main(() -> {
            send("start", "network");
            engines.get(0).listener.onError(SpeechRecognizer.ERROR_NETWORK);
            assertEquals("network", packets.get(0).optString("error"));
            send("start", "language");
            engines.get(1).listener.onError(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE);
            assertEquals("language-not-supported", packets.get(2).optString("error"));
            assertTrue(host.notices.get(1).contains("语言"));
        });
    }

    @Test public void systemWindowOwnsPermissionAndSurvivesItsActivityPause() {
        main(() -> {
            external = true;
            requiresPermission = false;
            host.granted = false;
            send("start", "system");
            assertEquals(0, host.requests);
            assertEquals(1, engines.size());
            speech.pause();
            assertFalse(engines.get(0).destroyed);
            engines.get(0).listener.onResults(transcript("系统语音"));
            assertEquals("系统语音", packets.get(0).optString("transcript"));
            assertEquals("end", packets.get(1).optString("event"));
            speech.resume();
            assertEquals(1, engines.size());
        });
    }

    @Test public void switchingPageCancelsSystemWindowAndIgnoresItsLateResult() {
        main(() -> {
            external = true;
            send("start", "system");
            speech.pause();
            speech.cancel();
            assertTrue(engines.get(0).destroyed);
            int before = packets.size();
            engines.get(0).listener.onResults(transcript("过期"));
            assertEquals(before, packets.size());
        });
    }

    @Test public void replacementAndDestroyReleaseOldSessions() {
        main(() -> {
            send("start", "first");
            send("start", "second");
            assertTrue(engines.get(0).destroyed);
            assertEquals("first", packets.get(0).optString("id"));
            speech.destroy();
            assertTrue(engines.get(1).destroyed);
            int before = packets.size();
            engines.get(1).listener.onResults(transcript("stale"));
            assertEquals(before, packets.size());
        });
    }

    @Test public void repeatedStopCannotExtendDeadlineOrDiscardPartialText() throws Exception {
        main(() -> {
            send("start", "stuck");
            engines.get(0).listener.onPartialResults(transcript("保留文字"));
            send("stop", "stuck");
        });
        Thread.sleep(1200);
        main(() -> send("stop", "stuck"));
        Thread.sleep(1100);
        main(() -> {
            assertEquals(1, engines.get(0).stops);
            assertTrue(engines.get(0).destroyed);
            assertEquals(2, packets.size());
            assertEquals("保留文字", packets.get(0).optString("transcript"));
            assertEquals("end", packets.get(1).optString("event"));
            assertTrue(host.notices.isEmpty());
            int before = packets.size();
            engines.get(0).listener.onResults(transcript("过期结果"));
            assertEquals(before, packets.size());
        });
    }

    @Test public void stoppingUnresponsiveEngineEndsWithUsefulNotice() throws Exception {
        main(() -> { send("start", "stuck"); send("stop", "stuck"); });
        Thread.sleep(2300);
        main(() -> {
            assertTrue(engines.get(0).destroyed);
            assertEquals("no-speech", packets.get(0).optString("error"));
            assertEquals("end", packets.get(1).optString("event"));
            assertFalse(host.notices.isEmpty());
        });
    }

    @Test public void startupTimeoutIsNotMisreportedAsPermissionDenial() {
        main(() -> {
            send("start", "stuck");
            engines.get(0).listener.onStartupTimeout();
            assertEquals("service-timeout", packets.get(0).optString("error"));
            assertEquals("end", packets.get(1).optString("event"));
            assertTrue(host.notices.get(0).contains("启动超时"));
        });
    }
}

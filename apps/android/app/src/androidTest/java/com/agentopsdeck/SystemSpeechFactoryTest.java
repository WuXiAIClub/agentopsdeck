package com.agentopsdeck;

import static org.junit.Assert.*;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SystemSpeechFactoryTest {
    private static final class Scheduler implements SystemSpeechFactory.Scheduler {
        Runnable pending;
        Runnable previous;
        long delay;
        public void post(Runnable action, long delay) { pending = action; previous = action; this.delay = delay; }
        public void remove(Runnable action) { if (pending == action) pending = null; }
        void expire() { Runnable action = pending; pending = null; if (action != null) action.run(); }
    }

    private static final class Listener implements NativeSpeechInput.Listener {
        int ready;
        int timeouts;
        public void onStartupTimeout() { timeouts++; }
        final List<Integer> errors = new ArrayList<>();
        final List<Bundle> results = new ArrayList<>();
        public void onReadyForSpeech(Bundle params) { ready++; }
        public void onBeginningOfSpeech() {}
        public void onRmsChanged(float rms) {}
        public void onBufferReceived(byte[] buffer) {}
        public void onEndOfSpeech() {}
        public void onEvent(int type, Bundle params) {}
        public void onPartialResults(Bundle params) {}
        public void onResults(Bundle params) { results.add(params); }
        public void onError(int error) { errors.add(error); }
    }

    private static final class Platform implements SystemSpeechFactory.Platform {
        boolean service;
        boolean window = true;
        boolean failLaunch;
        boolean failService;
        boolean released;
        int request;
        int dismissed;
        int launches;
        Intent intent;
        RecognitionListener serviceListener;
        public boolean hasService() { return service; }
        public boolean hasActivity() { return window; }
        public NativeSpeechInput.Engine createService(RecognitionListener listener) {
            serviceListener = listener;
            if (failService) throw new IllegalStateException("No default provider");
            return new NativeSpeechInput.Engine() {
                public void start(Intent intent) {}
                public void stop() {}
                public void destroy() { released = true; }
            };
        }
        public void launch(Intent intent, int requestCode) {
            if (failLaunch) throw new IllegalStateException("Provider disabled");
            this.intent = intent;
            request = requestCode;
            launches++;
        }
        public void dismiss(int requestCode) { dismissed = requestCode; }
    }

    private final Platform platform = new Platform();
    private final Scheduler scheduler = new Scheduler();
    private final SystemSpeechFactory factory = new SystemSpeechFactory(platform, scheduler);
    private final Listener listener = new Listener();

    private NativeSpeechInput.Engine start() {
        NativeSpeechInput.Engine engine = factory.create(listener);
        engine.start(new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN"));
        return engine;
    }

    @Test public void activityOnlyProviderReturnsChineseWithoutAppMicrophonePermission() {
        assertTrue(factory.available());
        assertFalse(factory.requiresPermission());
        NativeSpeechInput.Engine engine = start();
        assertTrue(engine.ownsActivity());
        assertEquals(1, listener.ready);
        assertEquals("zh-CN", platform.intent.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE));
        factory.activityResult(platform.request, Activity.RESULT_OK, new Intent()
                .putStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS, new ArrayList<>(List.of("你好世界"))));
        assertFalse(engine.ownsActivity());
        assertEquals("你好世界", listener.results.get(0).getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).get(0));
        engine.destroy();
        assertEquals(0, platform.dismissed);
    }

    @Test public void missingBothProvidersIsUnavailable() {
        platform.window = false;
        assertFalse(factory.available());
    }

    @Test public void brokenDefaultServiceFallsBackBeforeRecording() {
        platform.service = true;
        assertTrue(factory.requiresPermission());
        NativeSpeechInput.Engine engine = start();
        platform.serviceListener.onError(SpeechRecognizer.ERROR_CLIENT);
        assertTrue(platform.released);
        assertTrue(engine.ownsActivity());
        assertTrue(listener.errors.isEmpty());
        platform.serviceListener.onError(SpeechRecognizer.ERROR_CLIENT);
        assertEquals(1, platform.launches);
        platform.serviceListener.onResults(new Bundle());
        platform.serviceListener.onPartialResults(new Bundle());
        platform.serviceListener.onReadyForSpeech(new Bundle());
        assertTrue(listener.results.isEmpty());
        assertEquals(1, listener.ready);
        engine.destroy();
    }

    @Test public void serviceCreationFailureAlsoFallsBack() {
        platform.service = true;
        platform.failService = true;
        NativeSpeechInput.Engine engine = start();
        assertTrue(engine.ownsActivity());
        assertTrue(listener.errors.isEmpty());
        engine.destroy();
    }

    @Test public void permissionAndNetworkErrorsNeverTriggerAnotherRecording() {
        platform.service = true;
        NativeSpeechInput.Engine engine = start();
        platform.serviceListener.onError(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS);
        platform.serviceListener.onError(SpeechRecognizer.ERROR_NETWORK);
        assertEquals(List.of(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS, SpeechRecognizer.ERROR_NETWORK), listener.errors);
        assertEquals(0, platform.launches);
        engine.destroy();
    }

    @Test public void errorsAfterReadyDoNotOpenAnotherRecorder() {
        platform.service = true;
        NativeSpeechInput.Engine engine = start();
        platform.serviceListener.onReadyForSpeech(new Bundle());
        platform.serviceListener.onError(SpeechRecognizer.ERROR_CLIENT);
        assertEquals(List.of(SpeechRecognizer.ERROR_CLIENT), listener.errors);
        assertEquals(0, platform.launches);
        engine.destroy();
    }

    @Test public void cancelledAndStaleResultsCannotFillTheNextSession() {
        NativeSpeechInput.Engine first = start();
        int oldRequest = platform.request;
        first.destroy();
        assertEquals(oldRequest, platform.dismissed);
        NativeSpeechInput.Engine second = start();
        assertNotEquals(oldRequest, platform.request);
        factory.activityResult(oldRequest, Activity.RESULT_OK, new Intent()
                .putStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS, new ArrayList<>(List.of("过期"))));
        assertTrue(listener.results.isEmpty());
        factory.activityResult(platform.request, Activity.RESULT_CANCELED, null);
        assertEquals(1, listener.results.size());
        assertNull(listener.results.get(0).getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION));
        assertTrue(listener.errors.isEmpty());
        assertFalse(second.ownsActivity());
        second.destroy();
    }

    @Test public void launchFailureEndsInsteadOfWaitingForever() {
        platform.failLaunch = true;
        NativeSpeechInput.Engine engine = start();
        assertEquals(List.of(SpeechRecognizer.ERROR_CLIENT), listener.errors);
        assertFalse(engine.ownsActivity());
        engine.destroy();
    }

    @Test public void unresponsiveServiceFallsBackAndIgnoresLateCallbacks() {
        platform.service = true;
        NativeSpeechInput.Engine engine = start();
        assertEquals(6000, scheduler.delay);
        scheduler.expire();
        assertTrue(platform.released);
        assertTrue(engine.ownsActivity());
        assertEquals(1, platform.launches);
        platform.serviceListener.onReadyForSpeech(new Bundle());
        platform.serviceListener.onResults(new Bundle());
        scheduler.previous.run();
        assertEquals(1, platform.launches);
        assertEquals(1, listener.ready);
        assertTrue(listener.results.isEmpty());
        engine.destroy();
    }

    @Test public void unresponsiveServiceWithoutWindowReportsStartupTimeout() {
        platform.service = true;
        platform.window = false;
        NativeSpeechInput.Engine engine = start();
        scheduler.expire();
        assertTrue(platform.released);
        assertEquals(1, listener.timeouts);
        assertTrue(listener.errors.isEmpty());
        engine.destroy();
    }

    @Test public void stopBeforeReadyPreventsFallbackEvenForLateErrorOrTimeout() {
        platform.service = true;
        NativeSpeechInput.Engine engine = start();
        engine.stop();
        engine.stop();
        assertNull(scheduler.pending);
        scheduler.previous.run();
        platform.serviceListener.onReadyForSpeech(new Bundle());
        platform.serviceListener.onError(SpeechRecognizer.ERROR_CLIENT);
        assertEquals(0, platform.launches);
        assertEquals(0, listener.ready);
        engine.destroy();
    }

    @Test public void readinessOrDestroyDisarmsStartupTimeout() {
        platform.service = true;
        NativeSpeechInput.Engine engine = start();
        platform.serviceListener.onReadyForSpeech(new Bundle());
        assertNull(scheduler.pending);
        scheduler.previous.run();
        assertEquals(0, platform.launches);
        engine.destroy();
        engine = start();
        engine.destroy();
        assertNull(scheduler.pending);
        scheduler.previous.run();
        assertEquals(0, platform.launches);
    }

    @Test public void providerThatSkipsReadyButProducesSpeechDoesNotStartAnotherRecorder() {
        platform.service = true;
        NativeSpeechInput.Engine engine = start();
        platform.serviceListener.onPartialResults(new Bundle());
        assertNull(scheduler.pending);
        scheduler.previous.run();
        assertEquals(1, listener.ready);
        assertEquals(0, platform.launches);
        engine.destroy();
    }
}

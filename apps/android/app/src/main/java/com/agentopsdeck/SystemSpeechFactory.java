package com.agentopsdeck;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import java.util.ArrayList;

final class SystemSpeechFactory implements NativeSpeechInput.Factory {
    interface Scheduler {
        void post(Runnable action, long delay);
        void remove(Runnable action);
    }

    interface Platform {
        boolean hasService();
        boolean hasActivity();
        NativeSpeechInput.Engine createService(RecognitionListener listener);
        void launch(Intent intent, int requestCode);
        void dismiss(int requestCode);
    }

    private final Platform platform;
    private final Scheduler scheduler;
    private int nextRequestCode = 2000;
    private SystemEngine external;

    SystemSpeechFactory(Activity activity) {
        this(new Platform() {
            public boolean hasService() { return SpeechRecognizer.isRecognitionAvailable(activity); }
            public boolean hasActivity() {
                return new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).resolveActivity(activity.getPackageManager()) != null;
            }
            public NativeSpeechInput.Engine createService(RecognitionListener listener) {
                SpeechRecognizer recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
                recognizer.setRecognitionListener(listener);
                return new NativeSpeechInput.Engine() {
                    public void start(Intent intent) { recognizer.startListening(intent); }
                    public void stop() { recognizer.stopListening(); }
                    public void destroy() { try { recognizer.cancel(); } finally { recognizer.destroy(); } }
                };
            }
            public void launch(Intent intent, int requestCode) { activity.startActivityForResult(intent, requestCode); }
            public void dismiss(int requestCode) { activity.finishActivity(requestCode); }
        });
    }

    SystemSpeechFactory(Platform platform) {
        this(platform, new Scheduler() {
            private final Handler handler = new Handler(Looper.getMainLooper());
            public void post(Runnable action, long delay) { handler.postDelayed(action, delay); }
            public void remove(Runnable action) { handler.removeCallbacks(action); }
        });
    }

    SystemSpeechFactory(Platform platform, Scheduler scheduler) {
        this.platform = platform;
        this.scheduler = scheduler;
    }

    public boolean available() { return platform.hasService() || platform.hasActivity(); }
    public boolean requiresPermission() { return platform.hasService(); }
    public NativeSpeechInput.Engine create(NativeSpeechInput.Listener listener) { return new SystemEngine(listener); }

    void activityResult(int requestCode, int resultCode, Intent data) {
        SystemEngine engine = external;
        if (engine == null || engine.requestCode != requestCode) return;
        external = null;
        engine.requestCode = 0;
        Bundle results = new Bundle();
        if (resultCode == Activity.RESULT_OK && data != null) {
            ArrayList<String> text = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (text != null) results.putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, text);
        }
        engine.listener.onResults(results);
    }

    private final class SystemEngine implements NativeSpeechInput.Engine, RecognitionListener {
        private final NativeSpeechInput.Listener listener;
        private NativeSpeechInput.Engine recognizer;
        private Intent intent;
        private int requestCode;
        private boolean ready;
        private boolean closed;
        private boolean triedActivity;
        private boolean stopping;
        private final Runnable startupTimeout = this::startupExpired;

        private void startupExpired() {
            if (closed || ready || stopping || triedActivity) return;
            triedActivity = true;
            releaseRecognizer();
            if (platform.hasActivity()) startActivity();
            else listener.onStartupTimeout();
        }

        SystemEngine(NativeSpeechInput.Listener listener) { this.listener = listener; }

        public void start(Intent request) {
            intent = new Intent(request);
            if (!platform.hasService()) { startActivity(); return; }
            try {
                recognizer = platform.createService(this);
                scheduler.post(startupTimeout, 6000);
                recognizer.start(intent);
            } catch (SecurityException error) {
                scheduler.remove(startupTimeout);
                listener.onError(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS);
            } catch (RuntimeException error) {
                onError(SpeechRecognizer.ERROR_CLIENT);
            }
        }

        private void startActivity() {
            scheduler.remove(startupTimeout);
            triedActivity = true;
            if (!platform.hasActivity() || nextRequestCode > 65535) {
                listener.onError(SpeechRecognizer.ERROR_CLIENT);
                return;
            }
            requestCode = nextRequestCode++;
            external = this;
            try {
                platform.launch(intent, requestCode);
                listener.onReadyForSpeech(new Bundle());
            } catch (RuntimeException error) {
                external = null;
                requestCode = 0;
                listener.onError(error instanceof SecurityException
                        ? SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS : SpeechRecognizer.ERROR_CLIENT);
            }
        }

        public boolean ownsActivity() { return requestCode != 0; }

        public void stop() {
            if (closed || stopping) return;
            stopping = true;
            scheduler.remove(startupTimeout);
            if (recognizer != null) recognizer.stop();
            else if (requestCode != 0) {
                platform.dismiss(requestCode);
                activityResult(requestCode, Activity.RESULT_CANCELED, null);
            }
        }

        private void releaseRecognizer() {
            NativeSpeechInput.Engine previous = recognizer;
            recognizer = null;
            if (previous != null) {
                try { previous.destroy(); } catch (RuntimeException ignored) {}
            }
        }

        public void destroy() {
            closed = true;
            scheduler.remove(startupTimeout);
            releaseRecognizer();
            if (external == this) external = null;
            if (requestCode != 0) {
                int previous = requestCode;
                requestCode = 0;
                platform.dismiss(previous);
            }
        }

        public void onReadyForSpeech(Bundle params) {
            if (!closed && !triedActivity && !stopping) {
                ready = true;
                scheduler.remove(startupTimeout);
                listener.onReadyForSpeech(params);
            }
        }
        public void onBeginningOfSpeech() {
            if (!closed && !triedActivity) {
                if (!ready && !stopping) onReadyForSpeech(new Bundle());
                listener.onBeginningOfSpeech();
            }
        }
        public void onRmsChanged(float rms) { if (!closed && !triedActivity) listener.onRmsChanged(rms); }
        public void onBufferReceived(byte[] buffer) { if (!closed && !triedActivity) listener.onBufferReceived(buffer); }
        public void onEndOfSpeech() { if (!closed && !triedActivity) listener.onEndOfSpeech(); }
        public void onEvent(int type, Bundle params) { if (!closed && !triedActivity) listener.onEvent(type, params); }
        public void onPartialResults(Bundle results) {
            if (!closed && !triedActivity) {
                if (!ready && !stopping) onReadyForSpeech(new Bundle());
                listener.onPartialResults(results);
            }
        }
        public void onResults(Bundle results) {
            if (!closed && !triedActivity) {
                scheduler.remove(startupTimeout);
                listener.onResults(results);
            }
        }

        public void onError(int error) {
            if (closed || triedActivity) return;
            scheduler.remove(startupTimeout);
            if (!ready && !stopping && platform.hasActivity() && (error == SpeechRecognizer.ERROR_CLIENT
                    || error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED)) {
                triedActivity = true;
                releaseRecognizer();
                startActivity();
            } else listener.onError(error);
        }
    }
}

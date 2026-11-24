package com.agentopsdeck;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONObject;

final class NativeVoiceRecorder {
    interface Host {
        boolean granted();
        void requestPermission();
        File directory();
    }

    interface Capture {
        void start(File file) throws Exception;
        void stop();
        void release();
    }

    interface Factory { Capture create(); }

    private static final class Session {
        final String id;
        final Consumer<String> reply;
        File file;
        Capture capture;
        boolean stopping;
        Session(String id, Consumer<String> reply) { this.id = id; this.reply = reply; }
    }

    private final Host host;
    private final Factory factory;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Session active;
    private boolean foreground = true;
    private boolean permissionPending;
    private boolean destroyed;
    private final Runnable limit = () -> { if (active != null) stop(active); };

    NativeVoiceRecorder(Activity activity, int permissionCode) {
        this(new Host() {
            public boolean granted() { return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED; }
            public void requestPermission() { activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, permissionCode); }
            public File directory() { return activity.getCacheDir(); }
        }, () -> new Capture() {
            private final MediaRecorder recorder = new MediaRecorder();
            public void start(File file) throws Exception {
                recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
                recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
                recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
                recorder.setAudioSamplingRate(16000);
                recorder.setAudioEncodingBitRate(64000);
                recorder.setAudioChannels(1);
                recorder.setOutputFile(file.getAbsolutePath());
                recorder.prepare();
                recorder.start();
            }
            public void stop() { recorder.stop(); }
            public void release() { recorder.release(); }
        });
    }

    NativeVoiceRecorder(Host host, Factory factory) { this.host = host; this.factory = factory; }

    void handle(JSONObject request, Consumer<String> reply) {
        if (destroyed) return;
        String id = request.optString("id");
        if (id.isEmpty() || id.length() > 64) return;
        String type = request.optString("type");
        if (type.equals("speech.start")) {
            cancel();
            active = new Session(id, reply);
            if (!foreground) { fail(active, "aborted"); return; }
            if (host.granted()) start(active);
            else if (!permissionPending) { permissionPending = true; host.requestPermission(); }
        } else if (active != null && active.id.equals(id)) {
            if (type.equals("speech.stop")) stop(active);
            else if (type.equals("speech.abort") || type.equals("speech.finish")) cancel();
        }
    }

    void permissionResult(boolean granted) {
        permissionPending = false;
        if (active == null || active.capture != null || active.stopping) return;
        if (!granted) fail(active, "not-allowed");
        else if (foreground) start(active);
    }

    private void start(Session session) {
        try {
            session.file = File.createTempFile("voice-", ".m4a", host.directory());
            session.capture = factory.create();
            session.capture.start(session.file);
            handler.postDelayed(limit, 60_000);
            emit(session, "start", null, null);
        } catch (Exception error) { fail(session, "audio-capture"); }
    }

    private void stop(Session session) {
        if (session.stopping) return;
        if (session.capture == null) { cancel(); return; }
        session.stopping = true;
        handler.removeCallbacks(limit);
        try {
            session.capture.stop();
            session.capture.release();
            session.capture = null;
        } catch (RuntimeException error) { fail(session, "audio-capture"); return; }
        worker.execute(() -> {
            String encoded = null;
            try {
                long size = session.file.length();
                if (size >= 64 && size <= 2 * 1024 * 1024)
                    encoded = Base64.encodeToString(Files.readAllBytes(session.file.toPath()), Base64.NO_WRAP);
            } catch (Exception ignored) {}
            String result = encoded;
            handler.post(() -> {
                if (active != session || destroyed) return;
                if (result == null) fail(session, "audio-capture");
                else emit(session, "audio", null, result);
            });
        });
    }

    private void emit(Session session, String event, String error, String audio) {
        try {
            JSONObject packet = new JSONObject().put("type", "speech.event").put("id", session.id).put("event", event);
            if (error != null) packet.put("error", error);
            if (audio != null) packet.put("base64", audio).put("mimeType", "audio/mp4");
            session.reply.accept(packet.toString());
        } catch (Exception ignored) {}
    }

    private void fail(Session session, String error) { emit(session, "error", error, null); cancel(); }

    void cancel() {
        Session session = active;
        if (session == null) return;
        active = null;
        handler.removeCallbacks(limit);
        if (session.capture != null) {
            try { session.capture.release(); } catch (RuntimeException ignored) {}
        }
        if (session.file != null) session.file.delete();
        emit(session, "end", null, null);
    }

    void pause() { foreground = false; if (active != null && !active.stopping) { emit(active, "error", "aborted", null); cancel(); } }
    void resume() { foreground = true; }
    void destroy() { destroyed = true; cancel(); worker.shutdownNow(); }
    void activityResult(int requestCode, int resultCode, Intent data) {}
}

package com.agentopsdeck;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.function.Consumer;
import org.json.JSONObject;

final class NativeSpeechInput {
    interface Host {
        boolean granted();
        void requestPermission();
        void notice(String message);
    }

    interface Engine {
        void start(Intent intent);
        void stop();
        void destroy();
        default boolean ownsActivity() { return false; }
    }

    interface Listener extends RecognitionListener {
        void onStartupTimeout();
    }

    interface Factory {
        boolean available();
        Engine create(Listener listener);
        default boolean requiresPermission() { return true; }
    }

    private static final class Session {
        final String id;
        final String language;
        final boolean interim;
        final Consumer<String> reply;
        Engine engine;
        boolean stopping;
        boolean hasText;

        Session(JSONObject request, Consumer<String> reply) {
            id = request.optString("id");
            language = request.optString("lang", "zh-CN");
            interim = request.optBoolean("interimResults");
            this.reply = reply;
        }
    }

    private final Host host;
    private final Factory factory;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Session active;
    private boolean permissionPending;
    private boolean foreground = true;
    private final Runnable timeout = () -> {
        Session session = active;
        if (session == null) return;
        if (session.hasText) finish(session);
        else fail(session, "no-speech", "未收到识别文字。系统语音服务可能没有响应，也可改用输入法的语音输入。");
    };

    NativeSpeechInput(Activity activity, int permissionCode) {
        this(new Host() {
            public boolean granted() { return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED; }
            public void requestPermission() { activity.requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, permissionCode); }
            public void notice(String message) { Toast.makeText(activity, message, Toast.LENGTH_LONG).show(); }
        }, new SystemSpeechFactory(activity));
    }

    NativeSpeechInput(Host host, Factory factory) {
        this.host = host;
        this.factory = factory;
    }

    void handle(JSONObject request, Consumer<String> reply) {
        String id = request.optString("id");
        if (id.isEmpty() || id.length() > 64) return;
        String type = request.optString("type");
        if (type.equals("speech.start")) {
            cancel();
            active = new Session(request, reply);
            if (!foreground) { fail(active, "aborted", null); return; }
            if (!factory.available()) {
                fail(active, "service-not-allowed", "此手机没有可用的系统语音识别服务。请先安装或启用支持中文的语音识别服务，也可使用输入法语音输入。");
                return;
            }
            if (!factory.requiresPermission() || host.granted()) start(active);
            else if (!permissionPending) {
                permissionPending = true;
                host.requestPermission();
            }
        } else if (active != null && active.id.equals(id)) {
            if (type.equals("speech.abort")) cancel();
            else if (type.equals("speech.stop")) {
                Session session = active;
                if (session.engine == null) finish(session);
                else {
                    if (session.stopping) return;
                    session.stopping = true;
                    try {
                        handler.removeCallbacks(timeout);
                        handler.postDelayed(timeout, 2000);
                        session.engine.stop();
                    } catch (RuntimeException error) { fail(session, "audio-capture", null); }
                }
            }
        }
    }

    void permissionResult(boolean granted) {
        permissionPending = false;
        if (active == null || active.engine != null) return;
        if (!granted) fail(active, "not-allowed", "麦克风权限被拒绝，请在安卓设置 → 应用 → AgentOpsDeck → 权限中允许麦克风，然后重试。");
        else if (foreground) start(active);
    }

    private void start(Session session) {
        if (active != session || session.engine != null) return;
        try {
            session.engine = factory.create(new Listener() {
                public void onStartupTimeout() {
                    fail(session, "service-timeout", "手机系统语音识别服务启动超时，且没有可用的系统识别窗口。请检查系统语音服务，或使用输入法语音输入。");
                }
                public void onReadyForSpeech(Bundle params) {
                    if (!session.stopping) emit(session, "start", null, null, false);
                }
                public void onBeginningOfSpeech() {}
                public void onRmsChanged(float rms) {}
                public void onBufferReceived(byte[] buffer) {}
                public void onEndOfSpeech() {}
                public void onEvent(int type, Bundle params) {}
                public void onPartialResults(Bundle results) { if (session.interim) result(session, results, false); }
                public void onResults(Bundle results) { result(session, results, true); finish(session); }
                public void onError(int error) {
                    String code = switch (error) {
                        case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "not-allowed";
                        case SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> "network";
                        case SpeechRecognizer.ERROR_AUDIO -> "audio-capture";
                        case SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-speech";
                        case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "language-not-supported";
                        default -> "service-not-allowed";
                    };
                    String message = switch (code) {
                        case "no-speech" -> session.hasText ? null : "没有收到识别文字，请重试，或使用手机输入法的语音输入。";
                        case "not-allowed" -> "请在安卓设置中允许 AgentOpsDeck 使用麦克风，并确认系统麦克风总开关已开启。";
                        case "network" -> "系统语音识别服务连接失败，请检查网络或改用输入法语音输入。";
                        case "language-not-supported" -> "系统语音识别服务不支持当前语言，请在系统设置中安装对应语言或更换语音识别服务。";
                        case "service-not-allowed" -> "系统语音识别服务不可用或正忙，请检查系统语音服务设置后重试。";
                        default -> null;
                    };
                    fail(session, code, message);
                }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            String language = session.language;
            if (language.length() > 64 || !language.matches("[a-zA-Z0-9-]+")) language = "zh-CN";
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, session.interim);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, "com.agentopsdeck");
            handler.postDelayed(timeout, 60000);
            session.engine.start(intent);
        } catch (SecurityException error) {
            fail(session, "not-allowed", "请在安卓应用设置中允许 AgentOpsDeck 使用麦克风。");
        } catch (RuntimeException error) {
            fail(session, "service-not-allowed", "无法启动系统语音识别，请检查手机的语音识别服务设置。");
        }
    }

    private void result(Session session, Bundle bundle, boolean complete) {
        if (active != session) return;
        ArrayList<String> results = bundle == null ? null : bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (results != null && !results.isEmpty() && !results.get(0).isBlank()) {
            session.hasText = true;
            emit(session, "result", null, results.get(0), complete);
        }
    }

    private void emit(Session session, String event, String error, String transcript, boolean complete) {
        if (session == null || active != session) return;
        try {
            JSONObject packet = new JSONObject().put("type", "speech.event").put("id", session.id).put("event", event);
            if (error != null) packet.put("error", error);
            if (transcript != null) packet.put("transcript", transcript).put("final", complete);
            session.reply.accept(packet.toString());
        } catch (Exception ignored) {}
    }

    private void fail(Session session, String error, String message) {
        if (session == null || active != session) return;
        if (message != null) host.notice(message);
        emit(session, "error", error, null, false);
        finish(session);
    }

    private void finish(Session session) {
        if (session == null || active != session) return;
        emit(session, "end", null, null, false);
        active = null;
        handler.removeCallbacks(timeout);
        if (session.engine != null) {
            try { session.engine.destroy(); } catch (RuntimeException ignored) {}
        }
    }

    void cancel() { if (active != null) fail(active, "aborted", null); }
    void pause() { foreground = false; if (active != null && active.engine != null && !active.engine.ownsActivity()) cancel(); }
    void resume() { foreground = true; if (active != null && !permissionPending && (!factory.requiresPermission() || host.granted())) start(active); }
    void activityResult(int requestCode, int resultCode, Intent data) {
        if (factory instanceof SystemSpeechFactory system) system.activityResult(requestCode, resultCode, data);
    }
    void destroy() { cancel(); handler.removeCallbacksAndMessages(null); }
}

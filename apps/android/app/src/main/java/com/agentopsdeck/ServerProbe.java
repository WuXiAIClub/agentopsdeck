package com.agentopsdeck;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class ServerProbe {
    public static boolean reachable(String origin) {
        if (!ServerAddress.isLan(origin)) return false;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + "/api/auth/status").openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(1200);
            connection.setReadTimeout(1200);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != 200) return false;
            String mime = connection.getContentType();
            if (mime == null || !mime.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) return false;
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024];
                int count;
                long deadline = android.os.SystemClock.elapsedRealtime() + 2000;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 8192 || android.os.SystemClock.elapsedRealtime() > deadline) return false;
                    output.write(buffer, 0, count);
                }
                JSONObject body = new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
                return body.opt("authenticated") instanceof Boolean && body.optJSONObject("passkeys") != null;
            }
        } catch (Exception error) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private ServerProbe() {}
}

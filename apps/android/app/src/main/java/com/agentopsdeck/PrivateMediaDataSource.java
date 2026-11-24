package com.agentopsdeck;

import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
final class PrivateMediaDataSource extends BaseDataSource {
    private final String allowedUrl;
    private final String cookie;
    private final String userAgent;
    private final String etag;
    private final String modified;
    private HttpURLConnection connection;
    private InputStream input;
    private long remaining;
    private boolean opened;
    private Uri uri;

    PrivateMediaDataSource(String allowedUrl, String cookie, String userAgent, String etag, String modified) {
        super(true);
        this.allowedUrl = allowedUrl; this.cookie = cookie; this.userAgent = userAgent;
        this.etag = etag; this.modified = modified;
    }

    static HttpURLConnection connect(String url, String cookie, String userAgent) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("User-Agent", userAgent);
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        return connection;
    }

    @Override public long open(DataSpec spec) throws IOException {
        if (!spec.uri.toString().equals(allowedUrl) || spec.httpMethod != DataSpec.HTTP_METHOD_GET) throw new IOException("Untrusted media address");
        transferInitializing(spec);
        uri = spec.uri;
        try {
            connection = connect(allowedUrl, cookie, userAgent);
            String range = "bytes=" + spec.position + "-";
            if (spec.length != C.LENGTH_UNSET) range += spec.position + spec.length - 1;
            connection.setRequestProperty("Range", range);
            int code = connection.getResponseCode();
            if (code != 200 && code != 206) throw new IOException("Media HTTP " + code);
            if (etag != null && !etag.equals(connection.getHeaderField("ETag"))) throw new IOException("Media version changed; reopen video");
            if (etag == null && modified != null && !modified.equals(connection.getHeaderField("Last-Modified"))) throw new IOException("Media version changed; reopen video");
            String type = connection.getContentType();
            if (type == null || !(type.startsWith("video/") || type.startsWith("audio/") || type.startsWith("application/octet-stream"))) throw new IOException("Invalid media content type");
            long available = connection.getContentLengthLong();
            if (code == 206) {
                Matcher match = Pattern.compile("bytes (\\d+)-(\\d+)/(?:\\d+|\\*)").matcher(String.valueOf(connection.getHeaderField("Content-Range")));
                if (!match.matches() || Long.parseLong(match.group(1)) != spec.position) throw new IOException("Invalid media range");
                available = Long.parseLong(match.group(2)) - spec.position + 1;
            }
            input = connection.getInputStream();
            if (code == 200 && spec.position > 0) {
                long skipped = 0;
                byte[] buffer = new byte[16384];
                while (skipped < spec.position) {
                    int count = input.read(buffer, 0, (int) Math.min(buffer.length, spec.position - skipped));
                    if (count < 0) throw new EOFException();
                    skipped += count;
                }
                if (available >= 0) available -= skipped;
            }
            remaining = spec.length != C.LENGTH_UNSET ? (available >= 0 ? Math.min(spec.length, available) : spec.length) : available;
            opened = true; transferStarted(spec);
            return remaining;
        } catch (IOException | RuntimeException error) { close(); throw error; }
    }

    @Override public int read(byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) return 0;
        if (remaining == 0) return C.RESULT_END_OF_INPUT;
        int count = input.read(buffer, offset, remaining < 0 ? length : (int) Math.min(length, remaining));
        if (count < 0) {
            if (remaining > 0) throw new EOFException("Incomplete media response");
            return C.RESULT_END_OF_INPUT;
        }
        if (remaining > 0) remaining -= count;
        bytesTransferred(count);
        return count;
    }

    @Override public Uri getUri() { return uri; }

    @Override public void close() {
        try { if (input != null) input.close(); } catch (IOException ignored) {}
        input = null;
        if (connection != null) connection.disconnect();
        connection = null; uri = null;
        if (opened) { opened = false; transferEnded(); }
    }
}

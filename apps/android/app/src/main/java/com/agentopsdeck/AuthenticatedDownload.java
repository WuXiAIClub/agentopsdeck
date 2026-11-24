package com.agentopsdeck;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.function.BooleanSupplier;
import java.util.function.Function;

final class AuthenticatedDownload {
    static final long MAX_BYTES = 64L * 1024 * 1024;
    static final int MAX_REDIRECTS = 3;
    private volatile boolean cancelled;
    private HttpURLConnection connection;

    synchronized void cancel() {
        cancelled = true;
        disconnect();
    }

    synchronized void disconnect() {
        if (connection != null) connection.disconnect();
        connection = null;
    }

    private void check(BooleanSupplier current) throws IOException {
        if (cancelled || Thread.currentThread().isInterrupted() || !current.getAsBoolean()) {
            throw new IOException("Download cancelled");
        }
    }

    static boolean sameOrigin(URI origin, URI candidate) {
        return candidate.getRawUserInfo() == null && candidate.getHost() != null
                && origin.getHost() != null && origin.getScheme().equalsIgnoreCase(candidate.getScheme())
                && origin.getHost().equalsIgnoreCase(candidate.getHost()) && port(origin) == port(candidate)
                && ("https".equalsIgnoreCase(candidate.getScheme()) || "http".equalsIgnoreCase(candidate.getScheme()));
    }

    private static int port(URI value) {
        return value.getPort() >= 0 ? value.getPort() : ("https".equalsIgnoreCase(value.getScheme()) ? 443 : 80);
    }

    HttpURLConnection open(String address, Function<String, String> cookies, String userAgent, String method,
                           BooleanSupplier current) throws Exception {
        URI origin = new URI(address);
        URI target = origin;
        for (int redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
            check(current);
            if (!sameOrigin(origin, target)) throw new IOException("Cross-origin download rejected");
            HttpURLConnection next = (HttpURLConnection) new URL(target.toASCIIString()).openConnection();
            synchronized (this) {
                check(current);
                connection = next;
            }
            next.setInstanceFollowRedirects(false);
            next.setConnectTimeout(15000);
            next.setReadTimeout(15000);
            next.setRequestMethod(method);
            next.setRequestProperty("Accept-Encoding", "identity");
            String cookie = cookies.apply(target.toASCIIString());
            check(current);
            if (cookie != null) next.setRequestProperty("Cookie", cookie);
            next.setRequestProperty("User-Agent", userAgent);
            int status = next.getResponseCode();
            check(current);
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = next.getHeaderField("Location");
                next.disconnect();
                if (location == null || redirects == MAX_REDIRECTS) throw new IOException("Invalid download redirect");
                target = target.resolve(new URI(location));
                continue;
            }
            return next;
        }
        throw new IOException("Download redirect limit");
    }

    File fetch(String address, Function<String, String> cookies, String userAgent, File directory,
               BooleanSupplier current) throws Exception {
        File file = null;
        HttpURLConnection response = null;
        boolean complete = false;
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MINUTES.toNanos(5);
        try {
            response = open(address, cookies, userAgent, "GET", current);
            if (response.getResponseCode() != 200) throw new IOException("Unexpected download status");
            long declared = response.getContentLengthLong();
            if (declared > MAX_BYTES) throw new IOException("Download exceeds limit");
            String encoding = response.getHeaderField("Content-Encoding");
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw new IOException("Encoded download rejected");
            String type = response.getContentType();
            if (response.getHeaderField("Content-Disposition") == null && type != null
                    && (type.toLowerCase(java.util.Locale.ROOT).startsWith("text/html")
                    || type.toLowerCase(java.util.Locale.ROOT).startsWith("application/json"))) {
                throw new IOException("Download returned a page");
            }
            file = File.createTempFile("download-", ".tmp", directory);
            long total = 0;
            try (InputStream input = response.getInputStream(); FileOutputStream output = new FileOutputStream(file)) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    check(current);
                    if (System.nanoTime() > deadline || count > MAX_BYTES - total
                            || (declared >= 0 && count > declared - total)) throw new IOException("Download limit exceeded");
                    output.write(buffer, 0, count);
                    total += count;
                }
            }
            check(current);
            if (declared >= 0 && total != declared) throw new IOException("Incomplete download");
            complete = true;
            return file;
        } finally {
            if (response != null) response.disconnect();
            disconnect();
            if (!complete && file != null) file.delete();
        }
    }
}

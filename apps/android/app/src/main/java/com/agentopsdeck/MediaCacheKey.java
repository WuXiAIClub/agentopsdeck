package com.agentopsdeck;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class MediaCacheKey {
    static String create(String url, String scope, String cookie, String validator) throws Exception {
        URI uri = URI.create(url);
        String identity = scope != null && scope.matches("[a-f0-9]{64}") ? "scope:" + scope
                : uri.getScheme() + "://" + uri.getRawAuthority() + ":" + hash(cookie == null ? "" : cookie);
        return hash(identity + "\n" + uri.getRawPath() + "?" + (uri.getRawQuery() == null ? "" : uri.getRawQuery()) + "\n" + validator);
    }

    static String hash(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte item : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
        return result.toString();
    }

    private MediaCacheKey() {}
}

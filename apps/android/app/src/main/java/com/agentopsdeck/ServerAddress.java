package com.agentopsdeck;

import java.net.URI;
import java.util.Locale;

public final class ServerAddress {
    public static final String DEFAULT = "https://deck.example.invalid";
    public static final String[] LAN_ORIGINS = {};

    public static boolean isLan(String value) {
        for (String candidate : LAN_ORIGINS) if (candidate.equals(value)) return true;
        return false;
    }

    public static String normalizeConnection(String value) {
        String candidate = value.trim();
        if (candidate.endsWith("/")) candidate = candidate.substring(0, candidate.length() - 1);
        return isLan(candidate) ? candidate : normalize(value);
    }

    public static String normalize(String value) {
        URI address;
        try {
            address = URI.create(value.trim());
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("Enter a valid HTTPS server address");
        }
        String path = address.getPath();
        if (!"https".equalsIgnoreCase(address.getScheme()) || address.getHost() == null
                || address.getRawUserInfo() != null || address.getRawQuery() != null
                || address.getRawFragment() != null || (path != null && !path.isEmpty() && !path.equals("/"))
                || address.getPort() == 0 || address.getPort() > 65535) {
            throw new IllegalArgumentException("Use an HTTPS origin without a path, credentials or query");
        }
        String host = address.getHost().toLowerCase(Locale.ROOT);
        int port = address.getPort();
        return "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
    }

    private ServerAddress() {}
}

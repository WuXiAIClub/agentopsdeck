package com.agentopsdeck;

import java.net.URI;
import java.util.Locale;

public final class ServerAddress {
    public static final String DEFAULT = "https://deck.example.invalid";

    public static boolean isLan(String value) {
        if (value == null) return false;
        try { normalizeLan(value); return true; }
        catch (IllegalArgumentException error) { return false; }
    }

    public static String normalizeConnection(String value) {
        return isLan(value) ? normalizeLan(value) : normalize(value);
    }

    public static String normalize(String value) {
        return normalizeOrigin(value, false);
    }

    public static String normalizeLan(String value) {
        return normalizeOrigin(value, true);
    }

    private static String normalizeOrigin(String value, boolean lan) {
        String message = lan ? "Use an HTTP/HTTPS private IPv4 origin without a path, credentials or query"
                : "Use an HTTPS origin without a path, credentials or query";
        if (value == null) throw new IllegalArgumentException(message);
        URI address;
        try {
            address = URI.create(value.trim());
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(message, error);
        }
        String path = address.getPath();
        boolean https = "https".equalsIgnoreCase(address.getScheme());
        if ((!https && !(lan && "http".equalsIgnoreCase(address.getScheme()))) || address.getHost() == null
                || address.getRawUserInfo() != null || address.getRawQuery() != null
                || address.getRawFragment() != null || (path != null && !path.isEmpty() && !path.equals("/"))
                || address.getPort() == 0 || address.getPort() > 65535
                || (lan && !isPrivateIpv4(address.getHost()))) {
            throw new IllegalArgumentException(message);
        }
        String host = address.getHost().toLowerCase(Locale.ROOT);
        int port = address.getPort();
        return (https ? "https://" : "http://") + host + (port == -1 || port == (https ? 443 : 80) ? "" : ":" + port);
    }

    private static boolean isPrivateIpv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int index = 0; index < parts.length; index++) {
            if (!parts[index].matches("0|[1-9][0-9]{0,2}")) return false;
            octets[index] = Integer.parseInt(parts[index]);
            if (octets[index] > 255) return false;
        }
        return octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168);
    }

    public static String contentSecurityPolicy(String origin) {
        String current = normalizeConnection(origin);
        // Android cannot express a user-selected host in its static cleartext policy.
        // CSP also guards redirected subresources, which WebView interception does not see.
        String socket = current.startsWith("http://") ? " ws" + current.substring(4) : "";
        return "default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline'; "
                + "style-src 'self' https: 'unsafe-inline'; connect-src 'self' https: wss:" + socket
                + "; object-src 'none'; base-uri 'self'; form-action 'self'";
    }

    private ServerAddress() {}
}

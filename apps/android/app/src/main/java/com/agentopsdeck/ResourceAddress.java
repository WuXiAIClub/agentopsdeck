package com.agentopsdeck;

import java.net.URI;
import java.util.Locale;

public final class ResourceAddress {
    public static String route(String value, String currentOrigin, String publicOrigin) {
        try {
            String current = ServerAddress.normalizeConnection(currentOrigin);
            String fallback = ServerAddress.normalize(publicOrigin);
            if (!ServerAddress.isLan(current) && !current.equals(fallback)) return value;
            URI address = URI.create(value);
            if (!address.isAbsolute() || address.getRawUserInfo() != null) return value;
            String source = ServerAddress.normalizeConnection(new URI(address.getScheme(), null,
                    address.getHost(), address.getPort(), null, null, null).toString());
            if (!source.equals(fallback) && !ServerAddress.isLan(source)) return value;
            String path = address.getRawPath();
            if (!isResourcePath(path) || !address.normalize().getRawPath().equals(path)) return value;
            return current + path + (address.getRawQuery() == null ? "" : "?" + address.getRawQuery())
                    + (address.getRawFragment() == null ? "" : "#" + address.getRawFragment());
        } catch (Exception error) { return value; }
    }

    private static boolean isResourcePath(String path) {
        if (path == null || path.toLowerCase(Locale.ROOT).matches(".*%(?:2e|2f|5c).*")) return false;
        return path.matches("/api/media/inbound/[\\w.-]+")
                || path.matches("/api/artifacts/[a-fA-F0-9]+")
                || path.matches("/api/files/(?:gateway|agents/[^/?#]+)/download")
                || path.matches("/api/hub/v1/(?:sessions/[^/?#]+|shared/[^/?#]+/sessions/[^/?#]+)/messages/[^/?#]+/media/[a-f0-9]{64}");
    }

    private ResourceAddress() {}
}

package com.agentopsdeck;

public final class ConnectionRouter {
    public interface Probe { boolean reachable(String origin); }

    public static String select(String publicOrigin, boolean lanEnabled, boolean wifi, Probe probe) {
        return select(publicOrigin, lanEnabled, wifi, null, probe);
    }

    public static String select(String publicOrigin, boolean lanEnabled, boolean wifi, String currentOrigin, Probe probe) {
        String fallback = ServerAddress.normalize(publicOrigin);
        if (lanEnabled && wifi) {
            if (ServerAddress.isLan(currentOrigin) && probe.reachable(currentOrigin)) return currentOrigin;
            for (String candidate : ServerAddress.LAN_ORIGINS) {
                if (candidate.equals(currentOrigin)) continue;
                if (probe.reachable(candidate)) return candidate;
            }
        }
        return fallback;
    }

    private ConnectionRouter() {}

    public static String[] manualOrigins(String publicOrigin, boolean lanEnabled, boolean wifi) {
        String fallback = ServerAddress.normalize(publicOrigin);
        if (!lanEnabled || !wifi) return new String[]{fallback};
        String[] choices = new String[ServerAddress.LAN_ORIGINS.length + 1];
        System.arraycopy(ServerAddress.LAN_ORIGINS, 0, choices, 0, ServerAddress.LAN_ORIGINS.length);
        choices[choices.length - 1] = fallback;
        return choices;
    }

    public static boolean shouldOfferSwitch(String current, String selected, boolean userRequested) {
        return userRequested && !current.equals(selected);
    }
}

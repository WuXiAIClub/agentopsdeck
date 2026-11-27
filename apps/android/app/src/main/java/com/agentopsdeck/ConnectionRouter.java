package com.agentopsdeck;

public final class ConnectionRouter {
    public interface Probe { boolean reachable(String origin); }

    public static String select(String publicOrigin, String lanOrigin, boolean lanEnabled, boolean wifi, Probe probe) {
        String[] choices = manualOrigins(publicOrigin, lanOrigin, lanEnabled, wifi);
        if (choices.length > 1 && probe.reachable(choices[0])) return choices[0];
        return choices[choices.length - 1];
    }

    private ConnectionRouter() {}

    public static String[] manualOrigins(String publicOrigin, String lanOrigin, boolean lanEnabled, boolean wifi) {
        String fallback = ServerAddress.normalize(publicOrigin);
        if (!lanEnabled || !wifi || lanOrigin == null || lanOrigin.isEmpty()) return new String[]{fallback};
        String lan = ServerAddress.normalizeLan(lanOrigin);
        return lan.equals(fallback) ? new String[]{fallback} : new String[]{lan, fallback};
    }

    public static boolean shouldOfferSwitch(String current, String selected, boolean userRequested) {
        return userRequested && !current.equals(selected);
    }
}

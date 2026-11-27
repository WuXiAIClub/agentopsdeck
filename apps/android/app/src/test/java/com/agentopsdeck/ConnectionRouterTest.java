package com.agentopsdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class ConnectionRouterTest {
    @Test public void shipsNoOperatorLanConfiguration() {
        assertArrayEquals(new String[]{"https://example.com"},
                ConnectionRouter.manualOrigins("https://example.com/", "", true, true));
    }

    @Test public void neverProbesWithoutAnExplicitAllowlist() {
        ConnectionRouter.Probe forbidden = candidate -> { throw new AssertionError("Must not probe LAN"); };
        for (boolean enabled : new boolean[]{false, true}) {
            for (boolean wifi : new boolean[]{false, true}) {
                assertEquals("https://example.com", ConnectionRouter.select("https://example.com/", "", enabled, wifi, forbidden));
            }
        }
    }

    @Test public void backgroundChecksNeverInterrupt() {
        assertFalse(ConnectionRouter.shouldOfferSwitch("https://example.com", "https://other.example", false));
        assertTrue(ConnectionRouter.shouldOfferSwitch("https://example.com", "https://other.example", true));
        assertFalse(ConnectionRouter.shouldOfferSwitch("https://example.com", "https://example.com", true));
    }

    @Test public void rejectsNonPrivateHttpOrigins() {
        for (String value : new String[]{"http://192.0.2.24:8890", "http://127.0.0.1:8890", "http://192.0.2.82:8890"}) {
            assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalizeConnection(value));
        }
    }

    @Test public void selectsOnlyConfiguredLanAndFallsBackWhenUnreachable() {
        String lan = "http://10.1.2.3:8890";
        java.util.List<String> probes = new java.util.ArrayList<>();
        assertEquals(lan, ConnectionRouter.select("https://example.com", lan, true, true, candidate -> {
            probes.add(candidate); return true;
        }));
        assertEquals(java.util.Arrays.asList(lan), probes);
        probes.clear();
        assertEquals("https://example.com", ConnectionRouter.select("https://example.com", lan, true, true, candidate -> {
            probes.add(candidate); return false;
        }));
        assertEquals(java.util.Arrays.asList(lan), probes);
        assertArrayEquals(new String[]{lan, "https://example.com"},
                ConnectionRouter.manualOrigins("https://example.com", lan, true, true));
    }

    @Test public void neverProbesConfiguredLanWhenDisabledOrOffWifi() {
        ConnectionRouter.Probe forbidden = candidate -> { throw new AssertionError("Must not probe LAN"); };
        for (boolean enabled : new boolean[]{false, true}) {
            for (boolean wifi : new boolean[]{false, true}) {
                if (enabled && wifi) continue;
                assertEquals("https://example.com",
                        ConnectionRouter.select("https://example.com", "http://10.1.2.3", enabled, wifi, forbidden));
                assertArrayEquals(new String[]{"https://example.com"},
                        ConnectionRouter.manualOrigins("https://example.com", "http://10.1.2.3", enabled, wifi));
            }
        }
    }
}

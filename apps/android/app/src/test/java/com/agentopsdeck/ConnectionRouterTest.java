package com.agentopsdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class ConnectionRouterTest {
    @Test public void shipsNoOperatorLanConfiguration() {
        assertEquals(0, ServerAddress.LAN_ORIGINS.length);
        assertArrayEquals(new String[]{"https://example.com"},
                ConnectionRouter.manualOrigins("https://example.com/", true, true));
    }

    @Test public void neverProbesWithoutAnExplicitAllowlist() {
        ConnectionRouter.Probe forbidden = candidate -> { throw new AssertionError("Must not probe LAN"); };
        for (boolean enabled : new boolean[]{false, true}) {
            for (boolean wifi : new boolean[]{false, true}) {
                assertEquals("https://example.com", ConnectionRouter.select("https://example.com/", enabled, wifi,
                        "http://192.0.2.99:8890", forbidden));
            }
        }
    }

    @Test public void backgroundChecksNeverInterrupt() {
        assertFalse(ConnectionRouter.shouldOfferSwitch("https://example.com", "https://other.example", false));
        assertTrue(ConnectionRouter.shouldOfferSwitch("https://example.com", "https://other.example", true));
        assertFalse(ConnectionRouter.shouldOfferSwitch("https://example.com", "https://example.com", true));
    }

    @Test public void rejectsEveryUnconfiguredHttpOrigin() {
        for (String value : new String[]{"http://192.0.2.24:8890", "http://127.0.0.1:8890", "http://192.0.2.82:8890"}) {
            assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalizeConnection(value));
        }
    }
}

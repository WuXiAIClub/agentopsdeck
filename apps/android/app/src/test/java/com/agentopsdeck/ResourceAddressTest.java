package com.agentopsdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class ResourceAddressTest {
    @Test public void preservesConfiguredHttpsResourceSuffixes() {
        String origin = "https://deck.example.invalid";
        String path = "/api/files/gateway/download?path=fixture.zip&name=a%20b#preview";
        assertEquals(origin + path, ResourceAddress.route(origin + path, origin, origin, new String[0]));
    }

    @Test public void neverRoutesToUnconfiguredDestinations() {
        String origin = "https://deck.example.invalid";
        String value = origin + "/api/artifacts/abc123";
        for (String destination : new String[]{"https://other.example.invalid", "http://192.0.2.24:8890"}) {
            assertEquals(value, ResourceAddress.route(value, destination, origin, new String[0]));
        }
    }

    @Test public void preservesUntrustedLinksAndTraversal() {
        String origin = "https://deck.example.invalid";
        for (String value : new String[]{"https://other.example/api/artifacts/abc", "https://user@deck.example.invalid/api/artifacts/abc",
                "http://192.0.2.24:8890/api/artifacts/abc", origin + "/api/files/agents/%2e%2e/download",
                origin + "/api/media/inbound/../file.mp4", "javascript:alert(1)"}) {
            assertEquals(value, ResourceAddress.route(value, origin, origin, new String[0]));
        }
    }

    @Test public void routesOnlyExplicitlyConfiguredLanResources() {
        String fallback = "https://deck.example.invalid";
        String lan = "http://10.1.2.3:8890";
        String otherLan = "http://10.1.2.4:8890";
        String suffix = "/api/files/gateway/download?path=fixture.zip&name=a%20b#preview";
        String[] trusted = {lan};
        assertEquals(lan + suffix, ResourceAddress.route(fallback + suffix, lan, fallback, trusted));
        assertEquals(fallback + suffix, ResourceAddress.route(lan + suffix, fallback, fallback, trusted));
        assertEquals(otherLan + suffix, ResourceAddress.route(otherLan + suffix, lan, fallback, trusted));
        assertEquals(fallback + suffix, ResourceAddress.route(fallback + suffix, otherLan, fallback, trusted));
        assertEquals(fallback + suffix, ResourceAddress.route(fallback + suffix, lan, fallback, new String[0]));
    }
}

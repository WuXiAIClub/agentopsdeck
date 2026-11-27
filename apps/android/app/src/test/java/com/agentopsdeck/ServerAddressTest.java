package com.agentopsdeck;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class ServerAddressTest {
    @Test public void normalizesHttpsOrigin() {
        assertEquals("https://deck.example.invalid", ServerAddress.normalize(" https://DECK.example.invalid:443/ "));
        assertEquals("https://example.com:8443", ServerAddress.normalize("https://example.com:8443"));
    }

    @Test public void rejectsUnsafeOrAmbiguousOrigins() {
        for (String value : new String[]{"http://example.com", "javascript:alert(1)", "https://user:secret@example.com", "https://example.com/api", "https://example.com?token=secret", "https://example.com#fragment", "https://example.com:0", "https://example.com:99999"}) {
            assertThrows(value, IllegalArgumentException.class, () -> ServerAddress.normalize(value));
        }
    }

    @Test public void normalizesOnlyPrivateIpv4LanOrigins() {
        for (String host : new String[]{"10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.20.5"}) {
            assertEquals("http://" + host, ServerAddress.normalizeLan(" HTTP://" + host + ":80/ "));
            assertEquals("https://" + host, ServerAddress.normalizeLan("https://" + host + ":443/"));
            assertEquals("http://" + host + ":8890", ServerAddress.normalizeConnection("http://" + host + ":8890"));
        }
    }

    @Test public void rejectsPublicLoopbackHostnamesAndAmbiguousLanInputs() {
        for (String host : new String[]{"9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.1",
                "192.167.1.1", "192.169.1.1", "127.0.0.1", "169.254.1.1", "example.com",
                "[::1]", "010.1.2.3", "10.1.2.256", "10.1.2", "167838211"}) {
            assertFalse(ServerAddress.isLan("http://" + host));
            assertThrows(host, IllegalArgumentException.class, () -> ServerAddress.normalizeLan("http://" + host));
        }
        for (String suffix : new String[]{"/api", "?key=fixture", "#fragment", ":0", ":65536"}) {
            assertThrows(suffix, IllegalArgumentException.class, () -> ServerAddress.normalizeLan("http://10.1.2.3" + suffix));
        }
        assertThrows(IllegalArgumentException.class, () -> ServerAddress.normalizeLan("http://user@10.1.2.3"));
    }

    @Test public void cleartextPolicyAllowsOnlySelfAndItsWebsocketOrigin() {
        String policy = ServerAddress.contentSecurityPolicy("http://10.1.2.3:8890");
        assertTrue(policy.contains("connect-src 'self' https: wss: ws://10.1.2.3:8890;"));
        assertTrue(policy.contains("default-src 'self' https: data: blob:;"));
        assertFalse(policy.contains("http:"));
        assertFalse(policy.contains("*"));
        assertFalse(ServerAddress.contentSecurityPolicy("https://deck.example.invalid").contains("ws://"));
    }
}

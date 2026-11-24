package com.agentopsdeck;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
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
}

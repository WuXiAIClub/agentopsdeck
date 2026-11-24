package com.agentopsdeck;

import static org.junit.Assert.*;
import org.junit.Test;

public class MediaCacheKeyTest {
    @Test public void verifiedServerAccountSharesMediaAcrossRoutes() throws Exception {
        String scope = "a".repeat(64);
        assertEquals(MediaCacheKey.create("http://192.0.2.24:8790/api/media/inbound/one", scope, "first", "etag:1"),
                MediaCacheKey.create("https://example.com/api/media/inbound/one", scope, "second", "etag:1"));
    }
    @Test public void accountsVersionsQueriesAndUnverifiedOriginsStaySeparate() throws Exception {
        String url = "https://example.com/api/media/inbound/one", scope = "a".repeat(64);
        String original = MediaCacheKey.create(url, scope, "cookie", "etag:1");
        assertNotEquals(original, MediaCacheKey.create(url, "b".repeat(64), "cookie", "etag:1"));
        assertNotEquals(original, MediaCacheKey.create(url, scope, "cookie", "etag:2"));
        assertNotEquals(original, MediaCacheKey.create(url + "?version=2", scope, "cookie", "etag:1"));
        assertNotEquals(MediaCacheKey.create(url, null, "cookie", "etag:1"), MediaCacheKey.create(url.replace("example.com", "other.com"), null, "cookie", "etag:1"));
        assertNotEquals(MediaCacheKey.create(url, null, "first", "etag:1"), MediaCacheKey.create(url, null, "second", "etag:1"));
    }
    @Test public void storedKeyContainsNeitherPathsNorCredentials() throws Exception {
        String key = MediaCacheKey.create("https://example.com/private.mp4?token=secret", null, "private-cookie", "etag:1");
        assertTrue(key.matches("[a-f0-9]{64}"));
    }
}

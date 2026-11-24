package com.agentopsdeck;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class CacheStoreTest {
    private CacheStore store;

    @Test public void upgradesTheVersionOneDatabaseWithoutLosingHistory() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        store.close(); context.deleteDatabase("session-cache-test.db");
        try (android.database.sqlite.SQLiteDatabase database = context.openOrCreateDatabase("session-cache-test.db", Context.MODE_PRIVATE, null)) {
            database.execSQL("CREATE TABLE cache (origin TEXT NOT NULL, cache_key TEXT NOT NULL, value TEXT NOT NULL, bytes INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(origin,cache_key))");
            database.execSQL("INSERT INTO cache VALUES (?,?,?,?,?)", new Object[]{"https://old.example", "agentopsdeck.cache.old", "history", 14, 1});
            database.setVersion(1);
        }
        store = new CacheStore(context, "session-cache-test.db");
        assertEquals("history", store.read("https://old.example", "agentopsdeck.cache.old", null));
        assertEquals(2, store.getReadableDatabase().getVersion());
        assertEquals(0, store.stats().getLong("messages"));
    }

    @Test public void duplicateMessageIdentifiersNeverLoseRows() throws Exception {
        JSONArray messages = new JSONArray();
        for (String id : new String[]{"one", "one", "one:duplicate:1"}) messages.put(new JSONObject().put("id", id));
        store.apply("https://first.example", changes("agentopsdeck.cache.messages", new JSONObject().put("messages", messages).toString()));
        assertEquals(3, new JSONObject(store.read("https://first.example", "agentopsdeck.cache.messages", null)).getJSONArray("messages").length());
    }

    @Before public void setUp() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase("session-cache-test.db");
        store = new CacheStore(context, "session-cache-test.db");
    }

    @After public void tearDown() { store.close(); }

    @Test public void persistsAndSeparatesServerOrigins() throws Exception {
        store.apply("https://first.example", changes("agentopsdeck.cache.scope.messages", "history"));
        assertEquals("history", store.snapshot("https://first.example").getString("agentopsdeck.cache.scope.messages"));
        assertEquals(0, store.snapshot("https://second.example").length());
        store.close();
        store = new CacheStore(InstrumentationRegistry.getInstrumentation().getTargetContext(), "session-cache-test.db");
        assertEquals("history", store.snapshot("https://first.example").getString("agentopsdeck.cache.scope.messages"));
    }

    @Test public void ignoresNonCacheKeysAndDeletesPersistedEntries() throws Exception {
        store.apply("https://first.example", changes("agentopsdeck.accessKey", "secret"));
        assertEquals(0, store.snapshot("https://first.example").length());
        store.apply("https://first.example", changes("agentopsdeck.cache.scope.messages", "history"));
        store.apply("https://first.example", changes("agentopsdeck.cache.scope.messages", JSONObject.NULL));
        assertEquals(0, store.snapshot("https://first.example").length());
    }

    @Test public void originClearDoesNotEraseOtherServers() throws Exception {
        store.apply("https://first.example", changes("agentopsdeck.cache.a", "one"));
        store.apply("https://second.example", changes("agentopsdeck.cache.b", "two"));
        store.clearOrigin("https://first.example");
        assertEquals(0, store.snapshot("https://first.example").length());
        assertEquals(1, store.snapshot("https://second.example").length());
    }

    @Test public void verifiedScopeSharesRoutesButNotAccounts() throws Exception {
        String scope = "a".repeat(64), key = "agentopsdeck.cache.v2." + scope + ".android.sessions";
        store.apply("https://first.example", changes(key, "sessions"), scope);
        assertEquals("sessions", store.read("http://192.0.2.82:8790", key, scope));
        assertNull(store.read("https://other.example", key, "b".repeat(64)));
        assertNull(store.read("https://other.example", key, null));
    }

    @Test public void normalizesMessagesAndPreservesOrderedPagesAndWatermarks() throws Exception {
        String scope = "a".repeat(64), key = "agentopsdeck.cache.transport." + scope + ".history";
        JSONObject page = new JSONObject().put("messages", new JSONArray().put(new JSONObject().put("id", "one").put("text", "before"))
                .put(new JSONObject().put("id", "two").put("text", "same"))).put("revision", "r1").put("sourceCursor", "cursor");
        JSONObject record = new JSONObject().put("etag", "first").put("page", page);
        store.apply("https://first.example", changes(key, record.toString()), scope);
        assertEquals(2, store.stats().getLong("messages"));
        page.put("messages", new JSONArray().put(new JSONObject().put("id", "two").put("text", "same"))
                .put(new JSONObject().put("id", "one").put("text", "edited"))).put("revision", "r2");
        store.apply("https://first.example", changes(key, record.toString()), scope);
        JSONObject restored = new JSONObject(store.read("https://second.example", key, scope));
        assertEquals("cursor", restored.getJSONObject("page").getString("sourceCursor"));
        assertEquals("r2", restored.getJSONObject("page").getString("revision"));
        assertEquals("two", restored.getJSONObject("page").getJSONArray("messages").getJSONObject(0).getString("id"));
        assertEquals("edited", restored.getJSONObject("page").getJSONArray("messages").getJSONObject(1).getString("text"));
        store.clearAll(); assertEquals(0, store.stats().getLong("messages"));
    }

    @Test public void migratesLegacySnapshotsOnlyAfterMatchingScope() throws Exception {
        String scope = "a".repeat(64), prefix = "agentopsdeck.cache.v2." + scope;
        store.apply("https://first.example", changes(prefix + ".oldhash.messages.session", "legacy"));
        assertNull(store.read("https://second.example", prefix + ".android.messages.session", null));
        assertEquals("legacy", store.read("https://second.example", prefix + ".android.messages.session", scope));
    }

    private JSONArray changes(String key, Object value) throws Exception {
        return new JSONArray().put(new JSONObject().put("key", key).put("value", value));
    }
}

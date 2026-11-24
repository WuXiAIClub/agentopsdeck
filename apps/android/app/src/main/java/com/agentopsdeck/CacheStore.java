package com.agentopsdeck;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class CacheStore extends SQLiteOpenHelper {
    private static final long MAX_BYTES = 96L * 1024 * 1024;
    private static final int MAX_ENTRY_CHARS = 4 * 1024 * 1024;

    public CacheStore(Context context) { this(context, "session-cache.db"); }

    CacheStore(Context context, String databaseName) {
        super(context, databaseName, null, 2);
        setWriteAheadLoggingEnabled(true);
    }

    @Override public void onConfigure(SQLiteDatabase database) { database.setForeignKeyConstraintsEnabled(true); }

    @Override public void onCreate(SQLiteDatabase database) {
        database.execSQL("CREATE TABLE cache (origin TEXT NOT NULL, cache_key TEXT NOT NULL, value TEXT NOT NULL, bytes INTEGER NOT NULL, updated INTEGER NOT NULL, message_path TEXT, PRIMARY KEY(origin,cache_key))");
        createMessages(database);
    }

    private void createMessages(SQLiteDatabase database) {
        database.execSQL("CREATE TABLE cache_messages (origin TEXT NOT NULL, cache_key TEXT NOT NULL, message_id TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(origin,cache_key,message_id), FOREIGN KEY(origin,cache_key) REFERENCES cache(origin,cache_key) ON DELETE CASCADE)");
        database.execSQL("CREATE INDEX IF NOT EXISTS cache_lru ON cache(updated)");
    }

    @Override public void onUpgrade(SQLiteDatabase database, int previous, int next) {
        if (previous < 2) {
            database.execSQL("ALTER TABLE cache ADD COLUMN message_path TEXT");
            createMessages(database);
        }
    }

    public synchronized JSONObject snapshot(String origin) throws Exception {
        JSONObject entries = new JSONObject();
        try (Cursor cursor = getReadableDatabase().query("cache", new String[]{"cache_key"}, "origin=?", new String[]{origin}, null, null, "updated DESC")) {
            while (cursor.moveToNext()) entries.put(cursor.getString(0), read(origin, cursor.getString(0), null));
        }
        return entries;
    }

    static String owner(String origin, String key, String scope) {
        if (scope != null && scope.matches("[a-f0-9]{64}") && (key.startsWith("agentopsdeck.cache.v2." + scope + ".android.")
                || key.startsWith("agentopsdeck.cache.transport." + scope + "."))) return "scope:" + scope;
        return origin;
    }

    public synchronized String read(String origin, String key, String scope) throws Exception {
        if (!validKey(key)) return null;
        String owner = owner(origin, key, scope);
        SQLiteDatabase database = getWritableDatabase();
        String value = null, messagePath = null;
        try (Cursor cursor = database.query("cache", new String[]{"value", "message_path"}, "origin=? AND cache_key=?", new String[]{owner, key}, null, null, null)) {
            if (cursor.moveToFirst()) { value = cursor.getString(0); messagePath = cursor.getString(1); }
        }
        if (value == null && owner.startsWith("scope:") && key.startsWith("agentopsdeck.cache.v2.")) {
            String prefix = "agentopsdeck.cache.v2." + scope + ".";
            String suffix = key.substring((prefix + "android").length());
            try (Cursor cursor = database.query("cache", new String[]{"value"}, "cache_key LIKE ? AND message_path IS NULL", new String[]{prefix + "%" + suffix}, null, null, "updated DESC", "1")) {
                if (cursor.moveToFirst()) value = cursor.getString(0);
            }
            if (value != null) apply(origin, new JSONArray().put(new JSONObject().put("key", key).put("value", value)), scope);
        }
        if (value == null) return null;
        if (messagePath != null) {
            JSONObject entry = new JSONObject(value);
            JSONArray messages = new JSONArray();
            try (Cursor cursor = database.query("cache_messages", new String[]{"value"}, "origin=? AND cache_key=?", new String[]{owner, key}, null, null, "position ASC")) {
                while (cursor.moveToNext()) messages.put(new JSONObject(cursor.getString(0)));
            }
            (messagePath.equals("page") ? entry.getJSONObject("page") : entry).put("messages", messages);
            value = entry.toString();
        }
        ContentValues touched = new ContentValues(); touched.put("updated", System.currentTimeMillis());
        database.update("cache", touched, "origin=? AND cache_key=?", new String[]{owner, key});
        return value;
    }

    public synchronized void apply(String origin, JSONArray changes) throws Exception { apply(origin, changes, null); }

    public synchronized void apply(String origin, JSONArray changes, String scope) throws Exception {
        if (changes.length() > 256) throw new IllegalArgumentException("Too many cache changes");
        SQLiteDatabase database = getWritableDatabase();
        database.beginTransaction();
        try {
            for (int index = 0; index < changes.length(); index++) {
                JSONObject change = changes.getJSONObject(index);
                String key = change.getString("key");
                if (!validKey(key)) continue;
                String owner = owner(origin, key, scope);
                if (change.isNull("value")) { database.delete("cache", "origin=? AND cache_key=?", new String[]{owner, key}); continue; }
                String value = change.getString("value");
                if (value.length() > MAX_ENTRY_CHARS) throw new IllegalArgumentException("Cache entry exceeds limit");
                String metadata = value, messagePath = null;
                JSONArray messages = null;
                try {
                    JSONObject entry = new JSONObject(value);
                    JSONObject container = entry.optJSONObject("page") != null ? entry.getJSONObject("page") : entry;
                    messages = container.optJSONArray("messages");
                    if (messages != null) {
                        for (int position = 0; position < messages.length(); position++) messages.getJSONObject(position);
                        messagePath = container == entry ? "root" : "page";
                        container.remove("messages"); metadata = entry.toString();
                    }
                } catch (org.json.JSONException ignored) { messages = null; messagePath = null; metadata = value; }
                ContentValues row = new ContentValues();
                row.put("origin", owner); row.put("cache_key", key); row.put("value", metadata);
                row.put("bytes", 2L * value.length()); row.put("updated", System.currentTimeMillis()); row.put("message_path", messagePath);
                int updated = database.update("cache", row, "origin=? AND cache_key=?", new String[]{owner, key});
                if (updated == 0) database.insertOrThrow("cache", null, row);
                Map<String, String> previous = new HashMap<>();
                Map<String, Integer> positions = new HashMap<>();
                try (Cursor cursor = database.query("cache_messages", new String[]{"message_id", "value", "position"}, "origin=? AND cache_key=?", new String[]{owner, key}, null, null, null)) {
                    while (cursor.moveToNext()) { previous.put(cursor.getString(0), cursor.getString(1)); positions.put(cursor.getString(0), cursor.getInt(2)); }
                }
                Set<String> used = new HashSet<>();
                Map<String, Integer> occurrences = new HashMap<>();
                if (messages != null) for (int position = 0; position < messages.length(); position++) {
                    JSONObject message = messages.getJSONObject(position);
                    String baseId = message.optString("id", "position:" + position);
                    int occurrence = occurrences.getOrDefault(baseId, 0);
                    occurrences.put(baseId, occurrence + 1);
                    String id = new JSONArray().put(baseId).put(occurrence).toString();
                    used.add(id);
                    String serialized = message.toString();
                    if (serialized.equals(previous.get(id)) && positions.get(id) == position) continue;
                    ContentValues item = new ContentValues(); item.put("origin", owner); item.put("cache_key", key);
                    item.put("message_id", id); item.put("position", position); item.put("value", serialized);
                    database.insertWithOnConflict("cache_messages", null, item, SQLiteDatabase.CONFLICT_REPLACE);
                }
                for (String id : previous.keySet()) if (!used.contains(id)) database.delete("cache_messages", "origin=? AND cache_key=? AND message_id=?", new String[]{owner, key, id});
            }
            long total = DatabaseUtils.longForQuery(database, "SELECT COALESCE(SUM(bytes),0) FROM cache", null);
            long count = DatabaseUtils.queryNumEntries(database, "cache");
            while (total > MAX_BYTES || count > 320) {
                try (Cursor oldest = database.rawQuery("SELECT origin,cache_key,bytes FROM cache ORDER BY updated ASC LIMIT 1", null)) {
                    if (!oldest.moveToFirst()) break;
                    total -= oldest.getLong(2); count--;
                    database.delete("cache", "origin=? AND cache_key=?", new String[]{oldest.getString(0), oldest.getString(1)});
                }
            }
            database.setTransactionSuccessful();
        } finally { database.endTransaction(); }
    }

    private boolean validKey(String key) { return key.startsWith("agentopsdeck.cache.") && key.length() <= 2048; }
    public synchronized void clearOrigin(String origin) { getWritableDatabase().delete("cache", "origin=?", new String[]{origin}); }
    public synchronized void clearAll() { getWritableDatabase().delete("cache", null, null); }
    public synchronized JSONObject stats() throws Exception {
        return new JSONObject().put("entries", DatabaseUtils.queryNumEntries(getReadableDatabase(), "cache"))
                .put("messages", DatabaseUtils.queryNumEntries(getReadableDatabase(), "cache_messages"))
                .put("bytes", DatabaseUtils.longForQuery(getReadableDatabase(), "SELECT COALESCE(SUM(bytes),0) FROM cache", null));
    }
}

package com.agentopsdeck;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.security.NetworkSecurityPolicy;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ServerConnectionTest {
    @Test public void httpIsLimitedToExplicitComputerAddresses() {
        NetworkSecurityPolicy policy = NetworkSecurityPolicy.getInstance();
        assertFalse(policy.isCleartextTrafficPermitted("192.0.2.24"));
        assertFalse(policy.isCleartextTrafficPermitted("192.0.2.82"));
        assertFalse(policy.isCleartextTrafficPermitted("example.com"));
        assertFalse(policy.isCleartextTrafficPermitted("192.0.2.25"));
        assertFalse(policy.isCleartextTrafficPermitted("127.0.0.1"));
    }

    @Test public void liveLanWebViewLoadsApiAndCryptoBridge() throws Exception {
        Assume.assumeTrue("Operator LAN fixture is not distributed", ServerAddress.LAN_ORIGINS.length > 0);
        Assume.assumeTrue("Explicit live LAN opt-in", "true".equals(InstrumentationRegistry.getArguments().getString("lanProbe")));
        assertTrue("Actual computer LAN endpoint is reachable from Android", ServerProbe.reachable(ServerAddress.LAN_ORIGINS[0]));
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Field origin = MainActivity.class.getDeclaredField("origin");
        Field web = MainActivity.class.getDeclaredField("webView");
        Field generation = MainActivity.class.getDeclaredField("connectionGeneration");
        Method create = MainActivity.class.getDeclaredMethod("createWebView");
        for (Field field : new Field[]{origin, web, generation}) field.setAccessible(true);
        create.setAccessible(true);
        try {
            Thread.sleep(5000);
            instrumentation.runOnMainSync(() -> {
                try {
                    generation.setInt(activity, generation.getInt(activity) + 1);
                    origin.set(activity, ServerAddress.LAN_ORIGINS[0]);
                    create.invoke(activity);
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            AtomicReference<String> result = new AtomicReference<>();
            String loginKey = InstrumentationRegistry.getArguments().getString("lanLoginKey");
            String login = loginKey == null ? "const loginStatus=null,sessionsStatus=null;" :
                    "const login=await fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({accessKey:" + JSONObject.quote(loginKey) + "})});const loginStatus=login.status;const sessions=await fetch('/api/hub/v1/sessions/state',{credentials:'include'});const sessionsStatus=sessions.status;";
            String resourceUrl = InstrumentationRegistry.getArguments().getString("resourceUrl");
            String resourceCheck = "const path='/api/media/inbound/routing-test.mp4?name=a%20b#preview';const anchor=document.createElement('a');anchor.href="
                    + JSONObject.quote(ServerAddress.DEFAULT) + "+path;document.body.append(anchor);await new Promise(resolve=>setTimeout(resolve,0));const routedAnchor=anchor.href;anchor.remove();const routedVideo=window.__AGENTOPSDECK_RESOURCE_URL__(" + JSONObject.quote(ServerAddress.DEFAULT) + "+path);";
            resourceCheck += resourceUrl == null ? "const resourceStatus=null,resourceBytes=null,resourceRange=null;" :
                    "const resource=await fetch(window.__AGENTOPSDECK_RESOURCE_URL__(" + JSONObject.quote(resourceUrl) + "),{credentials:'same-origin',headers:{Range:'bytes=0-31'}});const resourceStatus=resource.status,resourceRange=resource.headers.get('content-range'),resourceBytes=(await resource.arrayBuffer()).byteLength;";
            String expression = "(async()=>{if(!window.__AGENTOPSDECK_CACHE_STORAGE__)return null;" + login + resourceCheck + "const response=await fetch('/api/auth/status');const status=await response.json();const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('abc'));return JSON.stringify({origin:location.origin,bridge:!!window.AgentOpsDeckNative,uuid:crypto.randomUUID(),routedAnchor,routedVideo,resourceStatus,resourceBytes,resourceRange,status:response.status,authType:typeof status.authenticated,authenticated:status.authenticated,loginStatus,sessionsStatus,hash:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')})})().then(value=>{window.__lanTest=value},error=>{window.__lanTest=JSON.stringify({error:String(error)})});void 0";
            AtomicReference<Boolean> ready = new AtomicReference<>(false);
            for (int attempt = 0; attempt < 90 && !ready.get(); attempt++) {
                Thread.sleep(1000);
                CountDownLatch callback = new CountDownLatch(1);
                instrumentation.runOnMainSync(() -> {
                    try { ((WebView) web.get(activity)).evaluateJavascript("Boolean(window.__AGENTOPSDECK_CACHE_STORAGE__ && window.__AGENTOPSDECK_RESOURCE_URL__)", value -> {
                        ready.set("true".equals(value));
                        callback.countDown();
                    }); }
                    catch (Exception error) { throw new RuntimeException(error); }
                });
                assertTrue(callback.await(5, TimeUnit.SECONDS));
            }
            assertTrue("Bundled LAN runtime and exact-origin native cache bridge initialized", ready.get());
            instrumentation.runOnMainSync(() -> {
                try { ((WebView) web.get(activity)).evaluateJavascript(expression, null); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
            for (int attempt = 0; attempt < 30 && result.get() == null; attempt++) {
                Thread.sleep(1000);
                CountDownLatch callback = new CountDownLatch(1);
                instrumentation.runOnMainSync(() -> {
                    try { ((WebView) web.get(activity)).evaluateJavascript("window.__lanTest || null", value -> {
                        if (!"null".equals(value)) result.set(value);
                        callback.countDown();
                    }); }
                    catch (Exception error) { throw new RuntimeException(error); }
                });
                assertTrue(callback.await(5, TimeUnit.SECONDS));
            }
            assertNotNull("LAN WebView API and native digest completed", result.get());
            JSONObject body = new JSONObject(new org.json.JSONArray("[" + result.get() + "]").getString(0));
            assertEquals(ServerAddress.LAN_ORIGINS[0], body.getString("origin"));
            String routed = ServerAddress.LAN_ORIGINS[0] + "/api/media/inbound/routing-test.mp4?name=a%20b#preview";
            assertEquals("Rendered download anchor uses LAN", routed, body.getString("routedAnchor"));
            assertEquals("Video resource mapper uses LAN", routed, body.getString("routedVideo"));
            if (resourceUrl != null) {
                assertEquals("Actual mapped resource supports range reads", 206, body.getInt("resourceStatus"));
                assertEquals(32, body.getInt("resourceBytes"));
                assertTrue(body.getString("resourceRange").startsWith("bytes 0-31/"));
            }
            assertTrue(body.getBoolean("bridge"));
            assertEquals(200, body.getInt("status"));
            assertEquals("boolean", body.getString("authType"));
            if (loginKey != null) {
                assertEquals("Existing key login over LAN", 200, body.getInt("loginStatus"));
                assertTrue("LAN cookie authenticates subsequent requests", body.getBoolean("authenticated"));
                assertEquals("Read-only existing session list request", 200, body.getInt("sessionsStatus"));
            }
            assertTrue(body.getString("uuid").matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", body.getString("hash"));
        } finally {
            instrumentation.runOnMainSync(activity::finish);
        }
    }
}

package com.agentopsdeck;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.FileInputStream;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.security.MessageDigest;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DownloadTest {
    @Test public void stagesOriginalBytesPrivatelyBeforeExplicitSave() throws Exception {
        String url = InstrumentationRegistry.getArguments().getString("downloadUrl");
        String name = InstrumentationRegistry.getArguments().getString("downloadName");
        String expectedHash = InstrumentationRegistry.getArguments().getString("downloadHash");
        Assume.assumeNotNull(url, name, expectedHash);
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        try {
            Method download = MainActivity.class.getDeclaredMethod("download", String.class, String.class, String.class);
            download.setAccessible(true);
            instrumentation.runOnMainSync(() -> {
                try { download.invoke(activity, url, null, null); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
            boolean clicked = false;
            for (int attempt = 0; attempt < 45 && !clicked; attempt++) {
                Thread.sleep(1000);
                AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
                if (root == null || root.findAccessibilityNodeInfosByText(name).isEmpty()) continue;
                for (AccessibilityNodeInfo button : root.findAccessibilityNodeInfosByText(context.getString(com.agentopsdeck.R.string.download_action))) {
                    if ("android:id/button1".equals(button.getViewIdResourceName())) clicked = button.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                }
            }
            assertTrue("Download confirmation contains the original filename", clicked);
            Field pending = MainActivity.class.getDeclaredField("pendingFile");
            pending.setAccessible(true);
            File[] staged = new File[1];
            for (int attempt = 0; attempt < 90; attempt++) {
                Thread.sleep(1000);
                instrumentation.runOnMainSync(() -> {
                    try { staged[0] = (File) pending.get(activity); }
                    catch (Exception error) { throw new RuntimeException(error); }
                });
                if (staged[0] != null) break;
            }
            assertNotNull("Private download completes before save selection", staged[0]);
            assertEquals(context.getCacheDir().getCanonicalFile(), staged[0].getParentFile().getCanonicalFile());
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (FileInputStream input = new FileInputStream(staged[0])) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) >= 0) digest.update(buffer, 0, count);
            }
            StringBuilder hash = new StringBuilder();
            for (byte value : digest.digest()) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            assertEquals("Downloaded bytes match the published file", expectedHash, hash.toString());
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }
}

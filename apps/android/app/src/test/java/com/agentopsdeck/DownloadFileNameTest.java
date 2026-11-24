package com.agentopsdeck;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class DownloadFileNameTest {
    private static final String URL = "https://deck.example.invalid/api/artifacts/opaque-id/download";

    @Test public void usesServerNameInsteadOfRouteName() {
        assertEquals("report.pdf", DownloadFileName.resolve(URL, "attachment; filename=\"report.pdf\"", "download.bin"));
    }

    @Test public void prefersUtf8NameAndPreservesPlus() {
        assertEquals("\u62a5\u544a+2026.zip", DownloadFileName.resolve(URL, "attachment; filename=\"__2026.zip\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A+2026.zip", "download.bin"));
    }

    @Test public void handlesLanguageAndQuotedSemicolon() {
        assertEquals("hello world.txt", DownloadFileName.resolve(URL, "attachment; filename*=UTF-8'en'hello%20world.txt", "download.bin"));
        assertEquals("report;final.csv", DownloadFileName.resolve(URL, "attachment; filename=\"report;final.csv\"", "download.bin"));
    }

    @Test public void fallsBackAfterMalformedExtendedName() {
        assertEquals("fallback.mp4", DownloadFileName.resolve(URL, "inline; filename=\"fallback.mp4\"; filename*=UTF-8''%ZZ", "download.bin"));
    }

    @Test public void usesFileBrowserQueryAndEncodedUrlName() {
        assertEquals("\u89c6\u9891.mp4", DownloadFileName.resolve(URL + "?path=output%2F%E8%A7%86%E9%A2%91.mp4", null, "download.bin"));
        assertEquals("hello+world.zip", DownloadFileName.resolve("https://example.com/api/media/hello+world.zip", null, "download.bin"));
    }

    @Test public void removesDirectoriesAndUnsafeCharacters() {
        assertEquals("file_.pdf", DownloadFileName.resolve(URL, "attachment; filename*=UTF-8''..%2Ffile%0A.pdf", "download.bin"));
        assertEquals("download.bin", DownloadFileName.resolve(URL, "attachment; filename=\"..\"", "download.bin"));
    }
}

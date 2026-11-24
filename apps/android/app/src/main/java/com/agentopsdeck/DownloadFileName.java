package com.agentopsdeck;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class DownloadFileName {
    private static final Pattern EXTENDED = Pattern.compile("(?:^|;)\\s*filename\\*\\s*=\\s*(?:\"([^\"]*)\"|([^;]*))", Pattern.CASE_INSENSITIVE);
    private static final Pattern PLAIN = Pattern.compile("(?:^|;)\\s*filename\\s*=\\s*(?:\"((?:\\\\.|[^\"])*)\"|([^;]*))", Pattern.CASE_INSENSITIVE);

    static String resolve(String url, String disposition, String fallback) {
        if (disposition != null) {
            Matcher extended = EXTENDED.matcher(disposition);
            if (extended.find()) {
                String value = extended.group(1) != null ? extended.group(1) : extended.group(2).trim();
                String[] parts = value.split("'", 3);
                if (parts.length == 3 && parts[0].equalsIgnoreCase("UTF-8")) {
                    try {
                        String name = clean(decode(parts[2]));
                        if (!name.isEmpty()) return name;
                    } catch (IllegalArgumentException ignored) { }
                }
            }
            Matcher plain = PLAIN.matcher(disposition);
            if (plain.find()) {
                String name = clean(plain.group(1) != null ? plain.group(1).replaceAll("\\\\(.)", "$1") : plain.group(2).trim());
                if (!name.isEmpty()) return name;
            }
        }
        try {
            URI uri = URI.create(url);
            if (uri.getRawQuery() != null) {
                for (String parameter : uri.getRawQuery().split("&")) {
                    String[] pair = parameter.split("=", 2);
                    if (pair.length == 2 && (pair[0].equals("path") || pair[0].equals("filename") || pair[0].equals("name"))) {
                        String name = clean(URLDecoder.decode(pair[1], StandardCharsets.UTF_8.name()));
                        if (!name.isEmpty()) return name;
                    }
                }
            }
            String name = clean(decode(uri.getRawPath() == null ? "" : uri.getRawPath()));
            if (name.contains(".") && !name.startsWith(".")) return name;
        } catch (Exception ignored) { }
        String name = clean(fallback);
        return name.isEmpty() ? "download" : name;
    }

    private static String decode(String value) {
        try { return URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8.name()); }
        catch (java.io.UnsupportedEncodingException error) { throw new IllegalArgumentException(error); }
    }

    private static String clean(String value) {
        if (value == null) return "";
        String name = value.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}<>:\"|?*]", "_").trim();
        if (name.equals(".") || name.equals("..")) return "";
        return name;
    }
}

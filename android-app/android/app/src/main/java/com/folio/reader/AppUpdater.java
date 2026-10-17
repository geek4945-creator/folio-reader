package com.folio.reader;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Pattern;

/**
 * In-app updater: checks the GitHub "latest release" of this app's own repo, downloads the APK, and hands it to the
 * system installer through a FileProvider. Android always shows its own Install/Update confirmation.
 * Same package + same signing key as the installed app, so it installs over the top and keeps user data.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdater extends Plugin {

    private File dir() {
        File d = new File(getContext().getCacheDir(), "updates");
        d.mkdirs();
        return d;
    }

    private PackageInfo pkg() throws PackageManager.NameNotFoundException {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
    }

    private long code(PackageInfo pi) {
        return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
    }

    /** "v0.5.14-debug" -> [0,5,14]. */
    static int[] parseVersion(String v) {
        String s = v.trim();
        if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
        int dash = s.indexOf('-'); if (dash >= 0) s = s.substring(0, dash);
        int plus = s.indexOf('+'); if (plus >= 0) s = s.substring(0, plus);
        String[] parts = s.split("\\.");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            int n = 0; int j = 0;
            while (j < parts[i].length() && Character.isDigit(parts[i].charAt(j))) { n = n * 10 + (parts[i].charAt(j) - '0'); j++; }
            out[i] = n;
        }
        return out;
    }

    static boolean isNewer(String remote, String local) {
        int[] a = parseVersion(remote), b = parseVersion(local);
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int x = i < a.length ? a[i] : 0, y = i < b.length ? b[i] : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    @PluginMethod
    public void info(PluginCall call) {
        try {
            PackageInfo pi = pkg();
            JSObject o = new JSObject();
            o.put("versionName", pi.versionName);
            o.put("versionCode", code(pi));
            o.put("packageName", getContext().getPackageName());
            call.resolve(o);
        } catch (Exception e) {
            call.reject("info failed: " + e.getMessage());
        }
    }

    /** check({ repo: "owner/name", asset: "regex for the APK file name" }) */
    @PluginMethod
    public void check(final PluginCall call) {
        final String repo = call.getString("repo");
        final String asset = call.getString("asset", ".*\\.apk");
        if (repo == null || !repo.matches("[\\w.-]+/[\\w.-]+")) { call.reject("repo required"); return; }
        new Thread(() -> {
            try {
                PackageInfo pi = pkg();
                HttpURLConnection c = (HttpURLConnection) new URL("https://api.github.com/repos/" + repo + "/releases/latest").openConnection();
                c.setConnectTimeout(10000); c.setReadTimeout(15000);
                c.setRequestProperty("Accept", "application/vnd.github+json");
                c.setRequestProperty("User-Agent", getContext().getPackageName() + "/" + pi.versionName);
                String body;
                try {
                    if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
                    body = readAll(c.getInputStream());
                } finally { c.disconnect(); }
                JSONObject rel = new JSONObject(body);
                JSObject out = new JSObject();
                out.put("current", pi.versionName);
                out.put("available", false);
                String tag = rel.optString("tag_name", "").replaceFirst("^[vV]", "");
                JSONArray assets = rel.optJSONArray("assets");
                Pattern p = Pattern.compile(asset);
                if (!rel.optBoolean("draft") && !rel.optBoolean("prerelease") && assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject a = assets.getJSONObject(i);
                        if (!p.matcher(a.optString("name")).matches()) continue;
                        String url = a.optString("browser_download_url");
                        if (!url.startsWith("https://")) continue;
                        out.put("latest", tag);
                        out.put("page", rel.optString("html_url"));
                        if (isNewer(tag, pi.versionName)) {
                            out.put("available", true);
                            out.put("version", tag);
                            out.put("apkUrl", url);
                            out.put("size", a.optLong("size", -1));
                        }
                        break;
                    }
                }
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Couldn't check for updates (" + e.getMessage() + ")");
            }
        }).start();
    }

    /** install({ apkUrl, size, version }) - downloads, validates and opens the system installer. */
    @PluginMethod
    public void install(final PluginCall call) {
        final String url = call.getString("apkUrl");
        final long size = call.getLong("size", -1L);
        final String version = call.getString("version", "new");
        if (url == null || !url.startsWith("https://")) { call.reject("apkUrl required"); return; }
        new Thread(() -> {
            try {
                PackageInfo pi = pkg();
                File target = new File(dir(), "update-" + version.replaceAll("[^\\w.-]", "_") + ".apk");
                if (!(target.exists() && valid(target, size, pi))) {
                    File[] old = dir().listFiles();
                    if (old != null) for (File f : old) f.delete();
                    File part = new File(dir(), target.getName() + ".part");
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(15000); c.setReadTimeout(30000);
                    c.setRequestProperty("User-Agent", getContext().getPackageName() + "/" + pi.versionName);
                    try {
                        if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
                        long total = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : size;
                        long done = 0; int last = -1;
                        try (InputStream in = c.getInputStream(); OutputStream out = new java.io.FileOutputStream(part)) {
                            byte[] buf = new byte[32 * 1024]; int n;
                            while ((n = in.read(buf)) >= 0) {
                                out.write(buf, 0, n); done += n;
                                if (total > 0) {
                                    int pct = (int) (done * 100 / total);
                                    if (pct != last) { last = pct; JSObject ev = new JSObject(); ev.put("percent", pct); notifyListeners("progress", ev); }
                                }
                            }
                        }
                    } finally { c.disconnect(); }
                    if (!part.renameTo(target)) { part.delete(); call.reject("Couldn't save the update."); return; }
                    if (!valid(target, size, pi)) { target.delete(); call.reject("The downloaded file isn't a valid update for this app."); return; }
                }
                if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                    s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(s);
                    call.reject("Allow \"Install unknown apps\" for this app in the screen that just opened, then tap Update again.", "NEED_PERMISSION");
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", target);
                Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                JSObject ok = new JSObject(); ok.put("launched", true);
                call.resolve(ok);
            } catch (Exception e) {
                call.reject("Update failed (" + e.getMessage() + ")");
            }
        }).start();
    }

    /** Must be this package, a higher versionCode than installed, and the expected size when known. */
    private boolean valid(File f, long size, PackageInfo installed) {
        if (size > 0 && f.length() != size) return false;
        PackageInfo pi = getContext().getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
        if (pi == null) return false;
        return getContext().getPackageName().equals(pi.packageName) && code(pi) > code(installed);
    }

    private static String readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192]; int n;
        while ((n = in.read(buf)) >= 0) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }
}

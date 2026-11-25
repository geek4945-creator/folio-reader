package com.folio.reader;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens a link in another app (v0.5.18: Chirp audiobooks, which are DRM-protected and can only be played in Chirp).
 * Only allow-listed packages and https links: if the app is installed the link is handed to it (or the app is simply
 * launched when it doesn't handle the link); otherwise the link opens in the browser.
 */
@CapacitorPlugin(name = "ExternalApp")
public class ExternalApp extends Plugin {
    private static final String[] ALLOWED = { "com.chirpbooks.chirp" };

    private static boolean allowed(String pkg) {
        for (String p : ALLOWED) if (p.equals(pkg)) return true;
        return false;
    }

    @PluginMethod
    public void isInstalled(PluginCall call) {
        String pkg = call.getString("package", "");
        JSObject r = new JSObject();
        r.put("installed", allowed(pkg) && getContext().getPackageManager().getLaunchIntentForPackage(pkg) != null);
        call.resolve(r);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String pkg = call.getString("package", "");
        String url = call.getString("url", "");
        if (!allowed(pkg)) { call.reject("Package not allowed"); return; }
        Uri uri = Uri.parse(url);
        if (uri == null || !"https".equals(uri.getScheme())) { call.reject("Only https links"); return; }
        PackageManager pm = getContext().getPackageManager();
        JSObject r = new JSObject();
        try {
            Intent launch = pm.getLaunchIntentForPackage(pkg);
            if (launch != null) {
                Intent inApp = new Intent(Intent.ACTION_VIEW, uri).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (inApp.resolveActivity(pm) != null) { getContext().startActivity(inApp); r.put("opened", "app-link"); }
                else { launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(launch); r.put("opened", "app"); }
            } else {
                Intent web = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(web); r.put("opened", "browser");
            }
            call.resolve(r);
        } catch (ActivityNotFoundException e) {
            call.reject("No app can open this link");
        }
    }
    /**
     * v0.5.25: Google sign-in for the Android app. Google blocks OAuth inside WebViews, so Folio opens its own sign-in page
     * (GitHub Pages) in the phone's browser; that page sends the token back through com.folio.reader://oauth (MainActivity).
     * Only Folio's own web address is allowed. The browser package is set explicitly so an installed Folio web app (WebAPK)
     * can't catch the link instead of the browser.
     */
    private static final String SIGNIN_PREFIX = "https://geek4945-creator.github.io/folio-reader/";

    @PluginMethod
    public void openBrowser(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith(SIGNIN_PREFIX)) { call.reject("Only Folio sign-in links"); return; }
        Uri uri = Uri.parse(url);
        PackageManager pm = getContext().getPackageManager();
        Intent web = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            android.content.pm.ResolveInfo ri = pm.resolveActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/")).addCategory(Intent.CATEGORY_BROWSABLE), PackageManager.MATCH_DEFAULT_ONLY);
            String pkg = ri != null && ri.activityInfo != null ? ri.activityInfo.packageName : null;
            if (pkg != null && !"android".equals(pkg)) web.setPackage(pkg);
        } catch (Exception ignored) { }
        try {
            getContext().startActivity(web);
        } catch (ActivityNotFoundException e) {
            try { web.setPackage(null); getContext().startActivity(web); }
            catch (ActivityNotFoundException e2) { call.reject("No browser found"); return; }
        }
        JSObject r = new JSObject(); r.put("opened", "browser"); call.resolve(r);
    }
}

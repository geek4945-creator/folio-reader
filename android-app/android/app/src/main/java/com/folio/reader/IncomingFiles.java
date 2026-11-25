package com.folio.reader;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;

/**
 * v0.5.26: book files opened with / shared to Folio from other apps (Files, Drive, email, Moon+, Calibre exports, a Kindle's
 * My Clippings.txt…). Each content:// file is copied into Folio's private storage; the web side reads it through Capacitor's
 * local file URL, imports it, then calls done() so the copy is deleted. Nothing is uploaded anywhere.
 */
@CapacitorPlugin(name = "IncomingFiles")
public class IncomingFiles extends Plugin {
    private static final long MAX = 400L * 1024 * 1024;
    private final ArrayList<JSObject> pending = new ArrayList<>();

    private File dir() { File d = new File(getContext().getFilesDir(), "incoming"); d.mkdirs(); return d; }

    @Override
    public void load() { handle(getActivity() != null ? getActivity().getIntent() : null); }

    @Override
    protected void handleOnNewIntent(Intent intent) { super.handleOnNewIntent(intent); handle(intent); }

    private void handle(Intent intent) {
        if (intent == null || intent.getBooleanExtra("folio.handled", false)) return;
        ArrayList<Uri> uris = new ArrayList<>();
        String a = intent.getAction();
        if (Intent.ACTION_VIEW.equals(a) && intent.getData() != null) uris.add(intent.getData());
        else if (Intent.ACTION_SEND.equals(a)) { Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (u != null) uris.add(u); }
        else if (Intent.ACTION_SEND_MULTIPLE.equals(a)) { ArrayList<Uri> l = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (l != null) uris.addAll(l); }
        ArrayList<Uri> files = new ArrayList<>();
        for (Uri u : uris) if (u != null && ("content".equals(u.getScheme()) || "file".equals(u.getScheme()))) files.add(u);
        if (files.isEmpty()) return;
        intent.putExtra("folio.handled", true);
        final String mime = intent.getType();
        new Thread(() -> {
            JSArray out = new JSArray();
            for (Uri u : files) { JSObject f = copy(u, mime); if (f != null) { synchronized (pending) { pending.add(f); } out.put(f); } }
            if (out.length() > 0) { JSObject ev = new JSObject(); ev.put("files", out); notifyListeners("files", ev, true); }
        }).start();
    }

    private String nameOf(Uri u) {
        String n = null;
        if ("content".equals(u.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) n = c.getString(0);
            } catch (Exception ignored) { }
        }
        if (n == null) n = u.getLastPathSegment();
        if (n == null || n.isEmpty()) n = "book";
        n = n.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        return n.length() > 150 ? n.substring(n.length() - 150) : n;
    }

    private JSObject copy(Uri u, String mime) {
        String name = nameOf(u);
        File target = new File(dir(), System.currentTimeMillis() + "-" + name);
        long n = 0;
        try (InputStream in = getContext().getContentResolver().openInputStream(u); OutputStream out = new FileOutputStream(target)) {
            if (in == null) return null;
            byte[] buf = new byte[64 * 1024]; int r;
            while ((r = in.read(buf)) >= 0) { out.write(buf, 0, r); n += r; if (n > MAX) throw new java.io.IOException("too large"); }
        } catch (Exception e) { target.delete(); return null; }
        JSObject f = new JSObject();
        f.put("name", name); f.put("path", target.getAbsolutePath()); f.put("size", n); f.put("mime", mime == null ? "" : mime);
        return f;
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSArray out = new JSArray();
        synchronized (pending) { for (JSObject f : pending) out.put(f); pending.clear(); }
        JSObject r = new JSObject(); r.put("files", out); call.resolve(r);
    }

    @PluginMethod
    public void done(PluginCall call) {
        String root = dir().getAbsolutePath();
        try {
            JSArray paths = call.getArray("paths");
            for (int i = 0; paths != null && i < paths.length(); i++) {
                File f = new File(paths.getString(i));
                if (f.getCanonicalPath().startsWith(root)) f.delete();
                synchronized (pending) { pending.removeIf((x) -> f.getAbsolutePath().equals(x.getString("path"))); }
            }
        } catch (Exception ignored) { }
        call.resolve();
    }
}

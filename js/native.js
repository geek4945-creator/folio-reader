// v0.5.26: one way to reach Folio's native Android plugins (AppUpdater, ExternalApp, IncomingFiles).
// The APK loads plain static files (no @capacitor/core bundle), so window.Capacitor.registerPlugin does NOT exist there —
// Capacitor's Android bridge injects ready-made proxies as window.Capacitor.Plugins.<Name> instead. Earlier versions required
// registerPlugin, which is why Settings → App updates (and the native Chirp / Libby / sign-in hand-off) never appeared in the APK.
export const isNativeApp = () => { try { const C = window.Capacitor; return !!(C && C.isNativePlatform && C.isNativePlatform()); } catch { return false; } };
export function nativePlugin(name) {
  try {
    const C = window.Capacitor; if (!isNativeApp()) return null;
    const p = C.Plugins && C.Plugins[name]; if (p && Object.keys(p).length) return p;
    if (typeof C.registerPlugin === 'function') return C.registerPlugin(name);
  } catch { /* fall through */ }
  return null;
}

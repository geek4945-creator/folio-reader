// Runtime environment detection (read at call time so tests can emulate devices).
const ua = () => navigator.userAgent || '';
export const isIOS = () => /iPad|iPhone|iPod/.test(ua()) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = () => /Android/i.test(ua());
export const isCapacitor = () => !!(window.Capacitor && (window.Capacitor.isNativePlatform ? window.Capacitor.isNativePlatform() : true)) || (location.origin === 'https://localhost' && /; wv\)/.test(ua()));
// NB: (display-mode: fullscreen) also matches while the Fullscreen API is active, so ignore it then.
export const isStandalone = () => navigator.standalone === true || ['standalone', 'minimal-ui', ...(document.fullscreenElement || document.webkitFullscreenElement ? [] : ['fullscreen'])].some((m) => window.matchMedia && window.matchMedia(`(display-mode: ${m})`).matches);
/** In-app browsers (Gmail, Messenger, Instagram, Facebook, Line, TikTok…) can't add to the Home Screen. */
export const isInAppBrowser = () => /FBAN|FBAV|FB_IAB|Instagram|Messenger|Line\/|MicroMessenger|GSA\/|Snapchat|TikTok|Twitter|LinkedInApp|Gmail|Outlook/i.test(ua()) || (isIOS() && !/Safari\//.test(ua()) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(ua()));
export const isIOSSafari = () => isIOS() && /Safari\//.test(ua()) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|FBAN|FBAV|Instagram|Line\/|GSA\//.test(ua());
/** Running as an installed app (Home Screen web app or the Capacitor Android app): hide install / full-screen helpers. */
export const isInstalledApp = () => isStandalone() || isCapacitor();

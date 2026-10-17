export const APP_VERSION = '0.5.13';
// This device's identity for sync: a stable random id and a friendly, editable name ("Chrome on Android"). No imports (db.js uses it).
const ID_KEY = 'folio.deviceId', NAME_KEY = 'folio.deviceName';
export function deviceId() {
  let id = ''; try { id = localStorage.getItem(ID_KEY) || ''; } catch { /* ignore */ }
  if (!id) { id = 'd-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); try { localStorage.setItem(ID_KEY, id); } catch { /* ignore */ } }
  return id;
}
export function guessDeviceName(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ? 'App' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /(Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return app === 'App' ? `Folio app on ${os}` : `${app} on ${os}`;
}
export const deviceName = () => { let n = ''; try { n = localStorage.getItem(NAME_KEY) || ''; } catch { /* ignore */ } return n || guessDeviceName(); };
export const setDeviceName = (n) => { try { n = (n || '').trim().slice(0, 40); n ? localStorage.setItem(NAME_KEY, n) : localStorage.removeItem(NAME_KEY); } catch { /* ignore */ } };
export const devicePlatform = () => guessDeviceName().split(' on ').pop();

// "Suggest a change" (v0.5.15): a note to the app's maker, sent through the app's proxy (Cloudflare Worker, POST /suggest).
// Unsent notes are kept in a small local queue and retried (on start, when the connection returns, and with a Retry button).
// What is sent: the text you type + app name/version + a coarse platform label + the browser's user-agent string + a timestamp. Nothing else.
import { settings } from './settings.js';
import { APP_VERSION, devicePlatform } from './device.js';
import { h, toast } from './util.js';

const KEY = 'folio.suggest', APP_NAME = 'Folio Reader', KEEP_SENT = 20, TIMEOUT_MS = 15000;
export const SUGGEST_MAX = 2000;
const subs = new Set();
let items = load(), flushing = null, draft = '';

function load() { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a.filter((x) => x && x.id && typeof x.text === 'string') : []; } catch { return []; } }
function save() {
  const sent = items.filter((i) => i.status === 'sent'); const drop = new Set(sent.slice(KEEP_SENT).map((i) => i.id));
  items = items.filter((i) => !drop.has(i.id));
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* storage full/blocked: still works this session */ }
  for (const f of [...subs]) { try { f(); } catch { /* ignore */ } }
}
export const suggestions = () => items.map((i) => ({ ...i }));
export const onSuggestChange = (f) => { subs.add(f); return () => subs.delete(f); };

/** Where notes go: <proxy base>/suggest (the same Cloudflare Worker the app already uses). '' when no proxy is configured. */
export function suggestEndpoint() {
  const p = (settings.get('proxyUrl') || '').trim(); if (!p) return '';
  try { const u = new URL(/^https?:\/\//i.test(p) ? p : 'https://' + p); return u.origin + u.pathname.replace(/\/?$/, '/') + 'suggest'; } catch { return ''; }
}
function platformLabel() {
  const native = typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  const standalone = (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  return (native ? 'app' : standalone ? 'pwa' : 'web') + '/' + devicePlatform().toLowerCase();
}

async function post(it) {
  const url = suggestEndpoint();
  if (!url) { it.status = 'failed'; it.err = 'No proxy address is set (Network settings).'; return; }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ id: it.id, app: APP_NAME, version: APP_VERSION, platform: platformLabel(), ua: (navigator.userAgent || '').slice(0, 160), text: it.text }) });
    if (r.ok) { it.status = 'sent'; it.sentAt = Date.now(); delete it.err; }
    else { it.status = 'failed'; it.err = r.status === 429 ? 'Too many suggestions just now — try again in a while.' : r.status === 413 ? 'Too long to send.' : 'The server said no (' + r.status + ').'; }
  } catch { it.status = 'queued'; it.err = 'Waiting for a connection.'; }   // offline / unreachable: keep it and retry later
  finally { clearTimeout(t); }
}

/** Send everything that is waiting (oldest first). Safe to call any time; concurrent calls share one run. */
export function flushSuggestions() {
  if (flushing) return flushing;
  flushing = (async () => {
    const tried = new Set();
    await null;   // let `flushing` be assigned before anything can finish (a run with nothing to do must not leave it set)
    try {
      for (;;) {   // oldest first; picks up notes added while this run is going
        const it = [...items].reverse().find((x) => x.status !== 'sent' && !tried.has(x.id)); if (!it) break;
        tried.add(it.id); it.status = 'sending'; save(); await post(it); save();
        if (it.status === 'queued') break;   // no connection: stop, try again later
      }
    } finally { flushing = null; }
  })();
  return flushing;
}
/** Add a note and try to send it now. Returns the stored entry (status sent / queued / failed). */
export async function submitSuggestion(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('Type your suggestion first.');
  if (text.length > SUGGEST_MAX) throw new Error('That’s over ' + SUGGEST_MAX + ' characters.');
  const it = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), text, at: Date.now(), status: 'queued' };
  items.unshift(it); save();
  await flushSuggestions();
  return items.find((x) => x.id === it.id) || it;
}
export function retrySuggestion(id) { const it = items.find((x) => x.id === id); if (it && it.status !== 'sent') { it.status = 'queued'; save(); } return flushSuggestions(); }
export function removeSuggestion(id) { const it = items.find((x) => x.id === id); if (it && it.status !== 'sent') { items = items.filter((x) => x !== it); save(); } }
export function initSuggest() {
  // a note that was mid-send when the app closed is just waiting
  let touched = false; for (const it of items) if (it.status === 'sending') { it.status = 'queued'; touched = true; }
  if (touched) save();
  window.addEventListener('online', () => { flushSuggestions(); });
  if (items.some((i) => i.status !== 'sent')) setTimeout(() => flushSuggestions(), 3000);
}

const STATUS = { sent: ['sent', '✓ Sent'], sending: ['queued', 'Sending…'], queued: ['queued', 'Waiting to send'], failed: ['failed', 'Failed — retry'] };
/** The Settings section (put it at the very bottom of global Settings). */
export function suggestSection() {
  const ta = h('textarea', { class: 'field', id: 'sg-text', rows: 5, maxlength: SUGGEST_MAX, placeholder: 'What would you like changed, added or fixed?', 'aria-label': 'Suggested change', style: { fontSize: '16px', resize: 'vertical' } });
  ta.value = draft;
  const count = h('span', { class: 'muted small', id: 'sg-count' });
  const msg = h('p', { class: 'small sg-msg', id: 'sg-msg', role: 'status', 'aria-live': 'polite' });
  const send = h('button', { class: 'btn primary', id: 'sg-send', onclick: async () => {
    const text = ta.value.trim(); if (!text) return;
    send.disabled = true; msg.textContent = 'Sending…'; msg.className = 'small sg-msg';
    try {
      const it = await submitSuggestion(text); draft = ''; ta.value = ''; upd();
      if (it.status === 'sent') { msg.textContent = 'Thanks — sent'; msg.className = 'small sg-msg ok'; }
      else if (it.status === 'queued') { msg.textContent = 'Saved — it will be sent as soon as you’re back online.'; msg.className = 'small sg-msg'; }
      else { msg.textContent = 'Couldn’t send it: ' + (it.err || 'unknown error') + ' You can retry below.'; msg.className = 'small sg-msg bad'; }
    } catch (e) { msg.textContent = e.message; msg.className = 'small sg-msg bad'; }
    upd();
  } }, 'Send');
  const upd = () => { draft = ta.value; count.textContent = ta.value.length + ' / ' + SUGGEST_MAX; send.disabled = !ta.value.trim() || ta.value.length > SUGGEST_MAX; };
  ta.addEventListener('input', upd); upd();
  const list = h('div', { class: 'sg-list', id: 'sg-list' });
  const draw = () => {
    list.replaceChildren();
    const all = suggestions();
    if (!all.length) { list.append(h('p', { class: 'muted small', id: 'sg-empty' }, 'Nothing sent yet.')); return; }
    for (const it of all) {
      const [cls, label] = STATUS[it.status] || STATUS.queued;
      list.append(h('div', { class: 'sg-item', 'data-sg-id': it.id, 'data-sg-status': it.status },
        h('div', { class: 'sg-head' }, h('span', { class: 'sg-st ' + cls }, label), h('span', { class: 'muted small' }, new Date(it.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))),
        h('div', { class: 'sg-text' }, it.text),
        it.status !== 'sent' && it.status !== 'sending' ? h('div', { class: 'row-actions wrap' }, it.err ? h('span', { class: 'muted small grow' }, it.err) : null,
          h('button', { class: 'btn sg-retry', onclick: () => { retrySuggestion(it.id).then(() => { const n = suggestions().find((x) => x.id === it.id); if (n && n.status === 'sent') toast('Thanks — sent'); }); } }, 'Retry'),
          h('button', { class: 'btn sg-del', onclick: () => removeSuggestion(it.id) }, 'Remove')) : null));
    }
  };
  draw();
  const off = onSuggestChange(() => { if (!list.isConnected) { off(); return; } draw(); });
  setTimeout(() => { if (suggestions().some((i) => i.status !== 'sent')) flushSuggestions(); }, 300);   // opening Settings is a good moment to retry
  return h('section', { class: 'pad card-sec', id: 'sec-suggest' }, h('h3', null, 'Suggest a change'),
    h('p', { class: 'muted small' }, 'Something confusing, missing or broken? Tell me what you’d like changed — it goes straight to me. Only what you type is sent (plus the app version and what kind of device this is).'),
    ta, h('div', { class: 'row-actions wrap' }, count, h('span', { class: 'grow' }), send), msg,
    h('h4', { class: 'sg-h' }, 'Your recent suggestions'), list);
}

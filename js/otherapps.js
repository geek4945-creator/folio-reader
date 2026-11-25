// v0.5.26: Settings → "Other book apps", one import router for every way a file reaches Folio (file picker, drag & drop on a computer,
// Android "Open with" / Share, Chrome's "Open with" for the installed web app), and buttons that open her other reading apps.
// Legal only: Folio opens other apps, never reads their accounts or copy-protected (DRM) books, and scrapes nothing.
import { h, toast } from './util.js';
import { isNativeApp, nativePlugin } from './native.js';
import { importFiles } from './library.js';
import { KINDLE_EXT_RE } from './kindle.js';

export const BOOK_RE = /\.(epub|pdf|mobi|azw3?|kf8|fb2|fb2\.zip|fbz|cbz|txt)$/i;
export const ACCEPT_ALL = '.epub,.pdf,.mobi,.azw,.azw3,.kf8,.fb2,.fbz,.cbz,.txt,.csv,.tsv,.json,.html,.htm,.kb,.kba,.zip,application/epub+zip,application/pdf,application/x-mobipocket-ebook,application/vnd.amazon.ebook,text/plain,text/csv';
const head = async (f, n = 65536) => { try { return await f.slice(0, n).text(); } catch { return ''; } };

/** Route files to the right importer. Returns { books, lists, clippings, skipped }. */
export async function importAny(files, { goLibrary } = {}) {
  const C = await import('./clippings.js');
  const books = [], lists = [], clips = [], skipped = [];
  for (const f of files) {
    const n = f.name || '';
    if (/\.txt$/i.test(n)) { (C.looksLikeClippings(n, await head(f)) ? clips : books).push(f); continue; }
    if (/\.html?$/i.test(n)) { (C.looksLikeNotebookHtml(await head(f, 400000)) ? clips : skipped).push(f); continue; }
    if (/\.(csv|tsv)$/i.test(n)) { (C.looksLikeNotebookCsv(await head(f)) ? clips : lists).push(f); continue; }
    if (BOOK_RE.test(n) || KINDLE_EXT_RE.test(n) || f.type === 'application/epub+zip' || f.type === 'application/pdf') { books.push(f); continue; }
    if (/\.(json|kb|kba|zip|sqlite|db)$/i.test(n)) { lists.push(f); continue; }
    skipped.push(f);
  }
  if (books.length) { await importFiles(books); goLibrary && goLibrary(); }
  for (const f of clips) await C.handleClippingsFile(f);
  if (lists.length) { const K = await import('./kybook.js'); for (const f of lists) await K.handleFile(f); }
  if (skipped.length) toast('Folio can’t open ' + skipped.map((f) => f.name).slice(0, 3).join(', ') + (skipped.length > 3 ? '…' : ''), 5000);
  return { books: books.length, lists: lists.length, clippings: clips.length, skipped: skipped.length };
}

/** Android "Open with" / Share, and Chrome's file handling for the installed web app (Windows "Open with"). */
export function initIncoming(goLibrary) {
  const P = nativePlugin('IncomingFiles');
  if (P) {
    const take = async (list) => {
      if (!list || !list.length) return;
      const C = window.Capacitor, files = [], paths = [];
      for (const x of list) {
        try { const src = C.convertFileSrc ? C.convertFileSrc(x.path) : x.path; const b = await (await fetch(src)).blob(); files.push(new File([b], x.name, { type: x.mime || b.type || '' })); } catch { toast('Couldn’t open ' + x.name); }
        paths.push(x.path);
      }
      try { if (files.length) await importAny(files, { goLibrary }); } finally { try { await P.done({ paths }); } catch { /* ignore */ } }
    };
    let busy = Promise.resolve();
    const queue = (list) => { busy = busy.then(() => take(list)).catch(() => {}); };
    try { P.addListener('files', (e) => P.getPending().then((r) => queue(r && r.files)).catch(() => queue(e && e.files))); } catch { /* ignore */ }
    setTimeout(() => { P.getPending().then((r) => queue(r && r.files)).catch(() => {}); }, 1200);
  }
  if ('launchQueue' in window && window.launchQueue && window.launchQueue.setConsumer) {
    window.launchQueue.setConsumer(async (lp) => {
      if (!lp || !lp.files || !lp.files.length) return;
      const files = []; for (const hd of lp.files) { try { files.push(await hd.getFile()); } catch { /* ignore */ } }
      if (files.length) importAny(files, { goLibrary });
    });
  }
}

/* ---------- open her other reading apps ---------- */
export const APPS = [
  { id: 'kindle', name: 'Kindle', pkgs: ['com.amazon.kindle'], web: 'https://read.amazon.com/', note: 'Your Kindle books stay in Kindle — Amazon locks them (DRM), so Folio can’t open them.' },
  { id: 'playbooks', name: 'Google Play Books', pkgs: ['com.google.android.apps.books'], web: 'https://play.google.com/books', note: 'Books you uploaded yourself can be downloaded from Play Books on a computer (if the download button shows) and added here.' },
  { id: 'moon', name: 'Moon+ Reader', pkgs: ['com.flyersoft.moonreaderp', 'com.flyersoft.moonreader'], web: 'https://play.google.com/store/apps/details?id=com.flyersoft.moonreader', android: true },
  { id: 'readera', name: 'ReadEra', pkgs: ['org.readera.premium', 'org.readera'], web: 'https://play.google.com/store/apps/details?id=org.readera', android: true },
];
export async function openApp(app) {
  const P = nativePlugin('ExternalApp'); window.__openedApp = app.id;
  if (P && P.open) {
    let pkg = app.pkgs[0];
    try { for (const p of app.pkgs) { const r = await P.isInstalled({ package: p }); if (r && r.installed) { pkg = p; break; } } } catch { /* use the first */ }
    try { const r = await P.open({ package: pkg, url: app.web }); if (r && r.opened === 'browser') toast(app.name + ' isn’t installed on this phone, so its page opened in the browser.', 5000); return r && r.opened; }
    catch { /* fall back to the browser */ }
  }
  window.open(app.web, '_blank', 'noopener');
  return 'web';
}

export function otherAppsSection() {
  const native = isNativeApp();
  const pick = (id, accept, label) => {
    const input = h('input', { type: 'file', id: id + '-file', accept, multiple: true, hidden: true, onchange: async () => { const fs = [...input.files]; input.value = ''; if (fs.length) await importAny(fs); } });
    return [h('button', { class: 'btn', id, onclick: () => input.click() }, label), input];
  };
  const appBtn = (a) => h('button', { class: 'btn', id: 'open-' + a.id, onclick: () => openApp(a) }, 'Open ' + a.name);
  return h('section', { class: 'pad card-sec', id: 'sec-otherapps' }, h('h3', null, 'Other book apps'),
    h('p', { class: 'muted small' }, native
      ? 'Any DRM-free book file (EPUB, PDF, MOBI, AZW3, FB2, CBZ, TXT) can be opened in Folio from another app: tap the file in Files, Drive, email, Moon+ or ReadEra and choose Open with → Folio Reader, or Share → Folio Reader.'
      : 'Drag book files (EPUB, PDF, MOBI, AZW3, FB2, CBZ, TXT) onto this window, or choose them below. Kindle highlight files and KyBook / Goodreads lists work the same way.'),
    h('div', { class: 'row-actions' }, ...pick('oa-import', ACCEPT_ALL, 'Import files…')),
    h('h4', null, 'Kindle'),
    h('p', { class: 'muted small' }, 'Kindle books you bought are copy-protected (DRM) by Amazon, so they can only be read in the Kindle app — Folio can’t open or move them. What works: DRM-free MOBI / AZW3 / EPUB files, and your Kindle highlights. For highlights, copy “My Clippings.txt” from the Kindle’s documents folder (USB cable), or in the Kindle phone app open a book’s Notebook → Export notebook (HTML or CSV), then import the file here. They’re matched to the same book in Folio by title and author.'),
    h('div', { class: 'row-actions' }, appBtn(APPS[0]), ...pick('oa-clippings', '.txt,.html,.htm,.csv,text/plain,text/html,text/csv', 'Import Kindle highlights…')),
    h('h4', null, 'KyBook 3'),
    h('p', { class: 'muted small' }, 'KyBook is an iPhone app with no Android version. Copy the book files out of KyBook (Files → On My iPhone → KyBook 3, or its Wi-Fi server) to Google Drive or a computer, then add them with Import files or Library → ＋. A KyBook 2 .kb/.kba backup or a CSV/JSON list of your books sets reading status and collections on books already in Folio — on Android choose it from Downloads or Drive with “Import reading list”.'),
    h('div', { class: 'row-actions' }, ...pick('oa-list', '.csv,.tsv,.txt,.json,.kb,.kba,.zip,.sqlite,.db', 'Import reading list (KyBook / Goodreads)…')),
    h('h4', null, 'Goodreads'),
    h('p', { class: 'muted small' }, 'On goodreads.com: My Books → Import and export → Export library. Import that CSV with “Import reading list”: Read / Currently reading / Want to read set the status of matching books, and your Goodreads shelves become Folio shelves.'),
    h('h4', null, 'Calibre & Calibre-Web'),
    h('p', { class: 'muted small' }, 'Browse your own Calibre library from Folio: in Calibre turn on Connect/share → Start content server (or use Calibre-Web), then in Folio go to Catalogs → Add catalog and paste the OPDS address, e.g. https://books.example.com/opds. It must be an https address (Folio is a secure app) — Calibre-Web behind a Cloudflare Tunnel works; a plain http://192.168… address won’t load.'),
    h('h4', null, 'Play Books, Moon+ Reader, ReadEra'),
    h('p', { class: 'muted small' }, 'Folio can open these apps. To read their books in Folio, open the DRM-free book file with Folio (Open with / Share), or import it here. ' + APPS[1].note),
    h('div', { class: 'row-actions' }, ...APPS.slice(1).filter((a) => native || !a.android).map(appBtn)));
}

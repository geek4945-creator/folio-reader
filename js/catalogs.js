// Catalogs tab: browse/search OPDS, Gutendex, Internet Archive, and generic HTML sources; one-tap download into the library.
import { h, toast, sheet, actionSheet, confirmDlg, promptDlg, hashHue, put } from './util.js';
import { detectKindle } from './kindle.js';
import { openPublicLibraryGuide } from './publib.js';
import { isPdf } from './pdf.js';
import { loadFeed, loadHtml, resolveSearch, expandTemplate, detectSource, pickEpub, isEpubType } from './opds.js';
import { fetchSmart, download, isBlockedSite, openLibraryCover, CorsError, SiteError, normalizeUrl } from './net.js';
import { getSources, addSource, removeSource, restoreSeeds, SEED_SOURCES, addBookFromBuffer, getBooks } from './store.js';
import { settings } from './settings.js';
import { openDriveBrowser } from './drive.js';
import * as G from './google.js';

const PAGE = 24;
let st = { src: null, stack: [], searchTpl: null, query: '' };

/* ---------- adapters for non-OPDS JSON APIs ---------- */
async function gutendexPage(url) {
  const r = await fetchSmart(url, { timeout: 15000 }); const d = await r.json();
  const feed = { title: 'Gutenberg', total: d.count, next: d.next, entries: d.results.map((b) => {
    const f = b.formats || {}; const epub = Object.entries(f).find(([t]) => /epub/.test(t));
    return { id: 'gutenberg:' + b.id, title: b.title, author: (b.authors || []).map((a) => a.name.split(', ').reverse().join(' ')).join(', '),
      summary: (b.summaries && b.summaries[0]) || (b.subjects || []).slice(0, 4).join(' · '), cover: f['image/jpeg'] || null, kind: 'book', lang: (b.languages || [])[0],
      downloads: epub ? [{ url: epub[1], type: 'application/epub+zip', label: 'EPUB' }] : [], series: '', seriesIndex: null };
  }) };
  feed.loadNext = feed.next ? () => gutendexPage(feed.next) : null; return feed;
}
const gutendexSearch = (q) => gutendexPage('https://gutendex.com/books/?' + (q ? 'search=' + encodeURIComponent(q) : 'sort=popular'));

async function iaPage(q, page = 1) {
  const base = q && q.trim() ? `(${q.trim()})` : 'collection:gutenberg';
  // Only openly licensed / public-domain collections (Gutenberg mirror, Americana pre-1927 scans, Creative Commons items); never lending-library items.
  const query = `${base} AND (collection:gutenberg OR collection:americana OR licenseurl:*creativecommons*) AND mediatype:texts AND format:EPUB AND -access-restricted-item:true AND -collection:inlibrary AND -collection:printdisabled`;
  const u = 'https://archive.org/advancedsearch.php?' + new URLSearchParams({ q: query, rows: PAGE, page, output: 'json' }) +
    ['identifier', 'title', 'creator', 'description', 'language', 'year'].map((f) => '&fl[]=' + f).join('') + '&sort[]=' + encodeURIComponent('downloads desc');
  const r = await fetchSmart(u, { timeout: 20000 }); const d = (await r.json()).response;
  const one = (v) => [].concat(v || [])[0] || '';
  const feed = { title: 'Internet Archive', total: d.numFound, entries: d.docs.map((x) => ({
    id: 'ia:' + x.identifier, iaId: x.identifier, title: one(x.title), author: [].concat(x.creator || []).join(', '), summary: one(x.description).replace(/<[^>]+>/g, ' ').slice(0, 500),
    cover: 'https://archive.org/services/img/' + x.identifier, kind: 'book', lang: one(x.language), downloads: [], needsResolve: true, series: '', seriesIndex: null })) };
  feed.loadNext = page * PAGE < d.numFound ? () => iaPage(q, page + 1) : null; return feed;
}
async function iaResolve(entry) {
  const r = await fetchSmart('https://archive.org/metadata/' + encodeURIComponent(entry.iaId), { timeout: 20000 });
  const files = (await r.json()).files || [];
  const f = files.find((x) => /^epub$/i.test(x.format || '') && x.source !== 'derivative') || files.find((x) => /\.epub$/i.test(x.name));
  if (!f) return [];
  return [{ url: `https://archive.org/download/${entry.iaId}/${f.name.split('/').map(encodeURIComponent).join('/')}`, type: 'application/epub+zip', label: 'EPUB' }];
}

/* ---------- opening a source ---------- */
async function openSource(src, query) {
  st.query = query || '';
  if (src.kind === 'gutendex') return gutendexSearch(query);
  if (src.kind === 'ia') return iaPage(query);
  if (src.kind === 'html') { return withNext(await loadHtml(src.url), loadHtml); }
  // OPDS
  if (query) {
    if (!st.searchTpl) throw new Error('This catalog does not advertise a search endpoint.');
    return withNext(await loadFeed(expandTemplate(st.searchTpl, query)), loadFeed);
  }
  const f = await loadFeed(src.url);
  try { st.searchTpl = src.searchTemplate || (f.search ? await resolveSearch(f.search) : null); } catch { st.searchTpl = src.searchTemplate || null; }
  return withNext(f, loadFeed);
}
function withNext(feed, loader) { return wrapNext(feed, loader); }
function wrapNext(feed, loader) {
  feed.loadNext = feed.next ? async () => wrapNext(await loader(feed.next), loader) : null;
  return feed;
}

/* ---------- views ---------- */
let root;
export async function renderCatalogs(view) {
  root = view; view.replaceChildren();
  if (st.src) return renderBrowse();
  const srcs = await getSources();
  put(view, 
    h('header', { class: 'topbar' }, h('h1', null, 'Catalogs'), h('button', { class: 'btn primary small', id: 'add-source', onclick: () => addSourceSheet() }, '+ Add a source')),
    h('div', { class: 'pad' }, h('button', { class: 'plib-card', id: 'plib-card', onclick: () => openPublicLibraryGuide() },
      h('span', { class: 'plib-ico' }, '🏛️'), h('span', { class: 'grow' }, h('strong', null, 'Public library'), h('span', { class: 'muted small block' }, 'Find your library, search its catalog and see what’s available to borrow with Libby')), h('span', { class: 'chev' }, '›'))),
    h('p', { class: 'muted pad' }, 'Browse legal, open catalogs and download EPUBs straight into your library. Add your own OPDS server, Calibre-Web, or a page that links to your books.'),
    h('div', { class: 'list pad' }, h('div', { class: 'list-item source', id: 'src-drive', onclick: openDriveBrowser },
      h('div', { class: 'src-ico', style: { background: '#1a73e8' } }, 'G'), h('div', { class: 'grow' }, h('strong', null, 'Google Drive'), h('div', { class: 'muted small' }, G.isSignedIn() ? 'Browse your Drive and import EPUBs' : 'Sign in with Google in Settings to use')), h('span', { class: 'chev' }, '›')),
      srcs.map((s) => h('div', { class: 'list-item source', onclick: () => open(s) },
      h('div', { class: 'src-ico', style: { background: `hsl(${hashHue(s.name)} 45% 45%)` } }, s.name[0]),
      h('div', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'muted small' }, s.note || (s.kind.toUpperCase() + ' · ' + hostOf(s.url)))),
      h('button', { class: 'btn-icon', 'aria-label': 'Source options', onclick: (e) => { e.stopPropagation(); sourceMenu(s); } }, '⋯')))),
    h('p', { class: 'muted small pad' }, 'Folio supports legal sources only. Piracy sites are blocked.'),
  );
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u; } };
function sourceMenu(s) {
  actionSheet(s.name, [
    { label: 'Rename', onClick: async () => { const n = await promptDlg('Rename source', s.name); if (n) { s.name = n; await addSource({ ...s, order: s.order }); renderCatalogs(root); } } },
    s.kind === 'opds' ? { label: s.borrowed ? '🏛️  Public library: ON — books go to Borrowed (tap to turn off)' : '🏛️  This is a public library (downloads go to Borrowed)', id: 'src-borrowed', onClick: async () => { s.borrowed = !s.borrowed; await addSource({ ...s, order: s.order }); toast(s.borrowed ? 'Downloads from “' + s.name + '” now go to Borrowed' : '“' + s.name + '” is a regular source again'); renderCatalogs(root); } } : null,
    { label: 'Remove', danger: true, onClick: async () => { if (await confirmDlg('Remove source?', s.name, 'Remove', true)) { await removeSource(s.id); renderCatalogs(root); } } },
    { label: 'Restore built-in sources', onClick: async () => { await restoreSeeds(); renderCatalogs(root); } },
  ].filter(Boolean));
}

async function open(src) { st = { src, stack: [], searchTpl: null, query: '' }; st.feed = null; st.error = null; await renderBrowse(true); }

async function renderBrowse(initial) {
  const view = root; view.replaceChildren();
  const q = h('input', { type: 'search', class: 'field search', placeholder: 'Search ' + st.src.name, value: st.query, enterkeyhint: 'search' });
  const body = h('div', { class: 'browse' });
  const back = h('button', { class: 'btn-text', onclick: () => { if (st.stack.length) { st.feed = st.stack.pop(); st.query = ''; renderBrowse(); } else { st = { src: null, stack: [] }; renderCatalogs(root); } } }, '‹ ' + (st.stack.length ? 'Back' : 'Catalogs'));
  const searchable = st.src.kind !== 'html' && (st.src.kind !== 'opds' || st.src.searchTemplate || st.searchTpl || !st.feed);
  put(view, h('header', { class: 'topbar' }, back, h('h2', { class: 'grow ellipsis' }, st.feed?.title || st.src.name)),
    searchable ? h('form', { class: 'pad', onsubmit: async (e) => { e.preventDefault(); st.stack = []; st.feed = null; st.query = q.value.trim(); await loadInto(body, () => openSource(st.src, st.query)); } }, q) : null, body);
  if (initial || !st.feed) await loadInto(body, () => openSource(st.src, st.query));
  else drawFeed(body, st.feed);
}

async function loadInto(body, loader) {
  body.replaceChildren(h('div', { class: 'spinner-row' }, h('div', { class: 'spinner' }), 'Loading…'));
  try { st.feed = await loader(); drawFeed(body, st.feed); }
  catch (e) { body.replaceChildren(errorBox(e, () => loadInto(body, loader))); }
}

function errorBox(e, retry) {
  return h('div', { class: 'err pad' }, h('strong', null, 'Couldn’t load this catalog'), h('p', null, e.message || String(e)),
    e instanceof CorsError ? h('p', { class: 'small' }, 'Tip: deploy the tiny proxy in /proxy and paste its URL in Settings → Network.') : null,
    h('button', { class: 'btn', onclick: retry }, 'Try again'));
}

function drawFeed(body, feed) {
  body.replaceChildren();
  const navs = feed.entries.filter((e) => e.kind === 'nav'), books = feed.entries.filter((e) => e.kind !== 'nav');
  if (!feed.entries.length) body.append(h('p', { class: 'muted pad' }, st.query ? 'No results.' : 'Nothing found on this page.' + (feed.html ? ' Folio looks for links to .epub files and cover images.' : '')));
  if (navs.length) body.append(h('div', { class: 'list pad' }, navs.map((n) => h('div', { class: 'list-item', onclick: () => go(n, body) },
    n.cover ? h('img', { class: 'nav-thumb', src: n.cover, loading: 'lazy', alt: '' }) : null,
    h('div', { class: 'grow' }, h('strong', null, n.title), n.summary ? h('div', { class: 'muted small clamp2' }, n.summary) : null), h('span', { class: 'chev' }, '›')))));
  if (books.length) { const grid = h('div', { class: 'cards pad' }); body.append(grid); books.forEach((b) => grid.append(card(b))); markOwned(grid); }
  if (feed.loadNext) {
    const more = h('button', { class: 'btn block', onclick: async () => {
      more.disabled = true; more.textContent = 'Loading…';
      try { const nf = await feed.loadNext(); feed.entries.push(...nf.entries); feed.next = nf.next; feed.loadNext = nf.loadNext; drawFeed(body, feed); }
      catch (e) { more.disabled = false; more.textContent = 'Load more'; toast(e.message); }
    } }, 'Load more' + (feed.total ? ` (${feed.entries.length} of ${feed.total.toLocaleString()})` : ''));
    body.append(h('div', { class: 'pad' }, more));
  }
}

async function go(n, body) {
  st.stack.push(st.feed);
  const loader = st.src.kind === 'html' ? async () => wrapNext(await loadHtml(n.href), loadHtml) : async () => wrapNext(await loadFeed(n.href), loadFeed);
  st.query = '';
  await renderBrowse(); // redraw header with Back
  const b = root.querySelector('.browse'); await loadInto(b, loader);
}

async function markOwned(grid) {
  const keys = new Set((await getBooks()).map((b) => b.sourceKey).filter(Boolean));
  grid.querySelectorAll('[data-key]').forEach((el) => { if (keys.has(el.dataset.key)) setOwned(el.querySelector('.dl')); });
}
function setOwned(btn) { if (!btn) return; btn.textContent = '✓ In library'; btn.disabled = true; btn.classList.add('done'); }

function coverImg(entry) {
  const img = h('img', { class: 'cover-img', alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const ph = h('div', { class: 'cover-ph', style: { background: `linear-gradient(135deg,hsl(${hashHue(entry.title)} 45% 38%),hsl(${(hashHue(entry.title) + 40) % 360} 45% 28%))` } }, h('span', null, entry.title));
  const box = h('div', { class: 'cover' }, ph, img);
  let tried = 0;
  img.onerror = async () => {
    if (tried++) { img.remove(); return; }
    const u = await openLibraryCover(entry.title, entry.author);      // Open Library covers fallback
    if (u) img.src = u; else img.remove();
  };
  img.onload = () => { if (img.naturalWidth < 20) img.onerror(); };
  if (entry.cover) img.src = entry.cover; else img.onerror();
  return box;
}

function card(entry) {
  const btn = h('button', { class: 'btn primary small dl', onclick: (e) => { e.stopPropagation(); doDownload(entry, btn); } }, 'Download');
  if (entry.kind === 'book' && !entry.downloads.length && !entry.needsResolve && !entry.downloads.length && entry.kind !== 'lazy') { btn.textContent = 'No EPUB/MOBI/PDF'; btn.disabled = true; }
  else if (entry.kind === 'book' && entry.downloads.length && !pickEpub(entry.downloads)) { btn.textContent = 'No EPUB/MOBI/PDF (' + [...new Set(entry.downloads.map((d) => d.label))].join('/') + ')'; btn.disabled = true; }
  return h('div', { class: 'card', 'data-key': entry.id, onclick: () => details(entry, btn) },
    coverImg(entry), h('div', { class: 'card-t clamp2' }, entry.title), h('div', { class: 'card-a muted ellipsis' }, entry.author || ' '),
    entry.series ? h('div', { class: 'badge-series' }, entry.series + (entry.seriesIndex != null ? ' #' + entry.seriesIndex : '')) : null, btn);
}

function details(entry, btn) {
  sheet(entry.title, (close) => [
    h('div', { class: 'detail' }, h('div', { class: 'detail-cover' }, coverImg(entry)),
      h('div', null, h('h3', null, entry.title), h('div', { class: 'muted' }, entry.author), entry.series ? h('div', { class: 'badge-series' }, entry.series + (entry.seriesIndex != null ? ' #' + entry.seriesIndex : '')) : null,
        entry.lang ? h('div', { class: 'muted small' }, 'Language: ' + entry.lang) : null)),
    entry.summary ? h('p', { class: 'summary' }, entry.summary.slice(0, 1200)) : null,
    h('button', { class: 'btn primary block', disabled: btn.disabled, onclick: () => { close(); doDownload(entry, btn); } }, btn.disabled ? btn.textContent : 'Download to library'),
  ], { tall: true });
}

async function doDownload(entry, btn) {
  if (btn.disabled) return;
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    let e = entry;
    if (e.kind === 'lazy') {   // e.g. Gutenberg OPDS search results need one more fetch
      const f = await loadFeed(e.href); const full = f.entries.find((x) => x.downloads.length);
      if (!full) throw new Error('No downloadable file found for this book.');
      e = { ...full, cover: e.cover || full.cover, author: full.author || e.author, id: e.id }; Object.assign(entry, { downloads: e.downloads, summary: full.summary, series: full.series, seriesIndex: full.seriesIndex });
    }
    if (e.needsResolve) { entry.downloads = e.downloads = await iaResolve(e); }
    const dl = pickEpub(e.downloads);
    if (!dl) throw new Error('No EPUB, MOBI/AZW3 or PDF version is offered for this title.' + (e.downloads.length ? ' (Available: ' + e.downloads.map((d) => d.label).join(', ') + ')' : ''));
    const blob = await download(dl.url, (p) => { btn.textContent = Math.round(p * 100) + '%'; });
    btn.textContent = 'Importing…';
    const buf = await blob.arrayBuffer();
    const sig = new Uint8Array(buf.slice(0, 2));
    if ((sig[0] !== 0x50 || sig[1] !== 0x4b) && !detectKindle(buf) && !isPdf(buf)) throw new Error('The server did not return an EPUB, MOBI or PDF file (it may require a login or a different link).');
    await addBookFromBuffer(buf, { filename: dl.url.split('?')[0].split('/').pop(), sourceKey: entry.id, source: st.src?.name, title: e.title, author: e.author, summary: e.summary, series: e.series, seriesIndex: e.seriesIndex, coverUrl: e.cover, borrowed: !!(st.src?.borrowed || e.loan || entry.loan), dueAt: e.dueAt || entry.dueAt || null });
    setOwned(btn); toast(st.src?.borrowed || e.loan || entry.loan ? 'Added “' + e.title + '” to Borrowed' + (e.dueAt || entry.dueAt ? ' (due ' + new Date(e.dueAt || entry.dueAt).toLocaleDateString() + ')' : '') : 'Added “' + e.title + '” to your library');
  } catch (err) {
    btn.disabled = false; btn.textContent = /Already/.test(err.message) ? '✓ In library' : label; if (/Already/.test(err.message)) setOwned(btn);
    toast(err.message || 'Download failed', 5200);
    if (!(err instanceof SiteError) && (err instanceof CorsError || /CORS|proxy/i.test(err.message))) sheet('Download blocked by the browser', () => [
      h('p', null, 'This server doesn’t allow downloads from web apps (CORS). Fix it by pointing Folio at the small proxy included with the project (Settings → Network), or download the EPUB in Safari and use Import in the Library tab.')]);
  }
}

/* ---------- Add a source ---------- */
/** Hosts that already have a purpose-built, better source. */
const BUILTIN_HOSTS = [[/(^|\.)archive\.org$/i, 'seed-ia'], [/(^|\.)gutenberg\.org$/i, 'seed-gutenberg'], [/(^|\.)standardebooks\.org$/i, 'seed-se']];
export function builtinFor(u) { try { const h = new URL(u).hostname; const hit = BUILTIN_HOSTS.find(([re]) => re.test(h)); return hit ? hit[1] : null; } catch { return null; } }

export function addSourceSheet(prefill = '') {
  if (typeof prefill !== 'string') prefill = '';   // (e.g. when used directly as a click handler)
  const url = h('input', { class: 'field', id: 'source-url', type: 'text', placeholder: 'archive.org or https://example.com/opds', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', inputmode: 'url' });
  const name = h('input', { class: 'field', type: 'text', placeholder: 'Name (optional)' });
  const kind = h('select', { class: 'field', id: 'source-kind' }, h('option', { value: 'auto' }, 'Auto-detect'), h('option', { value: 'opds' }, 'OPDS feed (Atom / JSON)'), h('option', { value: 'html' }, 'Web page with EPUB links (generic)'));
  const out = h('div', { class: 'muted small', id: 'source-out', role: 'status' }); let found = null;
  const say = (msg, err = false) => { out.replaceChildren(msg); out.classList.toggle('err', err); };
  /** Normalize what was typed; shows a friendly inline error and returns null if it can't be an address. */
  const parse = () => { try { const u = normalizeUrl(url.value); url.value = u; return u; } catch (e) { say(e.message, true); return null; } };
  /** Known sites get their built-in source instead of the generic HTML mode. Returns true when it showed the offer. */
  const offerBuiltin = async (u) => {
    if (kind.value === 'opds') return false;   // an explicit OPDS choice is respected
    const id = builtinFor(u); if (!id) return false;
    const seed = (await getSources()).find((x) => x.id === id) || SEED_SOURCES.find((x) => x.id === id);
    out.classList.remove('err'); out.replaceChildren(`${new URL(u).hostname} already has a built-in source, “${seed.name}”, which works better than the generic page mode. `,
      h('button', { class: 'btn small primary', id: 'builtin-offer', onclick: async () => { await restoreSeeds(); const src = (await getSources()).find((x) => x.id === id); s.close(); if (!(root && root.isConnected)) { document.querySelector('[data-tab=catalogs]')?.click(); await new Promise((r) => setTimeout(r, 80)); } if (src) await open(src); } }, 'Open “' + seed.name + '”'));
    return true;
  };
  const s = sheet('Add a source', (close) => [
    h('p', { class: 'muted small' }, 'Paste the address of an OPDS catalog (Calibre-Web: /opds, Calibre content server: /opds, COPS, Kavita, Komga, Project Gutenberg…) or a page on your own server that links to EPUB files. You can leave off https://.'),
    url, name, kind, out,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', id: 'source-check', onclick: async () => {
        found = null; const u = parse(); if (!u) return;
        if (isBlockedSite(u)) { say('That site is not supported: Folio only connects to legal catalogs and your own libraries.', true); return; }
        if (await offerBuiltin(u)) return;
        say('Checking…');
        try {
          if (kind.value === 'html') { const f = await loadHtml(u); found = { kind: 'html', url: u, feed: f, name: f.title }; }
          else if (kind.value === 'opds') { const f = await loadFeed(u); found = { kind: 'opds', url: u, feed: f, name: f.title }; }
          else found = await detectSource(u);
          found.inputUrl = u; const books = found.feed.entries.filter((e) => e.kind !== 'nav').length;
          say(`Found ${found.kind === 'opds' ? 'an OPDS catalog' : 'a web page'}: “${found.name}” — ${found.feed.entries.length} entries${books ? ` (${books} books)` : ''}.`);
          if (!name.value) name.value = (found.name || '').slice(0, 60);
        } catch (e) { say(e.message || String(e), true); }
      } }, 'Check'),
      h('button', { class: 'btn primary', id: 'source-add', onclick: async () => {
        const u = parse(); if (!u) return;
        if (await offerBuiltin(u)) return;
        if (!found || found.inputUrl !== u) { say('Press Check first.', true); return; }
        await addSource({ name: name.value.trim() || found.name || hostOf(found.url), kind: found.kind, url: found.url, note: found.kind === 'opds' ? 'OPDS catalog' : 'Web page (generic mode)' });
        close(); toast('Source added'); if (root && root.isConnected) renderCatalogs(root);
      } }, 'Add')),
  ], { tall: true });
  if (prefill) url.value = prefill;
  setTimeout(() => url.focus(), 60);
  return s;
}
export function resetCatalogs() { st = { src: null, stack: [], searchTpl: null, query: '' }; }
export const _state = () => st;

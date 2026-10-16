// Cover search for "Change cover": many candidates from several free, key-less sources, paged ("load more"), with an editable query.
//   Open Library (search by ISBN / title / author + the covers of each work's other editions), Google Books, Internet Archive (cover thumbs),
//   Apple's iTunes Search (ebook + audiobook artwork). Candidates are { id, source, label, thumb, full, w?, h?, conf }.
// Sizes are measured by the UI when an image loads (w × h), then it filters / sorts on them.
import { getJson, titleSim, authorSim, hasAuthor, normTitle } from './enrich.js';

export const PAGE = 20;
const enc = encodeURIComponent;
const year = (s) => (/\b(1[5-9]\d\d|20\d\d)\b/.exec(s || '') || [])[1] || '';
const urlKey = (u) => { try { const x = new URL(u); for (const k of ['zoom', 'edge', 'imgtk', 'default', 'source']) x.searchParams.delete(k); x.searchParams.sort(); return x.host + x.pathname.replace(/-[SML]\.jpg$/, '') + x.search; } catch { return u || ''; } };   // same picture at another zoom = same candidate
const settle = async (fn) => { try { return await fn(); } catch { return null; } };
const isbnOf = (s) => (s || '').replace(/[^0-9Xx]/g, '');

/** Each source: async (q, page) → { items: [...], more: bool }. A failing source just yields nothing. */
const SOURCES = {
  async 'Open Library'(q, page) {
    const out = []; let more = false; const isbn = isbnOf(q.isbn);
    if (page === 0 && isbn.length >= 10) out.push({ id: 'ol:isbn:' + isbn, source: 'Open Library', label: 'Open Library · ISBN ' + isbn, thumb: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`, full: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`, conf: 1 });
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE), fields: 'key,title,author_name,cover_i,first_publish_year,publisher,isbn,edition_count' });
    if (isbn.length >= 10 && !q.title) p.set('isbn', isbn); else { if (q.title) p.set('title', q.title); if (q.author) p.set('author', q.author.split(/,| and |&/)[0].trim()); }
    if (!q.title && !q.author && isbn.length < 10) return { items: out, more: false };
    const d = await getJson('https://openlibrary.org/search.json?' + p); const docs = (d && d.docs) || []; more = docs.length >= PAGE;
    const ranked = docs.map((x) => ({ x, conf: Math.round((0.65 * titleSim(q.title || '', x.title) + 0.35 * (hasAuthor(q.author) ? authorSim(q.author, x.author_name || []) : 0.5)) * 100) / 100 })).filter((r) => !q.title || r.conf >= 0.3 || isbn.length >= 10).sort((a, b) => b.conf - a.conf);
    for (const { x, conf } of ranked) if (x.cover_i) out.push({ id: 'ol:' + x.cover_i, source: 'Open Library', label: ['Open Library', x.first_publish_year, (x.publisher || [])[0]].filter(Boolean).join(' · '), thumb: `https://covers.openlibrary.org/b/id/${x.cover_i}-L.jpg?default=false`, full: `https://covers.openlibrary.org/b/id/${x.cover_i}-L.jpg?default=false`, conf });
    for (const { x, conf } of ranked.slice(0, 3)) {   // other editions of the best matches carry their own covers
      const e = await settle(() => getJson(`https://openlibrary.org${x.key}/editions.json?limit=30`)); for (const ed of (e && e.entries) || []) for (const c of (ed.covers || []).filter((n) => n > 0).slice(0, 1))
        out.push({ id: 'ol:' + c, source: 'Open Library', label: ['Open Library edition', year(ed.publish_date), (ed.publishers || [])[0], ed.physical_format].filter(Boolean).join(' · '), thumb: `https://covers.openlibrary.org/b/id/${c}-L.jpg?default=false`, full: `https://covers.openlibrary.org/b/id/${c}-L.jpg?default=false`, conf: conf * 0.95 });
    }
    return { items: out, more };
  },
  async 'Google Books'(q, page) {
    const isbn = isbnOf(q.isbn); const term = isbn.length >= 10 && !q.title ? 'isbn:' + isbn : [q.title && 'intitle:' + q.title, hasAuthor(q.author) && q.author && 'inauthor:' + q.author.split(/,| and |&/)[0].trim()].filter(Boolean).join('+');
    if (!term) return { items: [], more: false };
    const d = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${term.replace(/ /g, '+')}&maxResults=${PAGE}&startIndex=${page * PAGE}&printType=books`); const items = ((d && d.items) || []);
    return { more: items.length >= PAGE, items: items.map((v) => { const i = v.volumeInfo || {}; const il = i.imageLinks || {}; const base = il.extraLarge || il.large || il.medium || il.thumbnail || il.smallThumbnail; if (!base) return null;
      const big = base.replace(/^http:/, 'https:').replace(/&edge=curl/, '').replace(/zoom=\d/, 'zoom=0');
      return { id: 'gb:' + v.id, source: 'Google Books', label: ['Google Books', year(i.publishedDate), i.publisher].filter(Boolean).join(' · '), thumb: big, full: big, conf: Math.round((0.65 * titleSim(q.title || '', i.title) + 0.35 * (hasAuthor(q.author) ? authorSim(q.author, i.authors || []) : 0.5)) * 100) / 100 }; }).filter(Boolean).filter((c) => !q.title || c.conf >= 0.3) };
  },
  async 'Internet Archive'(q, page) {
    if (!q.title) return { items: [], more: false };
    const query = `title:(${q.title.replace(/[()":]/g, ' ')})` + (hasAuthor(q.author) && q.author ? ` AND creator:(${q.author.split(/,| and |&/)[0].replace(/[()":]/g, ' ').trim()})` : '') + ' AND mediatype:texts';
    const d = await getJson(`https://archive.org/advancedsearch.php?q=${enc(query)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&rows=${PAGE}&page=${page + 1}&output=json`); const docs = (d && d.response && d.response.docs) || [];
    return { more: docs.length >= PAGE, items: docs.filter((x) => titleSim(q.title, Array.isArray(x.title) ? x.title[0] : x.title) >= 0.5).map((x) => ({ id: 'ia:' + x.identifier, source: 'Internet Archive', label: ['Internet Archive', x.year, Array.isArray(x.creator) ? x.creator[0] : x.creator].filter(Boolean).join(' · '), thumb: `https://archive.org/services/img/${enc(x.identifier)}`, full: `https://archive.org/services/img/${enc(x.identifier)}`, conf: 0.6 })) };
  },
  async 'Apple Books'(q, page) {
    const term = [q.title, hasAuthor(q.author) ? q.author : ''].filter(Boolean).join(' ').trim() || isbnOf(q.isbn); if (!term) return { items: [], more: false };
    const out = []; let more = false;
    for (const ent of q.kind === 'audio' ? ['audiobook', 'ebook'] : ['ebook', 'audiobook']) {
      const d = await settle(() => getJson(`https://itunes.apple.com/search?term=${enc(term)}&media=${ent}&entity=${ent}&limit=${PAGE}&offset=${page * PAGE}`)); const rs = (d && d.results) || []; more = more || rs.length >= PAGE;
      for (const r of rs) { const a = r.artworkUrl100 || r.artworkUrl60; if (!a) continue; const c = Math.round((0.65 * titleSim(q.title || '', r.trackName || r.collectionName) + 0.35 * (hasAuthor(q.author) ? authorSim(q.author, [r.artistName || '']) : 0.5)) * 100) / 100; if (q.title && c < 0.35) continue;
        out.push({ id: 'ap:' + (r.trackId || r.collectionId), source: 'Apple Books', label: ['Apple ' + (ent === 'audiobook' ? 'audiobook' : 'ebook'), year(r.releaseDate), r.artistName].filter(Boolean).join(' · '), thumb: a.replace(/\d+x\d+bb/, '400x400bb'), full: a.replace(/\d+x\d+bb/, '1000x1000bb'), conf: c }); }
    }
    return { items: out, more };
  },
  /** Optional: Google Programmable Search (image) when config.js has googleCseKey + googleCseCx. */
  async 'Google Images'(q, page) {
    const cfg = window.FOLIO_CONFIG || {}; if (!(cfg.googleCseKey && cfg.googleCseCx) || page > 2) return { items: [], more: false };
    const d = await getJson('https://www.googleapis.com/customsearch/v1?' + new URLSearchParams({ key: cfg.googleCseKey, cx: cfg.googleCseCx, searchType: 'image', num: '10', start: String(page * 10 + 1), q: `${q.title || ''} ${hasAuthor(q.author) ? q.author : ''} book cover`.replace(/\s+/g, ' ').trim() }));
    const items = (d && d.items) || []; return { more: items.length >= 10 && page < 2, items: items.filter((x) => x.link).map((x) => ({ id: 'gi:' + x.link, source: 'Google Images', label: 'Google Images', thumb: x.image?.thumbnailLink || x.link, full: x.link, conf: 0.5 })) };
  },
};
export const SOURCE_NAMES = Object.keys(SOURCES);

/** A paged search session: next() returns the next batch of new, de-duplicated candidates; .more tells whether another call may find more. */
export function coverSearch(query, { sources = SOURCE_NAMES } = {}) {
  const st = { page: 0, seenId: new Set(), seenUrl: new Set(), done: new Set(), errors: new Map(), more: true };
  return {
    get more() { return st.more; }, get errors() { return st.errors; },
    async next() {
      const live = sources.filter((s) => !st.done.has(s)); const page = st.page++;
      const res = await Promise.all(live.map(async (s) => { try { return [s, await SOURCES[s](query, page)]; } catch (e) { st.errors.set(s, e.message || String(e)); return [s, { items: [], more: false }]; } }));
      const out = [];
      for (const [s, r] of res) { if (!r.more) st.done.add(s); for (const c of r.items || []) { const uk = urlKey(c.full); if (st.seenId.has(c.id) || st.seenUrl.has(uk)) continue; st.seenId.add(c.id); st.seenUrl.add(uk); out.push(c); } }
      st.more = st.done.size < sources.length; return out.sort((a, b) => (b.conf || 0) - (a.conf || 0));
    },
  };
}
export const searchLinks = (q) => ({
  google: 'https://www.google.com/search?tbm=isch&q=' + enc(q), bing: 'https://www.bing.com/images/search?q=' + enc(q), ddg: 'https://duckduckgo.com/?iax=images&ia=images&q=' + enc(q),
  chromeIOS: 'googlechromes://www.google.com/search?tbm=isch&q=' + enc(q), chromeAndroid: 'intent://www.google.com/search?tbm=isch&q=' + enc(q) + '#Intent;scheme=https;package=com.android.chrome;end',
});
/** What a paste carries: { blob } for an image, { url } for an address (also pulled out of copied HTML like <img src>). */
export async function fromClipboardItems(items) {
  for (const it of items) { for (const t of it.types) if (/^image\//.test(t)) return { blob: await it.getType(t) }; }
  for (const it of items) {
    if (it.types.includes('text/html')) { const html = await (await it.getType('text/html')).text(); const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html); if (m && /^https?:/i.test(m[1])) return { url: m[1] }; }
    if (it.types.includes('text/plain')) { const t = (await (await it.getType('text/plain')).text()).trim(); if (/^https?:\/\/\S+$/i.test(t)) return { url: t }; }
  }
  return null;
}
export function fromPasteEvent(e) {
  const dt = e.clipboardData; if (!dt) return null;
  for (const f of dt.files || []) if (/^image\//.test(f.type)) return { blob: f };
  for (const it of dt.items || []) if (it.kind === 'file' && /^image\//.test(it.type)) { const f = it.getAsFile(); if (f) return { blob: f }; }
  const html = dt.getData('text/html'); const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || ''); if (m && /^https?:/i.test(m[1])) return { url: m[1] };
  const t = (dt.getData('text/plain') || '').trim(); if (/^https?:\/\/\S+$/i.test(t)) return { url: t };
  return null;
}

// OPDS 1.x (Atom), OPDS 2.x (JSON), OpenSearch templates and a generic HTML scraper.
// Everything is normalised to:
//  feed  = { title, entries[], next, prev, search:{template}|null, start, total }
//  entry = { id, title, author, summary, cover, kind:'book'|'nav'|'lazy', href (nav/lazy),
//            downloads:[{url,type,label}], series, seriesIndex, lang, formats[] }
import { fetchSmart } from './net.js';

const EPUB_RE = /epub/i;
const abs = (href, base) => { try { return new URL(href, base).href; } catch { return href; } };
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const REL_ACQ = 'http://opds-spec.org/acquisition';

const textOf = (el) => (el && el.textContent || '').replace(/\s+/g, ' ').trim();
const stripHtml = (s) => { const d = new DOMParser().parseFromString(s || '', 'text/html'); return (d.body.textContent || '').replace(/\s+/g, ' ').trim(); };

export function isEpubType(type, url = '') {
  return EPUB_RE.test(type || '') || /\.epub(\?|$)/i.test(url) || /\/epub(\.|$|\?)/i.test(url);
}

export function isKindleType(type, url = '') {
  return /mobipocket|x-mobi8|vnd\.amazon\.(ebook|mobi)|x-kindle/i.test(type || '') || /\.(mobi|azw3?|kf8)(\?|$)/i.test(url);
}
export function isPdfType(type, url = '') { return /application\/pdf/i.test(type || '') || /\.pdf(\?|$)/i.test(url); }
/** Best downloadable book: EPUB first, then a Kindle file (MOBI/AZW3, converted on import), then PDF. */
function pickEpub(downloads) {
  let eps = downloads.filter((d) => isEpubType(d.type, d.url));
  if (!eps.length) eps = downloads.filter((d) => isKindleType(d.type, d.url)).sort((a, b) => (/azw3|kf8|mobi8/i.test(b.type + b.url) ? 1 : 0) - (/azw3|kf8|mobi8/i.test(a.type + a.url) ? 1 : 0));
  if (!eps.length) eps = downloads.filter((d) => isPdfType(d.type, d.url));
  if (!eps.length) return null;
  // Prefer epub3 / with images, then the first.
  eps.sort((a, b) => score(b) - score(a));
  return eps[0];
  function score(d) { return (/epub3/.test(d.url) ? 3 : 0) + (/images/.test(d.url) && !/noimages/.test(d.url) ? 2 : 0) + (/\.epub$/.test(d.url) ? 1 : 0); }
}
export { pickEpub };

/* ---------------- Atom ---------------- */
function parseAtom(doc, base) {
  const feedEl = doc.documentElement;
  const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
  const links = (el) => kids(el, 'link').map((l) => ({ rel: l.getAttribute('rel') || '', href: abs(l.getAttribute('href') || '', base), type: l.getAttribute('type') || '', title: l.getAttribute('title') || '' }));
  const fl = links(feedEl);
  const find = (rel) => fl.find((l) => l.rel === rel)?.href || null;
  const feed = {
    title: textOf(kids(feedEl, 'title')[0]) || 'Catalog',
    next: find('next'), prev: find('previous') || find('prev'), start: find('start'),
    search: null, entries: [],
    total: parseInt(textOf(doc.getElementsByTagNameNS('*', 'totalResults')[0])) || null,
  };
  const sl = fl.find((l) => l.rel === 'search');
  if (sl) feed.search = { href: sl.href, type: sl.type };

  for (const e of kids(feedEl, 'entry')) {
    const ls = links(e);
    const id = textOf(kids(e, 'id')[0]) || ls[0]?.href || Math.random().toString(36);
    const title = textOf(kids(e, 'title')[0]) || 'Untitled';
    const authorEl = kids(e, 'author')[0];
    let author = authorEl ? textOf(kids(authorEl, 'name')[0]) : '';
    const contentEl = kids(e, 'content')[0], summaryEl = kids(e, 'summary')[0];
    let summary = stripHtml(textOf(summaryEl) ? summaryEl.textContent : (contentEl ? contentEl.textContent : ''));
    const downloads = ls.filter((l) => l.rel.startsWith(REL_ACQ) && !/borrow|subscribe|sample|preview/.test(l.rel))
      .map((l) => ({ url: l.href, type: l.type, label: formatLabel(l.type, l.href) }));
    const img = ls.find((l) => l.rel === 'http://opds-spec.org/image') || ls.find((l) => /image/.test(l.rel) && !/thumbnail/.test(l.rel)) || ls.find((l) => /image\/thumbnail|thumbnail/.test(l.rel));
    const thumb = ls.find((l) => /thumbnail/.test(l.rel)) || img;
    const entry = { id, title, author, summary, cover: (img || thumb)?.href || null, thumb: thumb?.href || null, downloads, series: '', seriesIndex: null };
    // Series: Calibre / schema.org / opds extensions
    const ns = (name) => [...e.getElementsByTagNameNS('*', name)];
    const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    const cs = ns('series')[0]; if (cs) { entry.series = (cs.getAttribute('name') || own(cs) || textOf(cs)).trim(); const si = cs.getAttribute('position') || cs.getAttribute('index') || textOf(ns('series_index')[0]); if (si) entry.seriesIndex = parseFloat(si); }
    if (!entry.series) { const cal = ns('series_index')[0]; const s2 = [...e.children].find((c) => /^calibre:series$|^series$/.test(c.nodeName)); if (s2) entry.series = textOf(s2); if (cal) entry.seriesIndex = parseFloat(textOf(cal)); }
    const lang = ns('language')[0]; if (lang) entry.lang = textOf(lang);
    if (downloads.length) { entry.kind = 'book'; }
    else {
      const sub = ls.find((l) => /atom|opds|xml/.test(l.type) && (l.rel === 'subsection' || l.rel === '' || l.rel === 'alternate' || l.rel.includes('opds-spec.org/sort') || l.rel.includes('facet') || l.rel.includes('popular') || l.rel.includes('new') || l.rel === 'http://opds-spec.org/crawlable'));
      if (!sub) continue;
      entry.href = sub.href;
      entry.thumb = entry.cover = null; // nav icons are decorative data: URIs
      if (/\/ebooks\/\d+\.opds$/.test(sub.href)) {   // Project Gutenberg search result -> fetch lazily
        const n = sub.href.match(/ebooks\/(\d+)\.opds/)[1];
        entry.kind = 'lazy'; entry.author = entry.author || textOf(contentEl);
        entry.cover = `https://www.gutenberg.org/cache/epub/${n}/pg${n}.cover.medium.jpg`;
        entry.summary = '';
      } else { entry.kind = 'nav'; entry.summary = summary; }
    }
    feed.entries.push(entry);
  }
  return feed;
}

function formatLabel(type, url) {
  if (isEpubType(type, url)) return 'EPUB';
  if (/pdf/i.test(type)) return 'PDF'; if (/\.azw3?(\?|$)/i.test(url)) return 'AZW3'; if (/mobi|kindle/i.test(type) || /\.mobi(\?|$)/i.test(url)) return 'MOBI'; if (/text\/plain/i.test(type)) return 'TXT';
  if (/html/i.test(type)) return 'HTML'; return (type || 'file').split('/').pop().toUpperCase().slice(0, 8);
}

/* ---------------- OPDS 2 JSON ---------------- */
function parseJson(json, base) {
  const L = (links) => (links || []).map((l) => ({ rel: [].concat(l.rel || []).join(' '), href: abs(l.href || '', base), type: l.type || '', title: l.title || '', templated: !!l.templated }));
  const fl = L(json.links);
  const find = (rel) => fl.find((l) => l.rel.split(' ').includes(rel))?.href || null;
  const feed = { title: json.metadata?.title || 'Catalog', next: find('next'), prev: find('previous'), start: find('start'), entries: [], search: null, total: json.metadata?.numberOfItems || null };
  const sl = fl.find((l) => l.rel === 'search'); if (sl) feed.search = { href: abs(sl.href.replace(/\{[^}]*\}/g, (m) => m), base), type: sl.type, templated: true };
  const pubToEntry = (p) => {
    const m = p.metadata || {}; const pl = L(p.links);
    const names = (a) => [].concat(a || []).map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean).join(', ');
    const downloads = pl.filter((l) => l.rel.startsWith(REL_ACQ) && !/borrow|subscribe|sample|preview/.test(l.rel) && l.href)
      .map((l) => ({ url: l.href, type: l.type, label: formatLabel(l.type, l.href) }));
    const imgs = (p.images || []).map((i) => ({ href: abs(i.href, base), w: i.width || 0 }));
    const cov = imgs.sort((a, b) => b.w - a.w)[0]?.href || null;
    const small = imgs.sort((a, b) => a.w - b.w)[0]?.href || null;
    const bt = m.belongsTo || {}; const ser = [].concat(bt.series || [])[0];
    const e = { id: m.identifier || m.title + names(m.author), title: typeof m.title === 'string' ? m.title : (m.title && Object.values(m.title)[0]) || 'Untitled', author: names(m.author),
      summary: stripHtml(m.description || ''), cover: cov, thumb: small || cov, downloads, kind: 'book', series: ser ? (ser.name || ser) : '', seriesIndex: ser && ser.position != null ? parseFloat(ser.position) : null, lang: [].concat(m.language || [])[0] };
    if (m.numberOfPages) e.pages = m.numberOfPages;
    return e;
  };
  const navs = [...(json.navigation || [])];
  for (const n of navs) feed.entries.push({ id: n.href, title: n.title || 'Section', kind: 'nav', href: abs(n.href, base), downloads: [], author: '', summary: '' });
  for (const p of json.publications || []) feed.entries.push(pubToEntry(p));
  for (const g of json.groups || []) {
    const self = L(g.links).find((l) => l.rel.includes('self'));
    if (self && (g.publications || g.navigation)) feed.entries.push({ id: self.href, title: g.metadata?.title || 'More', kind: 'nav', href: self.href, downloads: [], author: '', summary: g.metadata?.numberOfItems ? g.metadata.numberOfItems.toLocaleString() + ' items' : '' });
    for (const n of g.navigation || []) feed.entries.push({ id: n.href, title: n.title, kind: 'nav', href: abs(n.href, base), downloads: [], author: '', summary: '' });
    for (const p of g.publications || []) feed.entries.push(pubToEntry(p));
  }
  // Paging for JSON feeds that only give numbers in metadata
  const md = json.metadata || {};
  if (!feed.next && md.currentPage && md.itemsPerPage && md.numberOfItems && md.currentPage * md.itemsPerPage < md.numberOfItems) {
    const u = new URL(base); u.searchParams.set('page', md.currentPage + 1); feed.next = u.href;
  }
  return feed;
}

/** Parse feed text (auto-detect Atom vs JSON). Returns null if it isn't an OPDS feed. */
export function parseFeedText(text, base, contentType = '') {
  const t = text.trimStart();
  if (t.startsWith('{') || /json/.test(contentType)) {
    try { const j = JSON.parse(text); if (j.metadata || j.publications || j.navigation || j.groups) return parseJson(j, base); } catch { /* fallthrough */ }
    return null;
  }
  if (t.startsWith('<')) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    if (doc.documentElement.localName === 'feed') return parseAtom(doc, base);
    if (doc.documentElement.localName === 'entry') { // single-entry document: wrap
      const wrap = new DOMParser().parseFromString(`<feed xmlns="${ATOM_NS}"></feed>`, 'application/xml');
      wrap.documentElement.append(wrap.importNode(doc.documentElement, true)); return parseAtom(wrap, base);
    }
  }
  return null;
}

export async function loadFeed(url) {
  const r = await fetchSmart(url);
  const text = await r.text();
  const feed = parseFeedText(text, url, r.headers.get('content-type') || '');
  if (!feed) throw new Error('That address did not return an OPDS catalog feed.');
  feed.url = url;
  return feed;
}

/* ---------------- Search templates ---------------- */
export function expandTemplate(tpl, query) {
  const q = encodeURIComponent(query);
  let out = tpl.replace(/\{\?([^}]+)\}/g, (_, names) => {   // RFC 6570 form-style {?query}
    const pairs = names.split(',').map((n) => (/^(query|q|searchTerms)$/.test(n) ? `${n}=${q}` : null)).filter(Boolean);
    return pairs.length ? (tpl.slice(0, tpl.indexOf('{?')).includes('?') ? '&' : '?') + pairs.join('&') : '';
  });
  out = out.replace(/\{searchTerms\??\}/g, q).replace(/\{startPage\??\}/g, '1').replace(/\{startIndex\??\}/g, '1').replace(/\{count\??\}/g, '24')
    .replace(/\{language\??\}/g, '*').replace(/\{inputEncoding\??\}/g, 'UTF-8').replace(/\{outputEncoding\??\}/g, 'UTF-8')
    .replace(/[?&][^=&]+=\{[^}]*\?\}/g, '').replace(/\{[^}]*\}/g, '');
  return out;
}

/** Resolve a feed's search link into a URL template (fetches OpenSearch description if needed). */
export async function resolveSearch(search) {
  if (!search) return null;
  if (search.type && /opensearchdescription/.test(search.type) || /osd|opensearch/i.test(search.href) && !/\{/.test(search.href)) {
    const r = await fetchSmart(search.href);
    const doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
    const urls = [...doc.getElementsByTagNameNS('*', 'Url')];
    const pick = urls.find((u) => /opds/.test(u.getAttribute('type') || '') && /atom/.test(u.getAttribute('type') || '')) || urls.find((u) => /opds/.test(u.getAttribute('type') || '')) || urls.find((u) => /atom/.test(u.getAttribute('type') || ''));
    if (!pick) return null;
    return abs(pick.getAttribute('template'), search.href);
  }
  return search.href;
}

/* ---------------- Generic HTML mode ---------------- */
export function parseHtmlListing(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const isEpubLink = (a) => {
    const href = a.getAttribute('href') || '';
    return isEpubType(a.getAttribute('type'), href) || isKindleType(a.getAttribute('type'), href) || /\/download\/\d+\/epub/i.test(href) || /\/get\/EPUB\//i.test(href) || /\bformat=epub\b/i.test(href);
  };
  const cardOf = (a) => a.closest('li, article, tr, .card, .book, .item, .entry, [class*="book"], [class*="card"]') || a.parentElement;
  const og = doc.querySelector('meta[property="og:image"]')?.content;
  const pageTitle = doc.querySelector('meta[property="og:title"]')?.content || doc.title || base;
  const seen = new Set(); const entries = [];
  const links = [...doc.querySelectorAll('a[href]')];
  for (const a of links.filter(isEpubLink)) {
    const url = abs(a.getAttribute('href'), base); if (seen.has(url)) continue; seen.add(url);
    const card = cardOf(a);
    const img = card && card.querySelector('img'); const heading = card && card.querySelector('h1,h2,h3,h4,.title,[class*="title"]');
    const src = img && (img.getAttribute('src') || img.getAttribute('data-src'));
    let title = textOf(heading) || (img && img.alt) || textOf(a);
    if (!title || /^(epub|download|get)$/i.test(title)) title = decodeURIComponent(url.split('/').pop().replace(/\.epub.*$/i, '')).replace(/[_-]+/g, ' ') || 'Untitled';
    const au = card && card.querySelector('.author,[class*="author"],[itemprop="author"]');
    entries.push({ id: url, title, author: textOf(au), summary: '', cover: src ? abs(src, base) : (entries.length === 0 && links.filter(isEpubLink).length === 1 ? og && abs(og, base) : null), kind: 'book', downloads: [{ url, type: 'application/epub+zip', label: 'EPUB' }], series: '', seriesIndex: null });
  }
  // Book detail pages (cards with covers that link elsewhere) when no EPUB links on this page
  if (!entries.length) {
    for (const a of links) {
      const img = a.querySelector('img'); if (!img) continue;
      const href = abs(a.getAttribute('href'), base); if (seen.has(href) || href === base || href.startsWith('javascript')) continue; seen.add(href);
      entries.push({ id: href, title: img.alt || a.title || textOf(a) || 'Open', author: '', summary: '', cover: abs(img.getAttribute('src') || img.getAttribute('data-src') || '', base), kind: 'nav', href, downloads: [] });
    }
  }
  const nextA = doc.querySelector('a[rel~="next"], link[rel~="next"]') || links.find((a) => /^(next|older|more|›|»|>)\s*$/i.test(textOf(a)) || /next/i.test(a.getAttribute('aria-label') || ''));
  return { title: pageTitle, entries, next: nextA ? abs(nextA.getAttribute('href'), base) : null, prev: null, search: null, html: true, url: base };
}

export async function loadHtml(url) {
  const r = await fetchSmart(url);
  return parseHtmlListing(await r.text(), url);
}

/** Auto-detect what a pasted URL is. Returns {kind:'opds'|'html', feed, url, name}. */
export async function detectSource(url) {
  const r = await fetchSmart(url);
  const ct = r.headers.get('content-type') || '';
  const text = await r.text();
  const feed = parseFeedText(text, url, ct);
  if (feed) { feed.url = url; return { kind: 'opds', url, feed, name: feed.title }; }
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const alt = doc.querySelector('link[rel="alternate"][type*="opds"], link[rel="alternate"][type*="atom"][href*="opds"], link[rel="search"][type*="opds"]');
  if (alt) { const u = abs(alt.getAttribute('href'), url); try { const f = await loadFeed(u); return { kind: 'opds', url: u, feed: f, name: f.title || doc.title }; } catch { /* use html */ } }
  const f = parseHtmlListing(text, url);
  return { kind: 'html', url, feed: f, name: (doc.title || new URL(url).hostname).slice(0, 60) };
}

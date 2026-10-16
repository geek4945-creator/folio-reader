// Public-library helpers: step-by-step guide, "Find my library" (Libby / OverDrive directory), catalog search with availability,
// links out to Libby, library-catalog (OPDS / Calibre-Web) help, and the "Where to get DRM-free books" page.
// Library loans are DRM-protected and happen inside Libby; Folio never downloads or imports them.
import { h, sheet, toast, put } from './util.js';
import { fetchSmart } from './net.js';
import { settings } from './settings.js';
import { SEED_SOURCES, getSources, restoreSeeds } from './store.js';

const LOCATE = 'https://locate.libbyapp.com/autocomplete/';
const THUNDER = 'https://thunder.api.overdrive.com/v2/libraries';
const PER_PAGE = 24;
const getJson = async (url) => (await fetchSmart(url, { timeout: 20000 })).json();
export const getLibrary = () => settings.get('publicLibrary');
export const libbyShareUrl = (reserveId) => `https://share.libbyapp.com/title/${reserveId}`;
export const librarySiteUrl = (key, reserveId) => `https://${key}.overdrive.com/media/${reserveId}`;
export const libbyHomeUrl = (key) => `https://libbyapp.com/library/${key}`;
const ext = (href, label, cls = 'btn small') => h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, label);
const closeAll = () => { const o = document.querySelector('#overlay'); o.replaceChildren(); o.hidden = true; };

/* ---------- 1. the guide ---------- */
export function openPublicLibraryGuide() {
  const lib = getLibrary();
  return sheet('Borrow from your public library', (close) => {
    const step = (n, title, ...body) => h('li', { class: 'plib-step' }, h('span', { class: 'plib-n' }, n), h('div', null, h('strong', null, title), ...body));
    return [
      h('p', { class: 'muted' }, 'Most public libraries lend ebooks and audiobooks for free through Libby (OverDrive). Folio helps you find your library and see what is available, and then you borrow in Libby.'),
      lib ? h('div', { class: 'plib-current' }, h('span', null, 'Your library: ', h('strong', null, lib.name)),
        h('button', { class: 'btn primary', id: 'plib-search-btn', onclick: () => { close(); openLibrarySearch(); } }, 'Search ' + lib.name)) : null,
      h('button', { class: lib ? 'btn block' : 'btn primary block', id: 'plib-find-btn', onclick: () => { close(); openFindLibrary(); } }, lib ? 'Change library' : 'Find my library'),
      h('ol', { class: 'plib-steps' },
        step(1, 'Find your library', h('p', { class: 'muted small' }, 'Tap “Find my library” and type its name, your city or your ZIP code. Pick your library system from the list; Folio remembers it. You can have only the libraries you belong to, so choose the one on your library card.')),
        step(2, 'Get a library card number', h('p', { class: 'muted small' }, 'Libby needs a card from that library. If you don’t have one, most libraries give cards free to residents and many let you sign up online (look for “Get a library card” on its website, often an instant e-card). You’ll use the card number, and a PIN if the library uses one, to sign in to Libby.')),
        step(3, 'Search for a title and check availability', h('p', { class: 'muted small' }, 'Search inside Folio. Each result shows “Available now” (borrow immediately), or the number of holds and the estimated wait if all copies are checked out, plus the cover.')),
        step(4, 'Open it in Libby to borrow or place a hold', h('p', { class: 'muted small' }, 'Tap “Open in Libby” on a result. Install Libby from your app store if you haven’t, sign in once with your library card, then tap Borrow or Place Hold. You can read in Libby or, for US libraries, send the book to Kindle.')),
        step(5, 'Important: library books stay inside Libby', h('p', { class: 'plib-warn small' }, 'Borrowed library books are protected by DRM and expire at the end of the loan, so they can’t be imported into Folio, and Folio does not try to get around that. Folio is for DRM-free books: your own files, free public-domain books, and catalogs below.')),
        step(6, 'Does your library have its own catalog feed?', h('p', { class: 'muted small' }, 'A few libraries, and personal servers such as Calibre-Web, publish an OPDS catalog that Folio can browse and download DRM-free books from.'),
          h('button', { class: 'btn small', id: 'plib-catalogs-btn', onclick: () => { close(); openLibraryCatalogHelp(); } }, 'Add a library OPDS / Calibre-Web catalog'))),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', id: 'plib-drmfree-btn', onclick: () => { close(); openDrmFreeHelp(); } }, 'Where to get DRM-free books')),
    ];
  }, { tall: true, closeLabel: 'Done' });
}

/* ---------- 2. find my library ---------- */
export async function searchLibraries(query) {
  const d = await getJson(LOCATE + encodeURIComponent(query.trim()));
  const systems = new Map();
  for (const br of d.branches || []) for (const s of br.systems || []) {
    let e = systems.get(s.id);
    if (!e) { e = { id: s.id, name: s.name, fid: s.fulfillmentId, websiteId: s.websiteId, type: s.type, city: br.city, region: br.regionCode || br.region, country: br.countryCode, branches: 0, sample: br.name }; systems.set(s.id, e); }
    e.branches++;
  }
  return [...systems.values()].filter((s) => s.fid);
}
export async function lookupLibrary(fid) {
  const d = await getJson(`${THUNDER}/${encodeURIComponent(fid)}`);
  return { key: d.preferredKey || d.id || fid, name: d.name };
}
export function openFindLibrary() {
  const q = h('input', { class: 'field', id: 'plib-q', type: 'search', placeholder: 'Library name, city or ZIP code', enterkeyhint: 'search', autocapitalize: 'words' });
  const out = h('div', { class: 'list', id: 'plib-results' }); const msg = h('p', { class: 'muted small', id: 'plib-msg' }, 'Example: “Seattle”, “Brooklyn Public Library” or “98101”.');
  const w = sheet('Find my library', (close) => {
    const go = async (e) => {
      e && e.preventDefault(); const v = q.value.trim(); if (v.length < 2) { msg.textContent = 'Type at least 2 characters.'; return; }
      msg.textContent = 'Searching…'; out.replaceChildren();
      try {
        const res = await searchLibraries(v);
        msg.textContent = res.length ? `${res.length} librar${res.length === 1 ? 'y' : 'ies'} found. Choose the one on your library card.` : 'No libraries found. Try the library’s full name or a nearby city.';
        out.replaceChildren(...res.slice(0, 30).map((s) => h('button', { class: 'list-item plib-result', 'data-fid': s.fid, onclick: async () => {
          try { const info = await lookupLibrary(s.fid); settings.set({ publicLibrary: { name: s.name, key: info.key, fid: s.fid, city: s.city, region: s.region } }); close(); toast('Library set to ' + s.name); openLibrarySearch(); }
          catch (err) { toast('Couldn’t load that library: ' + err.message, 5000); }
        } }, h('span', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'muted small' }, [s.city, s.region].filter(Boolean).join(', ') + (s.branches > 1 ? ` · ${s.branches} branches matched` : ''))), h('span', { class: 'chev' }, '›'))));
      } catch (err) { msg.textContent = 'Search failed: ' + (err.message || err) + ' (check your connection).'; }
    };
    return [h('form', { onsubmit: go, class: 'plib-form' }, q, h('button', { class: 'btn primary', id: 'plib-go', type: 'submit' }, 'Search')), msg, out];
  }, { tall: true });
  setTimeout(() => q.focus(), 80);
  return w;
}

/* ---------- 3. catalog search + availability ---------- */
export async function searchTitles(key, query, { page = 1, type = 'ebook' } = {}) {
  const p = new URLSearchParams({ query, perPage: String(PER_PAGE), page: String(page), sortBy: 'relevance' }); if (type !== 'all') p.set('mediaTypes', type);
  const d = await getJson(`${THUNDER}/${encodeURIComponent(key)}/media?${p}`);
  return { total: d.totalItems || 0, pages: d.links?.last?.page || 1, items: (d.items || []).map(mapItem) };
}
export function mapItem(i) {
  const cover = i.covers?.cover150Wide?.href || i.covers?.cover300Wide?.href || '';
  let state = 'unavailable', label = 'Not in this library';
  if (i.isPreReleaseTitle) { state = 'soon'; label = 'Coming soon'; }
  else if (i.isAvailable) { state = 'available'; label = 'Available now'; }
  else if (i.isOwned || i.ownedCopies > 0) { state = 'wait'; label = 'Wait list'; }
  const wk = i.estimatedWaitDays ? Math.max(1, Math.round(i.estimatedWaitDays / 7)) : 0;
  const detail = state === 'available' ? `${i.availableCopies} of ${i.ownedCopies} cop${i.ownedCopies === 1 ? 'y' : 'ies'} available` : state === 'wait' ? `${i.holdsCount || 0} hold${i.holdsCount === 1 ? '' : 's'} on ${i.ownedCopies} cop${i.ownedCopies === 1 ? 'y' : 'ies'}${wk ? ` · about ${wk} wk wait` : ''}` : '';
  return { reserveId: i.reserveId, title: i.title, author: i.firstCreatorName || '', series: i.series || '', kind: i.type?.name || '', cover, state, label, detail, holdable: !!i.isHoldable };
}
export function openLibrarySearch(initial = '') {
  const lib = getLibrary(); if (!lib) return openFindLibrary();
  let type = 'ebook', page = 1, query = initial, availOnly = false, loaded = [], total = 0, pages = 1;
  const q = h('input', { class: 'field', id: 'plib-search', type: 'search', placeholder: 'Title, author or series', enterkeyhint: 'search', value: initial });
  const list = h('div', { class: 'plib-items', id: 'plib-items' }); const msg = h('p', { class: 'muted small', id: 'plib-status' }); const more = h('button', { class: 'btn block', id: 'plib-more', hidden: true }, 'Load more');
  const w = sheet(lib.name, (close) => {
    const draw = () => {
      const shown = loaded.filter((x) => !availOnly || x.state === 'available');
      list.replaceChildren(...shown.map((x) => h('div', { class: 'plib-item', 'data-state': x.state, 'data-reserve': x.reserveId },
        x.cover ? h('img', { class: 'plib-cover', src: x.cover, alt: '', loading: 'lazy' }) : h('div', { class: 'plib-cover ph' }),
        h('div', { class: 'grow' }, h('div', { class: 'plib-title' }, x.title), h('div', { class: 'muted small' }, x.author + (x.kind ? ' · ' + x.kind : '')), x.series ? h('div', { class: 'badge-series' }, x.series) : null,
          h('div', { class: 'plib-avail ' + x.state }, h('strong', null, x.label), x.detail ? h('span', { class: 'muted small' }, ' ' + x.detail) : null),
          h('div', { class: 'row-actions' },
            x.state !== 'unavailable' ? ext(libbyShareUrl(x.reserveId), x.state === 'available' ? 'Open in Libby to borrow' : 'Open in Libby to place a hold', 'btn small primary plib-libby') : null,
            ext(librarySiteUrl(lib.key, x.reserveId), 'Library website', 'btn small plib-site'))))));
      more.hidden = !(page < pages);
      msg.textContent = loaded.length ? `${total.toLocaleString()} result${total === 1 ? '' : 's'}${availOnly ? ` · showing ${shown.length} available now` : ''}` : (query ? 'No results.' : '');
    };
    const run = async (reset = true) => {
      if (reset) { page = 1; loaded = []; list.replaceChildren(); } if (!query.trim()) { msg.textContent = 'Type a title or author to search.'; return; }
      msg.textContent = 'Searching ' + lib.name + '…';
      try { const r = await searchTitles(lib.key, query.trim(), { page, type }); total = r.total; pages = r.pages; loaded.push(...r.items); draw(); }
      catch (err) { msg.textContent = 'Search failed: ' + (err.message || err); }
    };
    more.onclick = async () => { page++; more.disabled = true; await run(false); more.disabled = false; };
    return [
      h('div', { class: 'plib-note', id: 'plib-drm-note' }, h('strong', null, 'Borrow in Libby. '), 'Library books are DRM-protected and stay inside Libby (or Kindle via Libby). Folio can’t import them; it only shows you what’s available and sends you to Libby.'),
      h('form', { class: 'plib-form', onsubmit: (e) => { e.preventDefault(); query = q.value; run(); } }, q, h('button', { class: 'btn primary', id: 'plib-go', type: 'submit' }, 'Search')),
      h('div', { class: 'seg wide' }, [['ebook', 'eBooks'], ['audiobook', 'Audiobooks'], ['all', 'All']].map(([v, n]) => h('button', { class: type === v ? 'on' : '', 'data-type': v, onclick: (e) => { type = v; e.target.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); if (query.trim()) run(); } }, n))),
      h('label', { class: 'row-ctl' }, h('span', null, 'Available now only'), h('input', { type: 'checkbox', id: 'plib-avail-only', onchange: (e) => { availOnly = e.target.checked; draw(); } })),
      msg, list, more,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn small', id: 'plib-change', onclick: () => { close(); openFindLibrary(); } }, 'Change library'), ext(libbyHomeUrl(lib.key), 'Open ' + lib.name + ' in Libby', 'btn small'), h('button', { class: 'btn small', onclick: () => { close(); openPublicLibraryGuide(); } }, 'How it works')),
    ];
  }, { tall: true });
  if (initial) setTimeout(() => w.body.querySelector('form')?.requestSubmit(), 50);
  return w;
}

/* ---------- 4. library OPDS / Calibre-Web catalogs ---------- */
export function openLibraryCatalogHelp() {
  return sheet('Library & server catalogs', (close) => {
    const list = h('div', { class: 'list', id: 'known-catalogs' }); (async () => {
      const have = new Set((await getSources()).map((s) => s.id));
      list.replaceChildren(...SEED_SOURCES.map((s) => h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'muted small' }, s.note)),
        have.has(s.id) ? h('span', { class: 'muted small' }, '✓ Added') : h('button', { class: 'btn small', 'data-seed': s.id, onclick: async (e) => { await restoreSeeds(); e.target.replaceWith(h('span', { class: 'muted small' }, '✓ Added')); } }, 'Add'))));
    })();
    return [
      h('p', { class: 'muted small' }, 'Folio can browse any catalog that publishes an OPDS feed and download the DRM-free books it offers (with covers). Most public libraries’ OverDrive/Libby collections are not OPDS: use the Public library search for those.'),
      h('h4', null, 'Built-in public catalogs'), list,
      h('h4', null, 'Your own library server'),
      h('ul', { class: 'small plib-addr' },
        h('li', null, h('strong', null, 'Calibre-Web: '), h('code', null, 'https://your-server/opds')),
        h('li', null, h('strong', null, 'Calibre content server: '), h('code', null, 'https://your-server/opds')),
        h('li', null, h('strong', null, 'COPS, Kavita, Komga: '), 'see their “OPDS” settings page for the address.'),
        h('li', null, h('strong', null, 'Koha, Evergreen and other library catalogs: '), 'a few offer an OPDS or Atom feed; ask your librarian for “the OPDS catalog address”. Folio will check whatever you paste and tell you what it found.')),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', id: 'plib-add-source', onclick: async () => { close(); const { addSourceSheet } = await import('./catalogs.js'); addSourceSheet(); } }, 'Add a catalog by address')),
      h('p', { class: 'muted small' }, 'Only add catalogs you have the right to download from. Borrowed (DRM-protected) books can’t be imported.'),
    ];
  }, { tall: true });
}

/* ---------- 5. DRM-free sources ---------- */
export const DRM_FREE_SOURCES = [
  { name: 'Project Gutenberg', url: 'https://www.gutenberg.org', note: 'Over 70,000 public-domain books. Free, DRM-free, built into Folio’s Catalogs tab.' },
  { name: 'Standard Ebooks', url: 'https://standardebooks.org', note: 'Carefully formatted public-domain classics. Free and DRM-free; also in Catalogs.' },
  { name: 'Internet Archive', url: 'https://archive.org', note: 'Public-domain and openly licensed books (the “borrowable” scans use DRM and can’t be imported).' },
  { name: 'Wikisource', url: 'https://wikisource.org', note: 'Free texts you can export as EPUB.' },
  { name: 'Smashwords', url: 'https://www.smashwords.com', note: 'Indie and self-published ebooks, sold DRM-free in EPUB / MOBI / PDF (many free).' },
  { name: 'Humble Bundle books', url: 'https://www.humblebundle.com/books', note: 'Pay-what-you-want ebook bundles delivered as DRM-free EPUB, MOBI and PDF.' },
  { name: 'Baen Books', url: 'https://www.baen.com', note: 'Sci-fi / fantasy publisher selling DRM-free ebooks directly, with a free library of sample titles.' },
  { name: 'Tor / Forge (Macmillan)', url: '', note: 'Tor Publishing Group sells its ebooks DRM-free through most retailers. Check that the store page says DRM-free.' },
  { name: 'Kobo', url: 'https://www.kobo.com', note: 'Most Kobo store books have DRM, but some publishers (and many indie authors) sell DRM-free titles. Only books whose product page says they are DRM-free can be imported.' },
  { name: 'Authors and small publishers', url: '', note: 'Many sell EPUB/PDF directly from their own sites, with no DRM. Technical publishers like O’Reilly and Pragmatic Bookshelf also do.' },
];
export function openDrmFreeHelp() {
  return sheet('Where to get DRM-free books', () => [
    h('p', { class: 'muted' }, 'DRM (“copy protection”) locks a book to one store’s app. Folio can open any book that has no DRM: EPUB, PDF, and MOBI/AZW3 files. Here are places that sell or give away DRM-free books.'),
    h('div', { class: 'list', id: 'drmfree-list' }, DRM_FREE_SOURCES.map((s) => h('div', { class: 'list-item drmfree-item' }, h('div', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'muted small' }, s.note)), s.url ? ext(s.url, 'Visit', 'btn small') : null))),
    h('div', { class: 'plib-warn small' }, h('strong', null, 'What can’t be imported: '), 'Kindle store purchases (AZW/KFX with Amazon DRM), most Kobo and Apple Books purchases, Adobe-DRM EPUBs, and library loans from Libby/OverDrive. Folio detects these and tells you; it doesn’t remove DRM.'),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', onclick: () => { closeAll(); openPublicLibraryGuide(); } }, 'Borrow from a public library instead')),
  ], { tall: true });
}

// Extract metadata, cover and series info from an EPUB using JSZip (vendored global).
const dirname = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
function resolve(base, rel) {
  rel = decodeURIComponent(rel.split('#')[0]);
  const parts = (base + rel).split('/'); const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}
const txt = (el) => (el && el.textContent || '').trim();

export async function parseEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const container = zip.file('META-INF/container.xml');
  if (!container) throw new Error('Not a valid EPUB (missing container.xml)');
  const cdoc = new DOMParser().parseFromString(await container.async('string'), 'application/xml');
  const opfPath = cdoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !zip.file(opfPath)) throw new Error('EPUB package document not found');
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async('string'), 'application/xml');
  const base = dirname(opfPath);
  const md = opf.getElementsByTagNameNS('*', 'metadata')[0] || opf;
  const dc = (name) => [...md.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', name)];
  const metas = [...md.getElementsByTagNameNS('*', 'meta')];

  const meta = {
    title: txt(dc('title')[0]) || 'Untitled',
    author: dc('creator').map(txt).filter(Boolean).join(', ') || 'Unknown author',
    language: txt(dc('language')[0]),
    description: txt(dc('description')[0]).replace(/<[^>]+>/g, '').slice(0, 2000),
    identifier: txt(dc('identifier')[0]), year: parseInt(/\d{4}/.exec(txt(dc('date')[0]))?.[0], 10) || null,
    series: '', seriesIndex: null, coverBlob: null,
  };

  // --- Series: Calibre style, EPUB3 belongs-to-collection, and a few other conventions
  const byName = (n) => metas.find((m) => (m.getAttribute('name') || '').toLowerCase() === n);
  const cs = byName('calibre:series');
  if (cs) { meta.series = (cs.getAttribute('content') || '').trim(); const ci = byName('calibre:series_index'); if (ci) meta.seriesIndex = parseFloat(ci.getAttribute('content')); }
  if (!meta.series) {
    const colls = metas.filter((m) => m.getAttribute('property') === 'belongs-to-collection');
    let pick = null;
    for (const c of colls) {
      const id = c.getAttribute('id');
      const refine = (p) => id && metas.find((m) => m.getAttribute('refines') === '#' + id && m.getAttribute('property') === p);
      const type = txt(refine('collection-type'));
      if (!pick || type === 'series') { pick = { name: txt(c), idx: txt(refine('group-position')), type }; if (type === 'series') break; }
    }
    if (pick && pick.name) { meta.series = pick.name; if (pick.idx) meta.seriesIndex = parseFloat(pick.idx); }
  }
  if (!meta.series) {
    const ms = byName('series') || byName('belongs-to-series');
    if (ms) { meta.series = (ms.getAttribute('content') || '').trim(); const mi = byName('series_index') || byName('series-index'); if (mi) meta.seriesIndex = parseFloat(mi.getAttribute('content')); }
  }
  if (meta.seriesIndex != null && !isFinite(meta.seriesIndex)) meta.seriesIndex = null;

  // --- Cover
  const manifest = [...opf.getElementsByTagNameNS('*', 'item')];
  let item = manifest.find((i) => (i.getAttribute('properties') || '').split(/\s+/).includes('cover-image'));
  if (!item) {
    const cm = byName('cover');
    if (cm) item = manifest.find((i) => i.getAttribute('id') === cm.getAttribute('content'));
  }
  if (!item) item = manifest.find((i) => /cover/i.test(i.getAttribute('id') || '') && /^image\//.test(i.getAttribute('media-type') || ''));
  if (!item) item = manifest.find((i) => /cover/i.test(i.getAttribute('href') || '') && /^image\//.test(i.getAttribute('media-type') || ''));
  if (item) {
    const f = zip.file(resolve(base, item.getAttribute('href')));
    if (f) meta.coverBlob = new Blob([await f.async('arraybuffer')], { type: item.getAttribute('media-type') || 'image/jpeg' });
  }
  return meta;
}

/** Downscale a cover blob so the library stays light. */
export async function shrinkCover(blob, maxW = 360) {
  try {
    const bmp = await createImageBitmap(blob);
    if (bmp.width <= maxW) return blob;
    const scale = maxW / bmp.width;
    const c = document.createElement('canvas');
    c.width = maxW; c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return out || blob;
  } catch { return blob; }
}

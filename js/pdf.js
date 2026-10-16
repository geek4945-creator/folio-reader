// PDF support: lazy-loads the vendored pdf.js (Mozilla, Apache-2.0; local files so it works offline) and extracts metadata + a cover thumbnail.
let lib;
export async function loadPdfjs() {
  if (!lib) {
    lib = await import('../vendor/pdfjs/pdf.min.js');
    lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  }
  return lib;
}
export const PDF_EXT_RE = /\.pdf$/i;
export const PDF_TYPE_RE = /application\/pdf/i;
/** True when the bytes start with the %PDF- header (allowing a little junk before it, as the spec does). */
export function isPdf(buffer) {
  const u8 = new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength));
  for (let i = 0; i + 5 <= u8.length; i++) if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46 && u8[i + 4] === 0x2d) return true;
  return false;
}
export class PdfError extends Error { constructor(m, code) { super(m); this.code = code; } }
const clean = (s) => String(s || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();

export async function openPdfDocument(buffer) {
  const pdfjs = await loadPdfjs();
  try { return await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), isEvalSupported: false }).promise; }
  catch (e) {
    if (e && e.name === 'PasswordException') throw new PdfError('This PDF is password-protected, so Folio can’t import it.', 'locked');
    throw new PdfError('Folio couldn’t read this PDF (' + (e && e.message || 'damaged or unsupported') + ').', 'parse');
  }
}

/** Render page 1 as a small JPEG for the bookshelf. */
export async function renderCover(pdf, width = 360) {
  const page = await pdf.getPage(1); const v1 = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / v1.width });
  const canvas = document.createElement('canvas'); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82)); page.cleanup();
  return blob;
}

/** @returns {{title, author, language, description, identifier, series, seriesIndex, coverBlob, pages}} like parseEpub */
export async function parsePdf(buffer, filename = '') {
  const pdf = await openPdfDocument(buffer);
  try {
    let info = {}, meta = null;
    try { const m = await pdf.getMetadata(); info = m.info || {}; meta = m.metadata; } catch { /* no metadata */ }
    const dc = (k) => { try { return meta && meta.has(k) ? meta.get(k) : ''; } catch { return ''; } };
    const base = filename.replace(PDF_EXT_RE, '').replace(/[_]+/g, ' ').trim();
    let title = clean(info.Title) || clean(dc('dc:title')); if (/^(untitled|microsoft word - )/i.test(title) && base) title = base;
    const author = clean(info.Author) || clean(dc('dc:creator'));
    let coverBlob = null; try { coverBlob = await renderCover(pdf); } catch (e) { console.warn('PDF cover failed', e); }
    return { title: title || base || 'Untitled PDF', author: author || 'Unknown author', language: clean(info.Language) || '', description: clean(info.Subject).slice(0, 2000),
      identifier: (pdf.fingerprints && pdf.fingerprints[0]) ? 'pdf:' + pdf.fingerprints[0] : '', series: '', seriesIndex: null, coverBlob, pages: pdf.numPages };
  } finally { try { await pdf.destroy(); } catch { /* ignore */ } }
}

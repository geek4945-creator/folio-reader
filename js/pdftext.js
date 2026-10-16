// PDF "Text view" (reflow): pulls the text layer out of a page with pdf.js and groups it into headings and paragraphs, so that the reader's
// Text size / Font / Line spacing / Margins apply to a PDF the way they do to an EPUB. Scanned PDFs (no text layer) report an empty page.
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Group raw pdf.js text items into lines → [{ y, h, x, text }] (in reading order as delivered by pdf.js). */
export function toLines(items) {
  const lines = []; let L = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue; const t = it.transform || [1, 0, 0, 1, 0, 0]; const h = Math.abs(it.height) || Math.hypot(t[2], t[3]) || 10; const x = t[4], y = t[5];
    if (!it.str.trim() && !L) continue;
    if (L && Math.abs(y - L.y) <= Math.max(2, L.h * 0.5)) {
      const gap = x - L.end; const sep = L.text && !/\s$/.test(L.text) && !/^\s/.test(it.str) && gap > L.h * 0.18 ? ' ' : '';
      L.text += sep + it.str; L.end = x + (it.width || 0); L.h = Math.max(L.h, h * (it.str.trim() ? 1 : 0));
    } else {
      if (L) lines.push(L);
      L = { y, h, x, end: x + (it.width || 0), text: it.str };
    }
    if (it.hasEOL && L) { lines.push(L); L = null; }
  }
  if (L) lines.push(L);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
}

/** Lines → blocks [{ k: 'h' | 'p', text }]. Headings are noticeably larger lines; paragraphs break on a big vertical gap or an indented sentence start. */
export function toBlocks(lines) {
  if (!lines.length) return [];
  const mh = median(lines.map((l) => l.h)); const gaps = []; for (let i = 1; i < lines.length; i++) { const g = lines[i - 1].y - lines[i].y; if (g > 0) gaps.push(g); }
  const mg = median(gaps) || mh * 1.2; const minX = Math.min(...lines.map((l) => l.x));
  const blocks = []; let cur = null;
  const push = () => { if (cur) { blocks.push(cur); cur = null; } };
  lines.forEach((l, i) => {
    const head = l.h >= mh * 1.25 && l.text.length < 140;
    if (head) { if (cur && cur.k === 'h' && Math.abs(lines[i - 1].y - l.y) < l.h * 1.8) cur.text += ' ' + l.text; else { push(); cur = { k: 'h', text: l.text }; } return; }
    const prev = lines[i - 1]; const gap = prev ? prev.y - l.y : 0; const indent = l.x - minX > mh * 0.9;
    const brk = !cur || cur.k !== 'p' || gap > mg * 1.45 || gap < 0 || (indent && /[.!?:”"')\]]$/.test(cur.text));
    if (brk) { push(); cur = { k: 'p', text: l.text }; }
    else if (/[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(l.text)) cur.text = cur.text.slice(0, -1) + l.text;   // de-hyphenate a wrapped word
    else cur.text += ' ' + l.text;
  });
  push(); return blocks;
}

export async function pageBlocks(page) { const tc = await page.getTextContent(); return toBlocks(toLines(tc.items)); }

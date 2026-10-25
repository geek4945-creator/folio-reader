// v0.5.18 tests: a 24-page text PDF with a nested outline (bookmarks): node tests/make-outline-pdf.js tests/fixtures/outline-24pp.pdf
// Part A (p1) › Chapter 1 (p1), Chapter 2 (p3) › Section 2.1 (p4);  Part B (p6) › Chapter 3 … Chapter 20 (p7 … p24). Page n says "Outline page n of 24".
const fs = require('fs'); const N = 24;
const objs = []; const add = (s) => { objs.push(s); return objs.length; }; const set = (i, s) => { objs[i - 1] = s; };
const CAT = add(''), PAGES = add(''), FONT = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
const pageIds = [];
for (let p = 1; p <= N; p++) {
  const txt = [`Outline page ${p} of 24`, `Lantern ${p} text: the quiet harbour waited while the ferry crossed slowly.`];
  const stream = 'BT /F1 14 Tf 60 740 Td ' + txt.map((t, i) => (i ? '0 -24 Td ' : '') + '(' + t + ') Tj').join(' ') + ' ET';
  const cs = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  pageIds.push(add(`<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${cs} 0 R >>`));
}
set(PAGES, `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${N} >>`);
// outline tree
const tree = [{ t: 'Part A', p: 1, kids: [{ t: 'Chapter 1', p: 1 }, { t: 'Chapter 2', p: 3, kids: [{ t: 'Section 2.1', p: 4 }] }] },
  { t: 'Part B', p: 6, kids: Array.from({ length: 18 }, (_, i) => ({ t: 'Chapter ' + (i + 3), p: i + 7 })) }];
const OUT = add('');
const alloc = (nodes) => nodes.forEach((n) => { n.id = add(''); if (n.kids) alloc(n.kids); });
alloc(tree);
const count = (nodes) => nodes.reduce((a, n) => a + 1 + (n.kids ? count(n.kids) : 0), 0);
const emit = (nodes, parent) => nodes.forEach((n, i) => {
  let d = `<< /Title (${n.t}) /Parent ${parent} 0 R /Dest [${pageIds[n.p - 1]} 0 R /Fit]`;
  if (i > 0) d += ` /Prev ${nodes[i - 1].id} 0 R`; if (i < nodes.length - 1) d += ` /Next ${nodes[i + 1].id} 0 R`;
  if (n.kids) { d += ` /First ${n.kids[0].id} 0 R /Last ${n.kids[n.kids.length - 1].id} 0 R /Count ${count(n.kids)}`; emit(n.kids, n.id); }
  set(n.id, d + ' >>');
});
emit(tree, OUT);
set(OUT, `<< /Type /Outlines /First ${tree[0].id} 0 R /Last ${tree[tree.length - 1].id} 0 R /Count ${count(tree)} >>`);
set(CAT, `<< /Type /Catalog /Pages ${PAGES} 0 R /Outlines ${OUT} 0 R /PageMode /UseOutlines >>`);
let out = '%PDF-1.4\n'; const offs = [];
objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
out += `trailer\n<< /Size ${objs.length + 1} /Root ${CAT} 0 R /Info << /Title (Outline Test PDF) >> >>\nstartxref\n${x}\n%%EOF\n`;
fs.writeFileSync(process.argv[2] || '/tmp/outline-24pp.pdf', out, 'latin1'); console.log('ok');

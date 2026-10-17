// Writes a small text PDF (3 pages, 9 lines each, Helvetica) with plenty of selectable words: node tests/make-prose-pdf.js out.pdf
const fs = require('fs');
const lines = (p) => Array.from({ length: 9 }, (_, i) => `Chapter ${p} line ${i + 1}: the harbour lanterns glowed softly while travellers whispered`);
const objs = []; const add = (s) => { objs.push(s); return objs.length; };
add('<< /Type /Catalog /Pages 2 0 R >>'); add('<< /Type /Pages /Kids [' + [0, 1, 2].map((i) => `${4 + i * 2} 0 R`).join(' ') + '] /Count 3 >>'); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
for (let p = 1; p <= 3; p++) {
  const stream = 'BT /F1 14 Tf 18 20 TL 40 720 Td ' + lines(p).map((l) => `(${l}) Tj T*`).join(' ') + ' ET';
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length + 2} 0 R >>`); add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
}
let out = '%PDF-1.4\n'; const off = []; objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
fs.writeFileSync(process.argv[2] || 'prose-3pp.pdf', out);

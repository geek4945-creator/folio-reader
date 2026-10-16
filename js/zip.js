// Minimal streaming ZIP (STORE) writer + Blob-slice reader, so a backup with thousands of books never has to sit in memory.
// Writer: async generator of Uint8Array chunks (local header → data in ≤1 MB pieces with a running CRC → data descriptor; central directory last). Max 4 GB (no zip64).
// Reader: reads only the central directory, then slices single entries out of the File (STORE directly; DEFLATE through DecompressionStream when present).
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf, prev = 0) { let c = ~prev >>> 0; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }
const enc = new TextEncoder(), dec = new TextDecoder();
const CHUNK = 1 << 20, MAX = 0xffffffff;
const dosTime = (d) => ({ t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), d: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
function u16(v, n, x) { v.setUint16(n, x, true); } function u32(v, n, x) { v.setUint32(n, x >>> 0, true); }

/** entries: iterable of { name, data: Blob | Uint8Array | string }. Yields Uint8Array chunks. onEntry(name, i) is called as each entry starts. */
export async function* zipStream(entries, onEntry) {
  const central = []; let offset = 0; const { t, d } = dosTime(new Date()); let i = 0;
  for await (const e of entries) {
    const name = enc.encode(e.name); const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data; const size = data.size ?? data.length; onEntry && onEntry(e.name, i++);
    if (size > MAX || offset > MAX) throw new Error('This backup would be larger than 4 GB. Export without “Include book files”.');
    const lh = new Uint8Array(30 + name.length); const v = new DataView(lh.buffer);
    u32(v, 0, 0x04034b50); u16(v, 4, 20); u16(v, 6, 0x0808); u16(v, 8, 0); u16(v, 10, t); u16(v, 12, d); u32(v, 14, 0); u32(v, 18, 0); u32(v, 22, 0); u16(v, 26, name.length); u16(v, 28, 0); lh.set(name, 30);
    yield lh; const start = offset; offset += lh.length; let crc = 0;
    if (data instanceof Uint8Array) { crc = crc32(data); yield data; offset += data.length; }
    else for (let p = 0; p < size; p += CHUNK) { const buf = new Uint8Array(await data.slice(p, Math.min(size, p + CHUNK)).arrayBuffer()); crc = crc32(buf, crc); yield buf; offset += buf.length; }
    const dd = new Uint8Array(16); const dv = new DataView(dd.buffer); u32(dv, 0, 0x08074b50); u32(dv, 4, crc); u32(dv, 8, size); u32(dv, 12, size); yield dd; offset += 16;
    central.push({ name, crc, size, start });
  }
  const cdStart = offset; let cdSize = 0;
  for (const c of central) {
    const b = new Uint8Array(46 + c.name.length); const v = new DataView(b.buffer);
    u32(v, 0, 0x02014b50); u16(v, 4, 20); u16(v, 6, 20); u16(v, 8, 0x0808); u16(v, 10, 0); u16(v, 12, t); u16(v, 14, d); u32(v, 16, c.crc); u32(v, 20, c.size); u32(v, 24, c.size); u16(v, 28, c.name.length); u16(v, 30, 0); u16(v, 32, 0); u16(v, 34, 0); u16(v, 36, 0); u32(v, 38, 0); u32(v, 42, c.start); b.set(c.name, 46);
    yield b; cdSize += b.length;
  }
  const eo = new Uint8Array(22); const ev = new DataView(eo.buffer); u32(ev, 0, 0x06054b50); u16(ev, 8, central.length); u16(ev, 10, central.length); u32(ev, 12, cdSize); u32(ev, 16, cdStart); yield eo;
}

const slice = async (blob, a, b) => new DataView(await blob.slice(a, b).arrayBuffer());
/** Open a ZIP held in a Blob / File without reading it whole. Throws a plain Error('Not a ZIP file') for anything else. */
export async function openZip(blob) {
  if (!blob || blob.size < 22) throw new Error('Not a ZIP file');
  const tailLen = Math.min(blob.size, 66000); const tail = await slice(blob, blob.size - tailLen, blob.size); let p = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error('Not a ZIP file');
  const count = tail.getUint16(p + 10, true), cdSize = tail.getUint32(p + 12, true), cdOff = tail.getUint32(p + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported');
  const cd = await slice(blob, cdOff, cdOff + cdSize); const entries = new Map(); let o = 0;
  for (let i = 0; i < count; i++) {
    if (o + 46 > cd.byteLength || cd.getUint32(o, true) !== 0x02014b50) throw new Error('The ZIP index is damaged');
    const method = cd.getUint16(o + 10, true), crc = cd.getUint32(o + 16, true), csize = cd.getUint32(o + 20, true), usize = cd.getUint32(o + 24, true), nl = cd.getUint16(o + 28, true), el = cd.getUint16(o + 30, true), cl = cd.getUint16(o + 32, true), off = cd.getUint32(o + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + o + 46, nl)); entries.set(name, { name, method, crc, csize, usize, off }); o += 46 + nl + el + cl;
  }
  const dataBlob = async (e) => {
    const lh = await slice(blob, e.off, e.off + 30); if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('The ZIP entry “' + e.name + '” is damaged');
    const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true); const raw = blob.slice(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8 && typeof DecompressionStream !== 'undefined') return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    throw new Error('Unsupported ZIP compression in “' + e.name + '”');
  };
  return {
    names: () => [...entries.keys()], has: (n) => entries.has(n), size: (n) => entries.get(n)?.usize ?? 0,
    async blob(n, type = '') { const e = entries.get(n); if (!e) throw new Error('Missing “' + n + '” in the backup'); const b = await dataBlob(e); return type ? b.slice(0, b.size, type) : b; },
    async text(n) { return await (await this.blob(n)).text(); },
    async verify(n) { const e = entries.get(n); const b = await dataBlob(e); let crc = 0; for (let p = 0; p < b.size; p += CHUNK) crc = crc32(new Uint8Array(await b.slice(p, p + CHUNK).arrayBuffer()), crc); return crc === e.crc; },
  };
}

// NoblePDF True Edit (Phase 9 lab): minimal independent TrueType reader for glyph
// availability in embedded FontFile2 programs. Reads only head, maxp, loca and cmap:
// enough to tell whether a glyph exists and has an outline, without PDFium. ASCII only.
export const TE_TTF_VERSION = 'te-ttf-1';

export function parseTrueType(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) === 'ttcf') throw new Error('TrueType collections are not supported in FontFile2');
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + 16 * i;
    tables[tag(o)] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
  }
  for (const t of ['head', 'maxp', 'loca', 'glyf']) if (!tables[t]) throw new Error(`missing ${t} table`);
  const longLoca = dv.getInt16(tables.head.off + 50) === 1;
  const numGlyphs = dv.getUint16(tables.maxp.off + 4);
  const loca = (gid) => (longLoca ? dv.getUint32(tables.loca.off + 4 * gid) : dv.getUint16(tables.loca.off + 2 * gid) * 2);
  const hasGlyph = (gid) => Number.isInteger(gid) && gid >= 0 && gid < numGlyphs;
  const hasOutline = (gid) => hasGlyph(gid) && loca(gid + 1) > loca(gid);
  const subtables = [];
  if (tables.cmap) {
    const c = tables.cmap.off;
    const n = dv.getUint16(c + 2);
    for (let i = 0; i < n; i++) {
      const platform = dv.getUint16(c + 4 + 8 * i);
      const encoding = dv.getUint16(c + 6 + 8 * i);
      const off = c + dv.getUint32(c + 8 + 8 * i);
      subtables.push({ platform, encoding, off, format: dv.getUint16(off) });
    }
  }
  const lookup = (st, code) => {
    const o = st.off;
    if (st.format === 4) {
      const segX2 = dv.getUint16(o + 6);
      const ends = o + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let k = 0; k < segX2; k += 2) {
        const end = dv.getUint16(ends + k);
        if (code > end) continue;
        const start = dv.getUint16(starts + k);
        if (code < start) return 0;
        const delta = dv.getInt16(deltas + k);
        const ro = dv.getUint16(ranges + k);
        if (!ro) return (code + delta) & 0xffff;
        const g = dv.getUint16(ranges + k + ro + 2 * (code - start));
        return g ? (g + delta) & 0xffff : 0;
      }
      return 0;
    }
    if (st.format === 12) {
      const groups = dv.getUint32(o + 12);
      for (let k = 0; k < groups; k++) {
        const g = o + 16 + 12 * k;
        const s = dv.getUint32(g);
        const e = dv.getUint32(g + 4);
        if (code >= s && code <= e) return dv.getUint32(g + 8) + (code - s);
      }
      return 0;
    }
    if (st.format === 0) return code < 256 ? u8[o + 6 + code] : 0;
    if (st.format === 6) {
      const first = dv.getUint16(o + 6);
      const count = dv.getUint16(o + 8);
      return code >= first && code < first + count ? dv.getUint16(o + 10 + 2 * (code - first)) : 0;
    }
    return 0;
  };
  const find = (platform, encoding) => subtables.filter((s) => s.platform === platform && s.encoding === encoding && [0, 4, 6, 12].includes(s.format));
  const unicodeTables = [...find(3, 10), ...find(0, 4), ...find(0, 6), ...find(3, 1), ...find(0, 3)];
  const gidForUnicode = (cp) => {
    for (const st of unicodeTables) { const g = lookup(st, cp); if (g) return g; }
    return 0;
  };
  // Symbolic simple fonts: (3,0) with the code, 0xF000+code etc., then (1,0).
  const gidForSymbolicCode = (code) => {
    for (const st of find(3, 0)) for (const base of [0, 0xf000, 0xf100, 0xf200]) { const g = lookup(st, base + code); if (g) return g; }
    for (const st of find(1, 0)) { const g = lookup(st, code); if (g) return g; }
    return 0;
  };
  return { numGlyphs, hasGlyph, hasOutline, gidForUnicode, gidForSymbolicCode, tables: Object.keys(tables) };
}

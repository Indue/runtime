// NoblePDF True Edit (Phase 9 lab): independent PDF reader.
// Parses objects, fonts and page content WITHOUT PDFium or PDF.js, so glyph codes,
// widths and positions can be checked against the engines instead of against
// themselves. Scope is deliberately narrow; anything it cannot interpret is
// reported so callers fail closed. ASCII only.
import { latin1, scanPdf, inflateZlib } from './phase8-verify.mjs?v=1';
import { BASE_ENCODINGS, GLYPH_TO_UNICODE, STD14_WIDTHS, STD14_ALIASES } from './te-data.mjs?v=1';
import { parseTrueType } from './te-ttf.mjs?v=1';

export const TE_PDF_VERSION = 'te-pdf-1';

export class TeUnsupported extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
export class PdfName { constructor(name) { this.name = name; } toString() { return `/${this.name}`; } }
export class PdfRef { constructor(num, gen) { this.num = num; this.gen = gen; } get key() { return `${this.num} ${this.gen}`; } }
export class PdfStr { constructor(s, hex) { this.s = s; this.hex = hex; } }

const WS = ' \t\r\n\f\0';
const DELIMS = '()<>[]{}/%';
const isWs = (c) => c !== undefined && WS.includes(c);
const isDelim = (c) => c !== undefined && DELIMS.includes(c);
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
// PDF strings are held as Latin-1 byte strings; this is byte access, not text processing.
const byteAt = (bytes, i) => bytes.charCodeAt(i);
export const nameOf = (v) => (v instanceof PdfName ? v.name : null);

// ------------------------------------------------------------------ lexer / value parser
function skip(s, i) {
  for (;;) {
    while (i < s.length && isWs(s[i])) i++;
    if (s[i] === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    return i;
  }
}
function readLiteral(s, i) {
  let depth = 1;
  let out = '';
  let k = i + 1;
  while (k < s.length && depth > 0) {
    const c = s[k];
    if (c === '\\') {
      const n = s[k + 1];
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (n in map) { out += map[n]; k += 2; continue; }
      if (n === '\r' || n === '\n') { k += 2; if (n === '\r' && s[k] === '\n') k++; continue; }
      if (n >= '0' && n <= '7') {
        let oct = n;
        k += 2;
        while (oct.length < 3 && s[k] >= '0' && s[k] <= '7') { oct += s[k]; k++; }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        continue;
      }
      k += 1;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (depth === 0) { k++; break; } }
    out += c;
    k++;
  }
  return { value: new PdfStr(out, false), pos: k };
}
function readHex(s, i) {
  const end = s.indexOf('>', i);
  const h = s.slice(i + 1, end === -1 ? s.length : end).replace(/[^0-9A-Fa-f]/g, '');
  const even = h.length % 2 ? `${h}0` : h;
  let out = '';
  for (let k = 0; k < even.length; k += 2) out += String.fromCharCode(parseInt(even.slice(k, k + 2), 16));
  return { value: new PdfStr(out, true), pos: end === -1 ? s.length : end + 1 };
}
function readName(s, i) {
  let k = i + 1;
  while (k < s.length && !isWs(s[k]) && !isDelim(s[k])) k++;
  const raw = s.slice(i + 1, k).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return { value: new PdfName(raw), pos: k };
}
function readToken(s, i) {
  let k = i;
  while (k < s.length && !isWs(s[k]) && !isDelim(s[k])) k++;
  return { tok: s.slice(i, k), pos: k };
}
// Parses one PDF value at s[i]. Integers followed by "gen R" become PdfRef.
export function parseValue(s, i) {
  i = skip(s, i);
  const c = s[i];
  if (c === '<' && s[i + 1] === '<') {
    const d = Object.create(null);
    i += 2;
    for (;;) {
      i = skip(s, i);
      if (i >= s.length) throw new Error('unterminated dictionary');
      if (s[i] === '>' && s[i + 1] === '>') { i += 2; break; }
      if (s[i] !== '/') throw new Error(`dictionary key expected at ${i}`);
      const k = readName(s, i);
      const v = parseValue(s, k.pos);
      d[k.value.name] = v.value;
      i = v.pos;
    }
    return { value: d, pos: i };
  }
  if (c === '<') return readHex(s, i);
  if (c === '(') return readLiteral(s, i);
  if (c === '/') return readName(s, i);
  if (c === '[') {
    const arr = [];
    i++;
    for (;;) {
      i = skip(s, i);
      if (i >= s.length) throw new Error('unterminated array');
      if (s[i] === ']') { i++; break; }
      const v = parseValue(s, i);
      arr.push(v.value);
      i = v.pos;
    }
    return { value: arr, pos: i };
  }
  const t = readToken(s, i);
  if (t.tok === 'true') return { value: true, pos: t.pos };
  if (t.tok === 'false') return { value: false, pos: t.pos };
  if (t.tok === 'null') return { value: null, pos: t.pos };
  if (NUM_RE.test(t.tok)) {
    const n = Number(t.tok);
    if (/^\d+$/.test(t.tok)) {
      const a = skip(s, t.pos);
      const g = readToken(s, a);
      if (/^\d+$/.test(g.tok)) {
        const b = skip(s, g.pos);
        if (s[b] === 'R' && (b + 1 >= s.length || isWs(s[b + 1]) || isDelim(s[b + 1]))) return { value: new PdfRef(n, Number(g.tok)), pos: b + 1 };
      }
    }
    return { value: n, pos: t.pos };
  }
  throw new Error(`unexpected token ${JSON.stringify(t.tok)} at ${i}`);
}

// ------------------------------------------------------------------ document
export class PdfDoc {
  static async load(bytes) {
    const d = new PdfDoc(bytes);
    await d.init();
    return d;
  }
  constructor(bytes) {
    this.bytes = bytes;
    this.objects = new Map();
    this.warnings = [];
    this.fontCache = new Map();
  }
  async init() {
    const scan = scanPdf(this.bytes);
    this.scan = scan;
    const s = scan.text;
    for (const o of scan.objects) {
      let value;
      try { value = parseValue(s, o.bodyStart).value; } catch (e) { this.warnings.push(`object ${o.num}: ${e.message}`); continue; }
      const entry = { num: o.num, gen: o.gen, value };
      if (o.stream) entry.stream = { start: o.stream.dataStart, end: o.stream.dataEnd };
      this.objects.set(o.num, entry);
    }
    this.objStmCount = 0;
    for (const e of [...this.objects.values()]) {
      if (!e.stream || nameOf(e.value && e.value.Type) !== 'ObjStm') continue;
      this.objStmCount++;
      const data = latin1(await this.streamBytes(e));
      const n = this.resolve(e.value.N);
      const first = this.resolve(e.value.First);
      const head = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k < n; k++) {
        const num = head[2 * k];
        const off = head[2 * k + 1];
        if (this.objects.has(num)) continue;
        try { this.objects.set(num, { num, gen: 0, value: parseValue(data, first + off).value, fromObjStm: true }); } catch (err) { this.warnings.push(`objstm ${num}: ${err.message}`); }
      }
    }
    this.root = this.findRoot();
    if (!this.root) throw new TeUnsupported('pdf-no-root', 'document catalog not found');
  }
  findRoot() {
    const m = this.scan.masked;
    let rootRef = null;
    for (const t of m.matchAll(/trailer[\s\S]*?\/Root\s+(\d+)\s+(\d+)\s+R/g)) rootRef = new PdfRef(Number(t[1]), Number(t[2]));
    if (!rootRef) {
      for (const e of this.objects.values()) if (e.stream && nameOf(e.value.Type) === 'XRef' && e.value.Root instanceof PdfRef) rootRef = e.value.Root;
    }
    if (rootRef) return this.resolve(rootRef);
    for (const e of this.objects.values()) if (e.value && nameOf(e.value.Type) === 'Catalog') return e.value;
    return null;
  }
  entry(ref) { return ref instanceof PdfRef ? this.objects.get(ref.num) || null : null; }
  resolve(v, depth = 0) {
    if (!(v instanceof PdfRef)) return v;
    if (depth > 16) throw new Error('reference chain too deep');
    const e = this.objects.get(v.num);
    return e ? this.resolve(e.value, depth + 1) : null;
  }
  async streamBytes(entryOrRef) {
    const e = entryOrRef instanceof PdfRef ? this.entry(entryOrRef) : entryOrRef;
    if (!e || !e.stream) throw new TeUnsupported('pdf-stream-missing', 'expected a stream object');
    let data = this.bytes.subarray(e.stream.start, e.stream.end);
    const len = this.resolve(e.value.Length);
    if (Number.isInteger(len) && len >= 0 && len <= data.length) data = data.subarray(0, len);
    const f = this.resolve(e.value.Filter);
    const filters = f == null ? [] : (Array.isArray(f) ? f.map((x) => nameOf(this.resolve(x))) : [nameOf(f)]);
    for (const name of filters) {
      if (name !== 'FlateDecode' && name !== 'Fl') throw new TeUnsupported('pdf-filter-unsupported', `stream filter ${name}`);
      const parms = this.resolve(e.value.DecodeParms);
      if (parms && this.resolve(parms.Predictor) > 1) throw new TeUnsupported('pdf-predictor-unsupported', 'stream predictor');
      data = await inflateZlib(data);
    }
    return data;
  }
  pages() {
    const out = [];
    const walk = (nodeRef, inherited, depth) => {
      if (depth > 32) throw new Error('page tree too deep');
      const node = this.resolve(nodeRef);
      if (!node) return;
      const inh = { ...inherited };
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node[k] !== undefined) inh[k] = node[k];
      if (nameOf(node.Type) === 'Pages' || Array.isArray(this.resolve(node.Kids))) {
        for (const kid of this.resolve(node.Kids) || []) walk(kid, inh, depth + 1);
      } else {
        const contents = this.resolve(node.Contents);
        const list = contents == null ? [] : (Array.isArray(contents) ? contents : [node.Contents]);
        out.push({ ref: nodeRef instanceof PdfRef ? nodeRef : null, dict: node, resources: this.resolve(inh.Resources) || {}, mediaBox: this.resolve(inh.MediaBox), rotate: Number(this.resolve(inh.Rotate) || 0), contents: list });
      }
    };
    walk(this.root.Pages, {}, 0);
    return out;
  }
}

// ------------------------------------------------------------------ ToUnicode CMap
function hexCode(h) { return parseInt(h, 16); }
function utf16beToCps(hex) {
  const units = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length === 2) units.push(parseInt(hex, 16));
  const cps = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u >= 0xd800 && u <= 0xdbff && i + 1 < units.length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff) {
      cps.push(0x10000 + ((u - 0xd800) << 10) + (units[i + 1] - 0xdc00));
      i++;
    } else cps.push(u);
  }
  return cps;
}
export function parseToUnicode(text) {
  const map = new Map();
  const ranges = [];
  for (const b of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const r of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) ranges.push({ bytes: r[1].length / 2, lo: hexCode(r[1]), hi: hexCode(r[2]) });
  }
  for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const r of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(hexCode(r[1]), utf16beToCps(r[2]));
  }
  for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = b[1];
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g;
    for (const r of body.matchAll(re)) {
      const lo = hexCode(r[1]);
      const hi = hexCode(r[2]);
      if (hi - lo > 65535) continue;
      if (r[4] !== undefined) {
        const base = utf16beToCps(r[4]);
        for (let c = lo; c <= hi; c++) {
          const cps = base.slice();
          cps[cps.length - 1] += c - lo;
          map.set(c, cps);
        }
      } else {
        const items = [...r[5].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => utf16beToCps(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      }
    }
  }
  return { map, ranges };
}

// ------------------------------------------------------------------ font model
const STD14 = new Set(Object.keys(STD14_WIDTHS));
function glyphNameToCps(name) {
  if (!name) return null;
  const g = GLYPH_TO_UNICODE[name];
  if (g !== undefined) return Array.isArray(g) ? g : [g];
  let m = /^uni([0-9A-F]{4})$/.exec(name);
  if (m) return [parseInt(m[1], 16)];
  m = /^u([0-9A-F]{4,6})$/.exec(name);
  if (m) return [parseInt(m[1], 16)];
  return null;
}
function stripSubset(name) { return name ? name.replace(/^[A-Z]{6}\+/, '') : name; }

// Validated font classes. Anything else is refused with a reason code.
export const VALIDATED_FONT_CLASSES = ['std14-type1', 'truetype-simple-embedded', 'type0-identity-h-cidfonttype2'];

export async function loadFontModel(doc, fontRef) {
  const key = fontRef instanceof PdfRef ? fontRef.key : null;
  if (key && doc.fontCache.has(key)) return doc.fontCache.get(key);
  const f = doc.resolve(fontRef);
  const model = await buildFontModel(doc, f || {});
  model.key = key;
  if (key) doc.fontCache.set(key, model);
  return model;
}

async function buildFontModel(doc, f) {
  const R = (v) => doc.resolve(v);
  const subtype = nameOf(R(f.Subtype));
  const baseFont = stripSubset(nameOf(R(f.BaseFont)) || '');
  const m = {
    subtype, baseFont, kind: subtype === 'Type0' ? 'type0' : 'simple', bytesPerCode: 1, fontClass: null,
    unsupported: null, embedded: false, symbolic: false, hasToUnicode: false, vertical: false,
    codeToCps: new Map(), widths: new Map(), defaultWidth: 0, widthSource: '', glyphNames: new Map(),
  };
  let toUni = null;
  if (f.ToUnicode) {
    try {
      toUni = parseToUnicode(latin1(await doc.streamBytes(f.ToUnicode instanceof PdfRef ? doc.entry(f.ToUnicode) : null)));
      m.hasToUnicode = true;
    } catch (e) { m.unsupported = { code: 'font-tounicode-unreadable', detail: e.message }; return finish(m, doc); }
  }
  if (subtype === 'Type3') { m.unsupported = { code: 'font-type3', detail: 'Type3 fonts are not supported' }; return finish(m, doc); }
  if (subtype === 'Type0') {
    m.bytesPerCode = 2;
    const enc = nameOf(R(f.Encoding));
    if (enc === 'Identity-V') { m.vertical = true; m.unsupported = { code: 'font-vertical', detail: 'vertical writing (Identity-V)' }; return finish(m, doc); }
    if (enc !== 'Identity-H') { m.unsupported = { code: 'font-cmap-unsupported', detail: `Type0 encoding ${enc || 'stream CMap'} (only Identity-H is validated)` }; return finish(m, doc); }
    const desc = R((R(f.DescendantFonts) || [])[0]) || {};
    const dsub = nameOf(R(desc.Subtype));
    const fd = R(desc.FontDescriptor) || {};
    m.embedded = !!(fd.FontFile2 || fd.FontFile3 || fd.FontFile);
    if (dsub !== 'CIDFontType2' || !fd.FontFile2) { m.unsupported = { code: 'font-class-not-validated', detail: `Type0 with ${dsub}${fd.FontFile2 ? '' : ' (not embedded as FontFile2)'}` }; return finish(m, doc); }
    m.fontClass = 'type0-identity-h-cidfonttype2';
    m.fontFileRef = fd.FontFile2;
    const c2g = desc.CIDToGIDMap;
    m.cidToGidRef = c2g instanceof PdfRef ? c2g : null;
    if (!m.cidToGidRef && nameOf(R(c2g)) !== 'Identity' && c2g !== undefined) { m.unsupported = { code: 'font-cidtogid-unsupported', detail: 'CIDToGIDMap is neither /Identity nor a stream' }; return finish(m, doc); }
    m.defaultWidth = Number(R(desc.DW) ?? 1000);
    const W = R(desc.W) || [];
    for (let i = 0; i < W.length;) {
      const first = R(W[i]);
      const next = R(W[i + 1]);
      if (Array.isArray(next)) { next.forEach((w, k) => m.widths.set(first + k, Number(R(w)))); i += 2; } else { const last = next; const w = Number(R(W[i + 2])); for (let c = first; c <= last && c - first < 65536; c++) m.widths.set(c, w); i += 3; }
    }
    m.widthSource = '/W';
    if (!toUni) { m.unsupported = { code: 'font-no-unicode-map', detail: 'Type0 font without ToUnicode' }; return finish(m, doc); }
    for (const [code, cps] of toUni.map) m.codeToCps.set(code, cps);
    return finish(m, doc);
  }
  if (subtype !== 'Type1' && subtype !== 'TrueType' && subtype !== 'MMType1') { m.unsupported = { code: 'font-class-not-validated', detail: `font subtype ${subtype}` }; return finish(m, doc); }
  const fd = R(f.FontDescriptor) || {};
  const flags = Number(R(fd.Flags) || 0);
  m.symbolic = !!(flags & 4);
  m.embedded = !!(fd.FontFile || fd.FontFile2 || fd.FontFile3);
  const std = STD14.has(baseFont) ? baseFont : (STD14_ALIASES[baseFont] || null);
  if (subtype === 'Type1' && !m.embedded && std) m.fontClass = 'std14-type1';
  else if (subtype === 'TrueType' && fd.FontFile2) m.fontClass = 'truetype-simple-embedded';
  else { m.unsupported = { code: 'font-class-not-validated', detail: `${subtype} ${baseFont}${m.embedded ? ' embedded' : ' not embedded'}` }; return finish(m, doc); }
  m.std14 = m.fontClass === 'std14-type1' ? std : null;
  if (m.fontClass === 'truetype-simple-embedded') m.fontFileRef = fd.FontFile2;
  // encoding: base + Differences
  const encV = R(f.Encoding);
  let baseName = null;
  let diffs = null;
  if (encV instanceof PdfName) baseName = encV.name;
  else if (encV && typeof encV === 'object') { baseName = nameOf(R(encV.BaseEncoding)); diffs = R(encV.Differences); }
  if (baseName && !BASE_ENCODINGS[baseName]) { m.unsupported = { code: 'font-encoding-unsupported', detail: `base encoding ${baseName}` }; return finish(m, doc); }
  if (!baseName) baseName = m.symbolic && m.fontClass !== 'std14-type1' ? null : 'StandardEncoding';
  const names = new Array(256).fill(null);
  if (baseName) BASE_ENCODINGS[baseName].forEach((n, i) => { names[i] = n; });
  if (Array.isArray(diffs)) {
    let code = 0;
    for (const d of diffs) {
      const v = R(d);
      if (typeof v === 'number') code = v;
      else if (v instanceof PdfName) { if (code < 256) names[code] = v.name; code++; }
    }
  }
  names.forEach((n, code) => { if (n) m.glyphNames.set(code, n); });
  // code -> Unicode: ToUnicode wins (as in PDFium and PDF.js), otherwise glyph names
  for (let code = 0; code < 256; code++) {
    const tu = toUni && toUni.map.get(code);
    if (tu) { m.codeToCps.set(code, tu); continue; }
    const cps = glyphNameToCps(names[code]);
    if (cps) m.codeToCps.set(code, cps);
  }
  if (!m.codeToCps.size) { m.unsupported = { code: 'font-no-unicode-map', detail: 'no ToUnicode and no standard glyph names' }; return finish(m, doc); }
  // widths
  const widthsArr = R(f.Widths);
  const firstChar = Number(R(f.FirstChar) ?? 0);
  m.defaultWidth = Number(R(fd.MissingWidth) ?? 0);
  if (Array.isArray(widthsArr)) {
    widthsArr.forEach((w, i) => m.widths.set(firstChar + i, Number(R(w))));
    m.widthSource = '/Widths';
  } else if (m.std14) {
    const afm = STD14_WIDTHS[m.std14];
    for (let code = 0; code < 256; code++) { const n = names[code]; if (n && afm[n] !== undefined) m.widths.set(code, afm[n]); }
    m.widthSource = 'AFM';
  } else { m.unsupported = { code: 'font-no-widths', detail: 'embedded simple font without /Widths' }; return finish(m, doc); }
  return finish(m, doc);
}

function finish(m, doc) {
  // Embedded TrueType program, parsed lazily and independently of PDFium (te-ttf.mjs).
  m.program = async () => {
    if (!m.fontFileRef) return null;
    if (!m._prog) {
      m._prog = parseTrueType(await doc.streamBytes(m.fontFileRef));
      if (m.cidToGidRef) m._c2g = await doc.streamBytes(m.cidToGidRef);
    }
    return m._prog;
  };
  // Glyph id a viewer uses for a code (call program() first). 0 means .notdef / missing.
  m.gidForCode = (code, cp) => {
    const prog = m._prog;
    if (!prog) return null;
    if (m.kind === 'type0') {
      if (m._c2g) return 2 * code + 1 < m._c2g.length ? (m._c2g[2 * code] << 8) | m._c2g[2 * code + 1] : 0;
      return code;
    }
    return m.symbolic ? prog.gidForSymbolicCode(code) : prog.gidForUnicode(cp);
  };
  m.width = (code) => (m.widths.has(code) ? m.widths.get(code) : m.defaultWidth);
  m.hasWidth = (code) => m.widths.has(code);
  m.cpsOf = (code) => m.codeToCps.get(code) || null;
  // Reverse map Unicode -> code. Candidates with a declared non-zero width win (a code
  // outside /Widths or /W would draw with no advance); among those the lowest code is
  // used and candidates with different widths make the mapping ambiguous. A Unicode
  // value reachable only through undeclared codes is returned with declared=false.
  m.declared = (code) => m.widths.has(code) && m.widths.get(code) > 0;
  const cand = new Map();
  for (const [code, cps] of [...m.codeToCps.entries()].sort((a, b) => a[0] - b[0])) {
    if (cps.length !== 1) continue;
    if (!cand.has(cps[0])) cand.set(cps[0], []);
    cand.get(cps[0]).push(code);
  }
  const rev = new Map();
  for (const [cp, codes] of cand) {
    const dec = codes.filter((c) => m.declared(c));
    if (dec.length) rev.set(cp, { code: dec[0], declared: true, ambiguous: dec.some((c) => m.width(c) !== m.width(dec[0])) });
    else rev.set(cp, { code: codes[0], declared: false, ambiguous: false });
  }
  m.codeForCp = (cp) => rev.get(cp) || null;
  const sp = rev.get(0x20);
  m.spaceCode = sp ? sp.code : null;
  m.spaceWidth = sp ? m.width(sp.code) : null;
  m.splitCodes = (bytes) => {
    const out = [];
    if (m.bytesPerCode === 1) for (let i = 0; i < bytes.length; i++) out.push(byteAt(bytes, i));
    else for (let i = 0; i + 1 < bytes.length; i += 2) out.push((byteAt(bytes, i) << 8) | byteAt(bytes, i + 1));
    return out;
  };
  m.encodeCodes = (codes) => codes.map((c) => (m.bytesPerCode === 1 ? String.fromCharCode(c & 0xff) : String.fromCharCode((c >> 8) & 0xff, c & 0xff))).join('');
  return m;
}

// ------------------------------------------------------------------ content interpretation
export const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
export const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
const ID = [1, 0, 0, 1, 0, 0];

function* contentOps(s) {
  let i = 0;
  let args = [];
  while (i < s.length) {
    i = skip(s, i);
    if (i >= s.length) break;
    const c = s[i];
    if (c === '/' || c === '(' || c === '[' || c === '<' || c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      const v = parseValue(s, i);
      args.push(v.value);
      i = v.pos;
      continue;
    }
    if (c === ')' || c === ']' || c === '>' || c === '{' || c === '}') { i++; continue; }
    const t = readToken(s, i);
    i = t.pos;
    if (t.tok === 'true' || t.tok === 'false' || t.tok === 'null') { args.push(t.tok === 'true' ? true : (t.tok === 'false' ? false : null)); continue; }
    if (t.tok === 'BI') {
      const idAt = s.indexOf('ID', i);
      const re = /[ \t\r\n\f\0]EI(?=[ \t\r\n\f\0]|$)/g;
      re.lastIndex = idAt === -1 ? s.length : idAt + 2;
      const m = re.exec(s);
      i = m ? m.index + 3 : s.length;
      yield { op: 'BI', args: [] };
      args = [];
      continue;
    }
    yield { op: t.tok, args };
    args = [];
  }
}

// Interprets one page: every text-showing operation with glyph codes, widths and
// page-space origins computed from the PDF itself (ISO 32000-1 9.4.4).
export async function interpretPage(doc, pageIndex) {
  const page = doc.pages()[pageIndex];
  if (!page) throw new TeUnsupported('pdf-page-missing', `page ${pageIndex}`);
  const shows = [];
  const counters = { images: 0, inlineImages: 0, forms: 0, paths: 0, shadings: 0, tzOps: 0, tsOps: 0, extGStateFont: 0, streams: 0, streamRefs: new Set() };
  const unsupported = [];
  const contentTexts = [];
  for (const ref of page.contents) {
    const e = doc.entry(ref);
    if (!e) continue;
    counters.streamRefs.add(e.num);
    contentTexts.push(latin1(await doc.streamBytes(e)));
  }
  counters.streams = contentTexts.length;
  const text = contentTexts.join('\n');
  await runContent(doc, text, page.resources, ID, { depth: 0, inForm: null }, shows, counters, unsupported);
  return { page, shows, counters, unsupported, contentLength: text.length };
}

async function runContent(doc, text, resources, baseCtm, ctx, shows, counters, unsupported) {
  const R = (v) => doc.resolve(v);
  const res = R(resources) || {};
  const gsStack = [];
  let gs = { ctm: baseCtm.slice(), tc: 0, tw: 0, th: 1, tl: 0, font: null, fontName: null, size: 0, tr: 0, ts: 0, clip: false };
  let tm = ID.slice();
  let tlm = ID.slice();
  let inText = false;
  const marks = [];
  let pendingClip = false;
  let opIndex = 0;
  const fontsDict = R(res.Font) || {};
  const setFont = async (name, size) => {
    const ref = fontsDict[name];
    gs.fontName = name;
    gs.size = size;
    gs.font = ref ? await loadFontModel(doc, ref) : null;
    if (!ref) unsupported.push({ code: 'pdf-font-missing', detail: `font resource /${name}` });
  };
  const showString = (str, op, tjItems) => {
    const f = gs.font;
    const rec = {
      id: shows.length, op, opIndex, inForm: ctx.inForm, font: f, fontName: gs.fontName, size: gs.size, tc: gs.tc, tw: gs.tw, tz: gs.th * 100,
      ts: gs.ts, tr: gs.tr, tl: gs.tl, clip: gs.clip, ctm: gs.ctm.slice(), tmStart: tm.slice(), marks: marks.map((mk) => ({ ...mk })), glyphs: [], bytes: '', tj: tjItems || null,
    };
    let xText = 0;
    const items = tjItems || [str];
    for (const it of items) {
      if (typeof it === 'number') {
        const tx = -(it / 1000) * gs.size * gs.th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
        xText += -(it / 1000) * gs.size;
        continue;
      }
      const bytes = it.s;
      rec.bytes += bytes;
      const codes = f ? f.splitCodes(bytes) : Array.from({ length: bytes.length }, (_, k) => byteAt(bytes, k));
      for (const code of codes) {
        const w0 = f ? f.width(code) : 0;
        const trm = mul(tm, gs.ctm);
        const origin = apply(trm, 0, gs.ts);
        const wordSpace = code === 32 && (!f || f.bytesPerCode === 1) ? gs.tw : 0;
        rec.glyphs.push({ code, cps: f ? f.cpsOf(code) : null, width1000: w0, xText, origin });
        const adv = (w0 / 1000) * gs.size + gs.tc + wordSpace;
        tm = mul([1, 0, 0, 1, adv * gs.th, 0], tm);
        xText += adv;
      }
    }
    rec.tmEnd = tm.slice();
    shows.push(rec);
  };
  for (const { op, args } of contentOps(text)) {
    opIndex++;
    const n = (k) => Number(args[k]);
    switch (op) {
      case 'q': gsStack.push({ ...gs, ctm: gs.ctm.slice() }); break;
      case 'Q': if (gsStack.length) gs = gsStack.pop(); break;
      case 'cm': gs.ctm = mul([n(0), n(1), n(2), n(3), n(4), n(5)], gs.ctm); break;
      case 'BT': inText = true; tm = ID.slice(); tlm = ID.slice(); break;
      case 'ET': inText = false; break;
      case 'Tc': gs.tc = n(0); break;
      case 'Tw': gs.tw = n(0); break;
      case 'Tz': gs.th = n(0) / 100; if (n(0) !== 100) counters.tzOps++; break;
      case 'TL': gs.tl = n(0); break;
      case 'Tr': gs.tr = n(0); break;
      case 'Ts': gs.ts = n(0); if (n(0) !== 0) counters.tsOps++; break;
      case 'Tf': await setFont(nameOf(args[0]), n(1)); break;
      case 'Td': tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm.slice(); break;
      case 'TD': gs.tl = -n(1); tlm = mul([1, 0, 0, 1, n(0), n(1)], tlm); tm = tlm.slice(); break;
      case 'Tm': tlm = [n(0), n(1), n(2), n(3), n(4), n(5)]; tm = tlm.slice(); break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm.slice(); break;
      case 'Tj': if (args[0] instanceof PdfStr) showString(args[0], 'Tj'); break;
      case 'TJ': if (Array.isArray(args[0])) showString(null, 'TJ', args[0]); break;
      case "'": tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm.slice(); if (args[0] instanceof PdfStr) showString(args[0], "'"); break;
      case '"': gs.tw = n(0); gs.tc = n(1); tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm.slice(); if (args[2] instanceof PdfStr) showString(args[2], '"'); break;
      case 'BDC': case 'BMC': {
        let props = op === 'BDC' ? args[1] : null;
        if (props instanceof PdfName) props = R((R(res.Properties) || {})[props.name]);
        props = R(props) || {};
        marks.push({ tag: nameOf(args[0]), mcid: props.MCID !== undefined ? R(props.MCID) : null, actualText: props.ActualText !== undefined, alt: props.Alt !== undefined, expansion: props.E !== undefined, oc: nameOf(args[0]) === 'OC' });
        break;
      }
      case 'EMC': marks.pop(); break;
      case 'gs': { const g = R((R(res.ExtGState) || {})[nameOf(args[0])]); if (g && g.Font) { counters.extGStateFont++; unsupported.push({ code: 'pdf-extgstate-font', detail: 'font set through ExtGState' }); } break; }
      case 'Do': {
        const xo = (R(res.XObject) || {})[nameOf(args[0])];
        const xe = doc.entry(xo);
        const st = nameOf(xe && xe.value && R(xe.value.Subtype));
        if (st === 'Image') counters.images++;
        else if (st === 'Form') {
          counters.forms++;
          if (ctx.depth >= 6) { unsupported.push({ code: 'pdf-form-too-deep', detail: 'nested forms' }); break; }
          counters.streamRefs.add(xe.num);
          const fm = R(xe.value.Matrix) || ID;
          const ftext = latin1(await doc.streamBytes(xe));
          await runContent(doc, ftext, xe.value.Resources || res, mul(fm.map(Number), gs.ctm), { depth: ctx.depth + 1, inForm: nameOf(args[0]) }, shows, counters, unsupported);
        }
        break;
      }
      case 'BI': counters.inlineImages++; break;
      case 'sh': counters.shadings++; break;
      case 'W': case 'W*': pendingClip = true; break;
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n':
        if (op !== 'n') counters.paths++;
        if (pendingClip) { gs.clip = true; pendingClip = false; }
        break;
      default: break;
    }
    void inText;
  }
}

// Unscaled object-space x offsets of a show's glyphs relative to its first glyph,
// comparable with PDFium's text-object char positions (the object matrix holds Tz).
export function showXs(show) {
  const x0 = show.glyphs.length ? show.glyphs[0].xText : 0;
  return show.glyphs.map((g) => g.xText - x0);
}

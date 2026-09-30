// NoblePDF True Edit Phase 8 V2 lab: pure verification helpers.
// Shared by phase8-v2.js (browser) and the Node unit tests in the V2 package.
// No DOM access, no network access and no PDFium calls live in this module.
// Scope: small single-revision test PDFs written by PDFium 2.15.1 or by hand.
// It is evidence tooling for one lab fixture, not a general PDF validator.

export const VERIFY_VERSION = 'phase8-verify-v2.1';

const WS = ' \t\r\n\f\0';
const DELIMS = '()<>[]{}/%';
const isWs = (c) => WS.includes(c);

// ---------------------------------------------------------------- bytes / hashing

export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(data) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export async function sha384Base64(data) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-384', data));
  let bin = '';
  for (let i = 0; i < digest.length; i++) bin += String.fromCharCode(digest[i]);
  return btoa(bin);
}

// Byte-exact latin1 view (one UTF-16 unit per byte, offsets preserved).
export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + 8192, bytes.length))));
  }
  return s;
}

export function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7e) throw new Error('asciiBytes: non-ASCII input');
    out[i] = c;
  }
  return out;
}

export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

export function startsWithBytes(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

// ---------------------------------------------------------------- PDF object scan

function readIntAt(s, pos) {
  const m = /^[0-9]+/.exec(s.slice(pos, pos + 20));
  return m ? Number(m[0]) : null;
}

// Sequential object scan. Stream data ranges are located via /Length (direct or
// indirect) so that binary stream bytes are never parsed as PDF syntax.
export function scanPdf(bytes) {
  const s = latin1(bytes);
  const objects = [];
  const objRe = /(\d+)[ \t\r\n\f\0]+(\d+)[ \t\r\n\f\0]+obj(?![A-Za-z0-9])/g;
  let pos = 0;
  while (pos < s.length) {
    objRe.lastIndex = pos;
    const m = objRe.exec(s);
    if (!m) break;
    const obj = { num: Number(m[1]), gen: Number(m[2]), offset: m.index, bodyStart: m.index + m[0].length };
    const endobj = s.indexOf('endobj', obj.bodyStart);
    let streamKw = -1;
    for (let k = s.indexOf('stream', obj.bodyStart); k !== -1; k = s.indexOf('stream', k + 1)) {
      if (endobj !== -1 && k > endobj) break;
      if (s.slice(k - 3, k) === 'end') continue;
      streamKw = k;
      break;
    }
    if (streamKw === -1) {
      obj.dict = s.slice(obj.bodyStart, endobj === -1 ? s.length : endobj);
      obj.end = endobj === -1 ? s.length : endobj + 6;
      objects.push(obj);
      pos = obj.end;
      continue;
    }
    obj.dict = s.slice(obj.bodyStart, streamKw);
    let dataStart = streamKw + 6;
    if (s[dataStart] === '\r' && s[dataStart + 1] === '\n') dataStart += 2;
    else if (s[dataStart] === '\n' || s[dataStart] === '\r') dataStart += 1;
    obj.stream = { dataStart, dataEnd: -1, declaredLength: null, lengthRef: null, lengthOk: false };
    const direct = /\/Length[ \t\r\n\f\0]+(\d+)(?:[ \t\r\n\f\0]+(\d+)[ \t\r\n\f\0]+R)?/.exec(obj.dict);
    if (direct && direct[2] === undefined) obj.stream.declaredLength = Number(direct[1]);
    if (direct && direct[2] !== undefined) obj.stream.lengthRef = [Number(direct[1]), Number(direct[2])];
    if (obj.stream.declaredLength !== null) {
      const end = dataStart + obj.stream.declaredLength;
      const tail = s.slice(end, end + 12);
      if (/^[\r\n]{0,2}endstream/.test(tail)) {
        obj.stream.dataEnd = end;
        obj.stream.lengthOk = true;
      }
    }
    if (obj.stream.dataEnd === -1) {
      const es = s.indexOf('endstream', dataStart);
      let end = es === -1 ? s.length : es;
      if (s[end - 1] === '\n') end--;
      if (s[end - 1] === '\r') end--;
      obj.stream.dataEnd = Math.max(dataStart, end);
    }
    const afterStream = s.indexOf('endstream', obj.stream.dataEnd);
    const eo = s.indexOf('endobj', afterStream === -1 ? obj.stream.dataEnd : afterStream);
    obj.end = eo === -1 ? s.length : eo + 6;
    objects.push(obj);
    pos = obj.end;
  }
  // Resolve indirect /Length values now that all objects are known.
  for (const obj of objects) {
    if (!obj.stream || !obj.stream.lengthRef) continue;
    const target = objects.find((o) => o.num === obj.stream.lengthRef[0] && o.gen === obj.stream.lengthRef[1] && !o.stream);
    const val = target ? Number(String(target.dict).trim()) : NaN;
    if (Number.isFinite(val)) {
      obj.stream.declaredLength = val;
      obj.stream.lengthOk = obj.stream.dataEnd - obj.stream.dataStart === val;
    }
  }
  // Masked copy: stream data replaced by spaces so keyword scans ignore binary data.
  let masked = s;
  if (objects.some((o) => o.stream)) {
    const parts = [];
    let last = 0;
    for (const o of objects) {
      if (!o.stream) continue;
      parts.push(s.slice(last, o.stream.dataStart), ' '.repeat(o.stream.dataEnd - o.stream.dataStart));
      last = o.stream.dataEnd;
    }
    parts.push(s.slice(last));
    masked = parts.join('');
  }
  return { text: s, masked, objects };
}

// ---------------------------------------------------------------- save structure

export function analyzeStructure(bytes, originalBytes) {
  const scan = scanPdf(bytes);
  const m = scan.masked;
  const eofCount = countOccurrences(m, '%%EOF');
  const lastEof = m.lastIndexOf('%%EOF');
  const eofAtEnd = lastEof >= 0 && /^[\r\n \t\0]*$/.test(m.slice(lastEof + 5));
  const startxrefCount = (m.match(/startxref(?![A-Za-z])/g) || []).length;
  const prevCount = (m.match(/\/Prev(?![A-Za-z0-9])/g) || []).length;
  const xrefStmCount = (m.match(/\/XRefStm(?![A-Za-z0-9])/g) || []).length;
  const objStmCount = (m.match(/\/Type[ \t\r\n\f\0]*\/ObjStm(?![A-Za-z0-9])/g) || []).length;
  let startxref = null;
  for (const sx of m.matchAll(/startxref[ \t\r\n\f\0]+(\d+)/g)) startxref = Number(sx[1]);

  const xref = { classic: false, xrefStream: false, entries: 0, inUse: 0, free: 0, invalid: [], subsections: [], trailer: '' };
  if (startxref !== null && startxref < m.length) {
    if (m.startsWith('xref', startxref)) {
      xref.classic = true;
      let p = startxref + 4;
      const skipWs = () => { while (p < m.length && isWs(m[p])) p++; };
      const entryRe = /(\d{10}) (\d{5}) ([nf])[ \r\n]{1,2}/y;
      for (;;) {
        skipWs();
        if (m.startsWith('trailer', p)) break;
        const head = /^(\d+)[ ]+(\d+)[ \t]*(\r\n|\r|\n)/.exec(m.slice(p, p + 40));
        if (!head) { xref.invalid.push({ reason: 'bad subsection header', at: p }); break; }
        const first = Number(head[1]);
        const cnt = Number(head[2]);
        xref.subsections.push([first, cnt]);
        p += head[0].length;
        for (let k = 0; k < cnt; k++) {
          entryRe.lastIndex = p;
          const e = entryRe.exec(m);
          if (!e) { xref.invalid.push({ reason: 'bad entry', num: first + k, at: p }); p = m.length; break; }
          p = entryRe.lastIndex;
          xref.entries++;
          const num = first + k;
          if (e[3] === 'f') { xref.free++; continue; }
          xref.inUse++;
          const off = Number(e[1]);
          const gen = Number(e[2]);
          const at = /^(\d+)[ \t\r\n\f\0]+(\d+)[ \t\r\n\f\0]+obj(?![A-Za-z0-9])/.exec(m.slice(off, off + 40));
          if (!at || Number(at[1]) !== num || Number(at[2]) !== gen) xref.invalid.push({ reason: 'offset does not point at object', num, gen, off });
        }
        if (p >= m.length) break;
      }
      const tStart = m.indexOf('trailer', p);
      const tEnd = m.indexOf('startxref', tStart === -1 ? p : tStart);
      xref.trailer = tStart === -1 ? '' : m.slice(tStart, tEnd === -1 ? m.length : tEnd).trim();
    } else if (/^\d+[ \t\r\n\f\0]+\d+[ \t\r\n\f\0]+obj/.test(m.slice(startxref, startxref + 40))) {
      xref.xrefStream = /\/Type[ \t\r\n\f\0]*\/XRef(?![A-Za-z0-9])/.test(m.slice(startxref, startxref + 400));
    } else {
      xref.invalid.push({ reason: 'startxref does not point at xref or object', at: startxref });
    }
  } else {
    xref.invalid.push({ reason: 'missing startxref' });
  }

  const seen = new Map();
  for (const o of scan.objects) seen.set(o.num, (seen.get(o.num) || 0) + 1);
  const duplicateObjects = [...seen.entries()].filter(([, n]) => n > 1).map(([num]) => num);
  const badLengths = scan.objects.filter((o) => o.stream && !o.stream.lengthOk).map((o) => o.num);

  const original = originalBytes || new Uint8Array(0);
  const startsWithOriginal = original.length > 0 && startsWithBytes(bytes, original);
  const identicalToOriginal = startsWithOriginal && bytes.length === original.length;
  let samePrefix64 = original.length > 0;
  const n64 = Math.min(64, original.length, bytes.length);
  for (let i = 0; i < n64; i++) if (bytes[i] !== original[i]) { samePrefix64 = false; break; }

  const singleRevision = eofCount === 1 && eofAtEnd && startxrefCount === 1 && prevCount === 0
    && xrefStmCount === 0 && objStmCount === 0 && !startsWithOriginal && xref.classic && !xref.xrefStream
    && xref.invalid.length === 0 && duplicateObjects.length === 0 && badLengths.length === 0;

  return {
    bytes: bytes.length, eofCount, eofAtEnd, startxrefCount, prevCount, xrefStmCount, objStmCount, startxref,
    xref, objectCount: scan.objects.length, streamCount: scan.objects.filter((o) => o.stream).length,
    duplicateObjects, badLengths, startsWithOriginal, identicalToOriginal, samePrefix64, singleRevision, scan,
  };
}

// ---------------------------------------------------------------- stream decoding

export async function inflateZlib(u8) {
  const ds = new DecompressionStream('deflate');
  const out = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

function filtersOf(dict) {
  const arr = /\/Filter[ \t\r\n\f\0]*\[([^\]]*)\]/.exec(dict);
  if (arr) return (arr[1].match(/\/[A-Za-z0-9]+/g) || []).map((x) => x.slice(1));
  const one = /\/Filter[ \t\r\n\f\0]*\/([A-Za-z0-9]+)/.exec(dict);
  return one ? [one[1]] : [];
}

// Decodes every physically present stream (referenced or not). Anything that
// cannot be decoded is reported so callers can fail closed.
export async function decodeAllStreams(bytes, scan = scanPdf(bytes)) {
  const out = [];
  for (const o of scan.objects) {
    if (!o.stream) continue;
    const raw = bytes.subarray(o.stream.dataStart, o.stream.dataEnd);
    const filters = filtersOf(o.dict);
    const isImage = /\/Subtype[ \t\r\n\f\0]*\/Image(?![A-Za-z0-9])/.test(o.dict);
    const predictor = /\/Predictor[ \t\r\n\f\0]+([0-9]+)/.exec(o.dict);
    let data = raw;
    let error = null;
    try {
      for (const f of filters) {
        if (f === 'FlateDecode' || f === 'Fl') {
          if (predictor && Number(predictor[1]) > 1) throw new Error('predictor not supported');
          data = await inflateZlib(data);
        } else {
          throw new Error(`filter ${f} not supported`);
        }
      }
    } catch (e) {
      error = String(e && e.message ? e.message : e);
      data = null;
    }
    out.push({ num: o.num, gen: o.gen, filters, isImage, decoded: data, error });
  }
  return out;
}

// ---------------------------------------------------------------- content stream scan

function hexToLatin1(hex) {
  const h = hex.replace(/[^0-9A-Fa-f]/g, '');
  const even = h.length % 2 ? h + '0' : h;
  let s = '';
  for (let i = 0; i < even.length; i += 2) s += String.fromCharCode(parseInt(even.slice(i, i + 2), 16));
  return s;
}

function readLiteral(s, i) {
  // s[i] === '('
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
      if (/[0-7]/.test(n)) {
        let oct = n; k += 2;
        while (oct.length < 3 && /[0-7]/.test(s[k])) { oct += s[k]; k++; }
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
  return { value: out, next: k };
}

// Minimal content-stream interpreter for text-showing evidence.
// Reports the text shown inside each BT/ET block (strings concatenated per block),
// the text render modes in force when text was shown, XObject painting (Do) and
// inline images (BI/ID/EI).
export function scanContent(input) {
  const s = typeof input === 'string' ? input : latin1(input);
  const blocks = [];
  const stack = [];
  const trStack = [];
  let tr = 0;
  let cur = null;
  let doCount = 0;
  let inlineImages = 0;
  let showsOutsideBT = 0;
  let i = 0;
  const lastStr = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].t === 'str') return stack[k].v;
    return null;
  };
  const show = (text) => {
    if (!cur) { showsOutsideBT++; return; }
    cur.text += text;
    cur.shows++;
    if (!cur.trModes.includes(tr)) cur.trModes.push(tr);
  };
  while (i < s.length) {
    const c = s[i];
    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '(') { const r = readLiteral(s, i); stack.push({ t: 'str', v: r.value }); i = r.next; continue; }
    if (c === '<') {
      if (s[i + 1] === '<') {
        let depth = 0;
        let k = i;
        while (k < s.length) {
          if (s[k] === '<' && s[k + 1] === '<') { depth++; k += 2; continue; }
          if (s[k] === '>' && s[k + 1] === '>') { depth--; k += 2; if (depth === 0) break; continue; }
          k++;
        }
        stack.push({ t: 'dict' });
        i = k;
        continue;
      }
      const end = s.indexOf('>', i);
      stack.push({ t: 'str', v: hexToLatin1(s.slice(i + 1, end === -1 ? s.length : end)) });
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (c === '>') { i++; continue; }
    if (c === '[') { stack.push({ t: '[' }); i++; continue; }
    if (c === ']') {
      const items = [];
      while (stack.length && stack[stack.length - 1].t !== '[') items.unshift(stack.pop());
      stack.pop();
      stack.push({ t: 'arr', v: items });
      i++;
      continue;
    }
    if (c === '{' || c === '}') { i++; continue; }
    if (c === '/') {
      let k = i + 1;
      while (k < s.length && !isWs(s[k]) && !DELIMS.includes(s[k])) k++;
      stack.push({ t: 'name', v: s.slice(i + 1, k) });
      i = k;
      continue;
    }
    let k = i;
    while (k < s.length && !isWs(s[k]) && !DELIMS.includes(s[k])) k++;
    const tok = s.slice(i, k);
    i = k;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { stack.push({ t: 'num', v: Number(tok) }); continue; }
    switch (tok) {
      case 'BT': cur = { text: '', shows: 0, trModes: [] }; blocks.push(cur); break;
      case 'ET': cur = null; break;
      case 'q': trStack.push(tr); break;
      case 'Q': if (trStack.length) tr = trStack.pop(); break;
      case 'Tr': { const n = stack.length ? stack[stack.length - 1] : null; if (n && n.t === 'num') tr = n.v; break; }
      case 'Tj': case "'": case '"': { const v = lastStr(); if (v !== null) show(v); break; }
      case 'TJ': {
        const a = stack.length ? stack[stack.length - 1] : null;
        if (a && a.t === 'arr') show(a.v.filter((x) => x.t === 'str').map((x) => x.v).join(''));
        break;
      }
      case 'Do': doCount++; break;
      case 'BI': {
        inlineImages++;
        const idAt = s.indexOf('ID', i);
        const eiRe = /[ \t\r\n\f\0]EI(?=[ \t\r\n\f\0]|$)/g;
        eiRe.lastIndex = idAt === -1 ? s.length : idAt + 2;
        const ei = eiRe.exec(s);
        i = ei ? ei.index + 3 : s.length;
        break;
      }
      default: break;
    }
    stack.length = 0;
  }
  const invisibleShows = blocks.filter((b) => b.shows > 0 && b.trModes.some((m) => m === 3 || m === 7)).length;
  return { blocks, doCount, inlineImages, showsOutsideBT, invisibleShows };
}

// Hex encodings of an ASCII needle as they could appear in a hex string operand.
function hexForms(needle) {
  const up = Array.from(needle, (ch) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  return [up, up.toLowerCase()];
}

// Evidence that a needle (for example the old text) is gone from every stream and
// from the file body. Streams that cannot be decoded are reported as a failure.
export function streamTextEvidence(fileScan, decodedStreams, needle) {
  const hits = [];
  if (fileScan.masked.includes(needle)) hits.push('file body (outside streams) contains the literal text');
  let undecodable = 0;
  let images = 0;
  let doCount = 0;
  let inlineImages = 0;
  let invisibleShows = 0;
  let showsOutsideBT = 0;
  const blocks = [];
  for (const st of decodedStreams) {
    if (st.isImage) { images++; continue; }
    if (!st.decoded) { undecodable++; hits.push(`object ${st.num} could not be decoded (${st.error})`); continue; }
    const text = latin1(st.decoded);
    if (text.includes(needle)) hits.push(`object ${st.num} contains the literal text`);
    for (const h of hexForms(needle)) if (text.replace(/[ \t\r\n\f\0]/g, '').includes(h)) hits.push(`object ${st.num} contains the hex-encoded text`);
    const sc = scanContent(text);
    doCount += sc.doCount;
    inlineImages += sc.inlineImages;
    invisibleShows += sc.invisibleShows;
    showsOutsideBT += sc.showsOutsideBT;
    const joined = sc.blocks.map((b) => b.text).join('');
    if (joined.includes(needle)) hits.push(`object ${st.num} shows the text across its text operators`);
    for (const b of sc.blocks) blocks.push({ obj: st.num, text: b.text, trModes: b.trModes });
  }
  return { hits: [...new Set(hits)], undecodable, images, doCount, inlineImages, invisibleShows, showsOutsideBT, blocks };
}

// ---------------------------------------------------------------- PDF.js helpers

// Rebuilds logical lines from PDF.js 3.x getTextContent() items: item strings are
// concatenated without separators and a line ends at an item with hasEOL.
export function pdfjsLines(items) {
  const lines = [];
  let cur = '';
  for (const it of items) {
    cur += it && typeof it.str === 'string' ? it.str : '';
    if (it && it.hasEOL) { lines.push(cur); cur = ''; }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function sameStringArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------------------------------------------------------------- pixels

// Compares two RGBA images. d = max per-channel RGB difference of a pixel.
// overTolerance counts pixels with d > tolerance; anyDifference counts d > 0.
export function comparePixels(a, b, { tolerance = 8, excludeRows = null } = {}) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) {
    return { comparable: false, compared: 0, overTolerance: -1, anyDifference: -1, maxDelta: 255, tolerance };
  }
  let overTolerance = 0;
  let anyDifference = 0;
  let maxDelta = 0;
  let compared = 0;
  const w = a.width;
  for (let y = 0; y < a.height; y++) {
    if (excludeRows && y >= excludeRows[0] && y < excludeRows[1]) continue;
    const rowStart = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowStart + x * 4;
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      compared++;
      if (d > 0) anyDifference++;
      if (d > tolerance) overTolerance++;
      if (d > maxDelta) maxDelta = d;
    }
  }
  return { comparable: true, compared, overTolerance, anyDifference, maxDelta, tolerance };
}

// ---------------------------------------------------------------- geometry

// Glyph origins (object space, glyph 0 at x = 0) for a single-byte-font TJ run,
// following ISO 32000 text-space semantics with Tz = 100:
// x[i+1] = x[i] + w[i] * size / 1000 + Tc + (code 32 ? Tw : 0) - adj[i] * size / 1000
// This is an independent hand calculation; it does not call PDFium.
export function tjGlyphOrigins(codes, adjustAfter, widths1000, size, { tc = 0, tw = 0 } = {}) {
  const xs = [0];
  for (let i = 0; i + 1 < codes.length; i++) {
    const w = widths1000[codes[i]];
    if (!Number.isFinite(w)) throw new Error(`tjGlyphOrigins: no width for code ${codes[i]}`);
    const adj = adjustAfter[i] || 0;
    xs.push(xs[i] + (w * size) / 1000 + tc + (codes[i] === 32 ? tw : 0) - (adj * size) / 1000);
  }
  return xs;
}

export function maxAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

export function maxPointDistance(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return m;
}

// ---------------------------------------------------------------- gates

export function summarizeGates(gates) {
  const gated = gates.filter((g) => g.gated !== false);
  const failed = gated.filter((g) => g.pass !== true).map((g) => g.id);
  return { pass: gated.length > 0 && failed.length === 0, failed, gatedCount: gated.length };
}

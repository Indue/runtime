// Raw-byte scan of every content stream in a saved PDF: collects the glyph
// code sequence of each text-showing operation (Tj, TJ, ', ") so we can prove
// the old text's code sequence no longer exists anywhere in the file.
import { PDFDocument, PDFRawStream, PDFName, decodePDFRawStream } from 'pdf-lib';

export async function showSequences(bytes, codeBytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const seqs = [];
  const raw = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    const type = dict.lookup(PDFName.of('Type'));
    const subtype = dict.lookup(PDFName.of('Subtype'));
    if (type || subtype) continue; // fonts, images, XObjects etc.
    if (dict.lookup(PDFName.of('Length1'))) continue; // FontFile2
    let data;
    try {
      data = decodePDFRawStream(obj).decode();
    } catch {
      continue;
    }
    const text = Buffer.from(data).toString('latin1');
    raw.push(text);
    for (const op of scanShowOps(text)) seqs.push(toCodes(op, codeBytes));
  }
  return { seqs, raw };
}

function toCodes(strings, codeBytes) {
  const bytes = strings.flatMap((s) => s);
  const codes = [];
  for (let i = 0; i + codeBytes - 1 < bytes.length; i += codeBytes) {
    let c = 0;
    for (let j = 0; j < codeBytes; j++) c = (c << 8) | bytes[i + j];
    codes.push(c);
  }
  return codes;
}

// Returns, per show operation, the list of string byte arrays in order.
function scanShowOps(src) {
  const ops = [];
  let pending = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i);
      const hex = src.slice(i + 1, end).replace(/\s+/g, '');
      const b = [];
      for (let k = 0; k < hex.length; k += 2) b.push(parseInt((hex[k] + (hex[k + 1] ?? '0')), 16));
      pending.push(b);
      i = end + 1;
    } else if (ch === '(') {
      let depth = 1;
      const b = [];
      i++;
      while (i < src.length && depth) {
        let c = src[i];
        if (c === '\\') {
          const n = src[i + 1];
          const map = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (n in map) b.push(map[n]);
          else if (/[0-7]/.test(n)) {
            const m = src.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
            b.push(parseInt(m, 8));
            i += m.length - 1;
          } else b.push(n.charCodeAt(0));
          i += 2;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (depth) b.push(c.charCodeAt(0));
        i++;
      }
      pending.push(b);
    } else if (/[A-Za-z'"]/.test(ch)) {
      const m = src.slice(i).match(/^[A-Za-z'"*]+/)[0];
      if (m === 'Tj' || m === 'TJ' || m === "'" || m === '"') {
        ops.push(pending);
      }
      pending = [];
      i += m.length;
    } else {
      i++;
    }
  }
  return ops;
}

export function containsSequence(seqs, needle) {
  return seqs.some((s) => {
    outer: for (let i = 0; i + needle.length <= s.length; i++) {
      for (let j = 0; j < needle.length; j++) if (s[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  });
}

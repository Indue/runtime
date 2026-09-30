// NoblePDF True Edit (Phase 10 lab): real-document corpus analysis. Browser and Node.
// Everything here reuses the audited Phase 9 modules unchanged: analyze(), documentGates(),
// targetGates(), planEdit(), applyEdit() and verifyEdit() decide what is editable and whether
// an edit is accepted. This module only walks whole documents, collects inventory facts
// (fonts, text state, structure) for engineering reports, and adds verification checks on
// top of Phase 9's (never instead of them). It never uploads anything and has no DOM or
// network access. Object text is kept in memory for the on-screen inspector only; the
// export builder leaves it out unless explicitly asked. ASCII only.
import { analyze, documentGates, targetGates, planEdit, applyEdit, verifyEdit, POS_TOL_PT } from './te-pipeline.mjs?v=1';
import { OBJ } from './te-engine.mjs?v=1';
import { toCodePoints, fromCodePoints, gapBounds } from './te-edit.mjs?v=1';
import { PdfDoc, PdfRef, PdfName, nameOf, showXs, VALIDATED_FONT_CLASSES } from './te-pdf.mjs?v=1';
import { sha256Hex, analyzeStructure, latin1 } from './phase8-verify.mjs?v=1';

export const TE_CORPUS_VERSION = 'te-corpus-1';
export const REPORT_SCHEMA = 'noblepdf-phase10-corpus-report/1';
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const STATUS = Object.freeze({ SUPPORTED: 'supported', BLOCKED: 'blocked', UNKNOWN: 'unknown' });
// PDFium FPDF_GetLastError values (fpdfview.h).
const PDFIUM_ERRORS = { 1: 'unknown error', 2: 'file not found or could not be opened', 3: 'file not in PDF format or corrupted', 4: 'password required or incorrect password', 5: 'unsupported security scheme', 6: 'page not found or content error' };
const ANNOT_SUBTYPES = ['Unknown', 'Text', 'Link', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound', 'Movie', 'Widget', 'Screen', 'PrinterMark', 'TrapNet', 'Watermark', '3D', 'RichMedia', 'XFAWidget', 'Redact'];
const intake = (code, detail) => ({ stage: 'intake', code, detail });
const msg = (e) => String(e && e.message ? e.message : e);
const bump = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };
const round = (v, d = 3) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);

// ------------------------------------------------------------------ engine helpers (read only)
function has(E, name) { return typeof E.p[name] === 'function'; }
function int32Out(E, fn) {
  const ptr = E.malloc(4);
  try { E.dv().setInt32(ptr, 0, true); if (!fn(ptr)) return null; return E.dv().getInt32(ptr, true); } finally { E.free(ptr); }
}
function floatsOut(E, n, fn) {
  const ptr = E.malloc(4 * n);
  try { if (!fn(ptr)) return null; const d = E.dv(); return [...Array(n).keys()].map((i) => d.getFloat32(ptr + 4 * i, true)); } finally { E.free(ptr); }
}
// FPDF_GetMetaText: returns the byte length (UTF-16LE with terminator) for any buffer size.
function metaText(E, doc, tag) {
  const n = E.p.FPDF_GetMetaText(doc, tag, 0, 0) >>> 0;
  if (n <= 2 || n > 1 << 16) return n <= 2 ? '' : null;
  const buf = E.malloc(n);
  try {
    E.p.FPDF_GetMetaText(doc, tag, buf, n);
    const d = E.dv();
    let s = '';
    for (let i = 0; i + 1 < n; i += 2) { const u = d.getUint16(buf + i, true); if (!u) break; s += String.fromCharCode(u); }
    return s;
  } finally { E.free(buf); }
}
function asciiOut(E, fn) {
  const n = fn(0, 0) >>> 0;
  if (!n || n > 4096) return '';
  const buf = E.malloc(n);
  try { fn(buf, n); let s = ''; for (let i = 0; i < n; i++) { const b = E.heap[buf + i]; if (!b) break; s += String.fromCharCode(b); } return s; } finally { E.free(buf); }
}

// Document facts from PDFium. Throws (with the PDFium error code) when the document does not open.
export function engineDocFacts(E, bytes) {
  return E.withDoc(bytes, null, (o) => {
    const p = E.p;
    const f = {
      pageCount: p.FPDF_GetPageCount(o.doc), permissions: p.FPDF_GetDocPermissions(o.doc) >>> 0, securityRevision: p.FPDF_GetSecurityHandlerRevision(o.doc),
      signatures: p.FPDF_GetSignatureCount(o.doc), formType: p.FPDF_GetFormType(o.doc),
      fileVersion: null, trailerEnds: null, validXref: null, tagged: null, xfaPackets: null, meta: { Producer: null, Creator: null }, signatureInfo: [], pageSizes: [],
    };
    if (has(E, 'FPDF_GetFileVersion')) { const v = int32Out(E, (ptr) => p.FPDF_GetFileVersion(o.doc, ptr)); f.fileVersion = v === null ? null : `${Math.floor(v / 10)}.${v % 10}`; }
    if (has(E, 'FPDF_GetTrailerEnds')) f.trailerEnds = p.FPDF_GetTrailerEnds(o.doc, 0, 0) >>> 0;
    if (has(E, 'FPDF_DocumentHasValidCrossReferenceTable')) f.validXref = !!p.FPDF_DocumentHasValidCrossReferenceTable(o.doc);
    if (has(E, 'FPDFCatalog_IsTagged')) f.tagged = !!p.FPDFCatalog_IsTagged(o.doc);
    if (has(E, 'FPDF_GetXFAPacketCount')) f.xfaPackets = p.FPDF_GetXFAPacketCount(o.doc);
    if (has(E, 'FPDF_GetMetaText')) for (const tag of ['Producer', 'Creator']) f.meta[tag] = metaText(E, o.doc, tag);
    if (has(E, 'FPDF_GetSignatureObject')) {
      for (let i = 0; i < f.signatures; i++) {
        const sig = p.FPDF_GetSignatureObject(o.doc, i);
        if (!sig) continue;
        f.signatureInfo.push({
          subFilter: has(E, 'FPDFSignatureObj_GetSubFilter') ? asciiOut(E, (b, n) => p.FPDFSignatureObj_GetSubFilter(sig, b, n)) : null,
          docMdp: has(E, 'FPDFSignatureObj_GetDocMDPPermission') ? p.FPDFSignatureObj_GetDocMDPPermission(sig) : null,
        });
      }
    }
    if (has(E, 'FPDF_GetPageSizeByIndexF')) for (let i = 0; i < f.pageCount; i++) { const s = floatsOut(E, 2, (ptr) => p.FPDF_GetPageSizeByIndexF(o.doc, i, ptr)); f.pageSizes.push(s ? { width: round(s[0], 2), height: round(s[1], 2) } : null); }
    return f;
  });
}

// Per-page facts PDFium exposes but Phase 9's analyze() does not keep (boxes, annotation types).
function enginePageFacts(E, bytes, pageIndex) {
  return E.withDoc(bytes, pageIndex, (o) => {
    const p = E.p;
    const box = (fn) => (has(E, fn) ? floatsOut(E, 4, (ptr) => p[fn](o.page, ptr, ptr + 4, ptr + 8, ptr + 12)) : null);
    const r = { mediaBox: box('FPDFPage_GetMediaBox'), cropBox: box('FPDFPage_GetCropBox'), annotSubtypes: {} };
    const n = p.FPDFPage_GetAnnotCount(o.page);
    if (has(E, 'FPDFPage_GetAnnot') && has(E, 'FPDFAnnot_GetSubtype')) {
      for (let i = 0; i < n; i++) {
        const a = p.FPDFPage_GetAnnot(o.page, i);
        if (!a) continue;
        try { bump(r.annotSubtypes, ANNOT_SUBTYPES[p.FPDFAnnot_GetSubtype(a)] || 'Other'); } finally { if (has(E, 'FPDFPage_CloseAnnot')) p.FPDFPage_CloseAnnot(a); }
      }
    }
    return r;
  });
}

// ------------------------------------------------------------------ independent structure facts
export function pdfHeaderVersion(bytes) {
  const m = /%PDF-(\d+\.\d+)/.exec(latin1(bytes.subarray(0, Math.min(1024, bytes.length))));
  return m ? m[1] : null;
}

export async function structureFacts(bytes) {
  const st = analyzeStructure(bytes, null);
  const head = st.scan.masked.slice(0, 4096);
  const linearized = /\/Linearized[\s/<>\d]/.test(head);
  const trailerText = st.scan.masked.slice(-8192) + (st.xref.trailer || '');
  const r = {
    headerVersion: pdfHeaderVersion(bytes), linearized, eofCount: st.eofCount, startxrefCount: st.startxrefCount, prevCount: st.prevCount,
    xrefStmCount: st.xrefStmCount, objStmCount: st.objStmCount, objectCount: st.objectCount, streamCount: st.streamCount,
    xrefStyle: st.xref.classic ? (st.xrefStmCount ? 'hybrid (classic table + XRefStm)' : 'classic table') : (st.xref.xrefStream ? 'cross-reference stream' : 'unknown (startxref does not point at a cross-reference section)'),
    xrefInvalid: st.xref.invalid.length, encryptInTrailer: /\/Encrypt[\s/<\d]/.test(trailerText),
    // Every revision ends with %%EOF; a linearized file carries one extra for its first-page section.
    incrementalUpdatesEstimate: Math.max(0, st.eofCount - 1 - (linearized ? 1 : 0)),
    catalog: null, independentError: null,
  };
  let pd = null;
  try { pd = await PdfDoc.load(bytes); } catch (e) { r.independentError = msg(e); }
  if (pd) {
    const R = (v) => pd.resolve(v);
    const root = pd.root || {};
    const af = R(root.AcroForm) || null;
    const c = { acroForm: !!af, xfa: !!(af && af.XFA !== undefined), fields: 0, sigFields: 0, signedSigFields: 0, needAppearances: !!(af && R(af.NeedAppearances) === true),
      optionalContent: root.OCProperties !== undefined, markInfoMarked: !!(R(root.MarkInfo) && R(R(root.MarkInfo).Marked) === true), structTree: root.StructTreeRoot !== undefined,
      xmpMetadata: root.Metadata !== undefined, certified: !!(R(root.Perms) && R(root.Perms).DocMDP !== undefined), javascript: !!(R(root.Names) && R(root.Names).JavaScript !== undefined) || /\/JavaScript[\s/<]|\/JS[\s(<]/.test(st.scan.masked),
      lang: typeof R(root.Lang) === 'object' && R(root.Lang) && R(root.Lang).s ? String(R(root.Lang).s).slice(0, 16) : null, warnings: pd.warnings.length };
    const walk = (list, ft, depth) => {
      if (!Array.isArray(list) || depth > 32) return;
      for (const ref of list) {
        const fld = R(ref);
        if (!fld || typeof fld !== 'object') continue;
        const type = nameOf(R(fld.FT)) || ft;
        const kids = R(fld.Kids);
        if (Array.isArray(kids) && kids.some((k) => { const kd = R(k); return kd && (kd.T !== undefined || kd.FT !== undefined); })) { walk(kids, type, depth + 1); continue; }
        c.fields++;
        if (type === 'Sig') { c.sigFields++; if (fld.V !== undefined && R(fld.V) !== null) c.signedSigFields++; }
      }
    };
    if (af) walk(R(af.Fields), null, 0);
    r.catalog = c;
  }
  return r;
}

// Raw font dictionary facts (subset prefix, encoding, descendant, font file kind) for one font model.
function rawFontInfo(pd, model) {
  const R = (v) => pd.resolve(v);
  const num = model.key ? Number(model.key.split(' ')[0]) : null;
  const e = num !== null ? pd.objects.get(num) : null;
  const f = e ? R(e.value) : null;
  const out = { rawName: model.baseFont || '', subtype: model.subtype || null, descendant: null, embedded: !!model.embedded, fontFile: null, encoding: null, toUnicode: !!model.hasToUnicode, symbolic: !!model.symbolic, vertical: !!model.vertical };
  if (!f || typeof f !== 'object') return out;
  out.rawName = nameOf(R(f.BaseFont)) || nameOf(R(f.Name)) || '';
  out.subtype = nameOf(R(f.Subtype));
  let fd = R(f.FontDescriptor) || {};
  if (out.subtype === 'Type0') {
    const desc = R((R(f.DescendantFonts) || [])[0]) || {};
    out.descendant = nameOf(R(desc.Subtype));
    fd = R(desc.FontDescriptor) || {};
  }
  if (fd.FontFile) out.fontFile = 'FontFile (Type1)';
  else if (fd.FontFile2) out.fontFile = 'FontFile2 (TrueType)';
  else if (fd.FontFile3) { const fe = pd.entry(fd.FontFile3); out.fontFile = `FontFile3 (${(fe && fe.value && nameOf(R(fe.value.Subtype))) || '?'})`; }
  out.embedded = !!out.fontFile;
  out.symbolic = !!(Number(R(fd.Flags) || 0) & 4);
  out.toUnicode = f.ToUnicode !== undefined;
  const encRaw = f.Encoding;
  const enc = R(encRaw);
  if (enc instanceof PdfName) out.encoding = enc.name;
  else if (encRaw instanceof PdfRef && pd.entry(encRaw) && pd.entry(encRaw).stream) out.encoding = `embedded CMap stream${nameOf(R(enc && enc.CMapName)) ? ` ${nameOf(R(enc.CMapName))}` : ''}`;
  else if (enc && typeof enc === 'object' && !Array.isArray(enc)) {
    const diffs = R(enc.Differences);
    const names = Array.isArray(diffs) ? diffs.filter((d) => R(d) instanceof PdfName).length : 0;
    out.encoding = `${nameOf(R(enc.BaseEncoding)) || 'implicit base'} + Differences (${names})`;
  } else out.encoding = out.subtype === 'Type3' ? 'Type3 encoding' : 'font built-in';
  out.vertical = out.vertical || (out.subtype === 'Type0' && /-V$/.test(out.encoding || ''));
  return out;
}

export function fontKind(f) {
  if (f.subtype === 'Type0') return `Type0/${f.descendant || '?'}`;
  if (f.subtype === 'Type1' && !f.embedded) return 'Type1 (not embedded)';
  return f.subtype || 'unknown';
}

// ------------------------------------------------------------------ generator families
const GENERATORS = [
  [/Google Docs/i, 'Google Docs'], [/Microsoft.{0,24}Word/i, 'Microsoft Word'], [/Microsoft.{0,24}Excel/i, 'Microsoft Excel'], [/Microsoft.{0,24}PowerPoint/i, 'Microsoft PowerPoint'],
  [/Microsoft.{0,6}Print To PDF/i, 'Microsoft Print to PDF'], [/Edg\//, 'Edge print (Skia)'], [/Chrome|Chromium|HeadlessChrome/i, 'Chrome print (Skia)'], [/Skia\/PDF/i, 'Skia/PDF (Chromium-based)'],
  [/LibreOffice|OpenOffice/i, 'LibreOffice / OpenOffice'], [/Quartz PDFContext|Mac OS X|macOS|Preview/i, 'macOS Quartz / Preview'], [/Canva/i, 'Canva'],
  [/Acrobat|Adobe PDF Library|Distiller|InDesign|Illustrator|Photoshop|Adobe/i, 'Adobe'], [/ABBYY|FineReader/i, 'ABBYY (OCR)'], [/OCRmyPDF|Tesseract/i, 'Tesseract / OCRmyPDF'],
  [/Xero|MYOB|QuickBooks|Intuit|FreshBooks|Zoho|Sage|Wave/i, 'Accounting / invoicing software'], [/Smallpdf|iLovePDF|PDF24|Sejda|Soda PDF|PDFCandy|pdf2go/i, 'Online PDF service'],
  [/iText/i, 'iText'], [/PDFsharp|MigraDoc/i, 'PDFsharp'], [/ReportLab/i, 'ReportLab'], [/wkhtmltopdf|\bQt\b/i, 'wkhtmltopdf / Qt'], [/dompdf/i, 'dompdf'], [/TCPDF/i, 'TCPDF'],
  [/\bFPDF\b|tFPDF/i, 'FPDF'], [/Prince/i, 'Prince'], [/Ghostscript/i, 'Ghostscript'], [/pdfTeX|LuaTeX|XeTeX|dvipdf/i, 'TeX'], [/Aspose/i, 'Aspose'], [/Nitro/i, 'Nitro'],
  [/Foxit/i, 'Foxit'], [/pdf-lib/i, 'pdf-lib'], [/pypdf|PyPDF/i, 'pypdf'], [/pikepdf|qpdf/i, 'qpdf / pikepdf'], [/PDFium/i, 'PDFium'], [/PDFKit/i, 'PDFKit'], [/Cairo/i, 'Cairo'],
];
export function generatorFamily(producer, creator) {
  const both = `${creator || ''} | ${producer || ''}`;
  if (!producer && !creator) return 'Unknown (no Producer/Creator metadata)';
  for (const [re, name] of GENERATORS) if (re.test(both)) return name;
  return 'Other';
}

// ------------------------------------------------------------------ geometry helpers
function matrixFacts(m) {
  if (!m) return { angle: null, skewed: null, scaleX: null, scaleY: null };
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const dot = sx && sy ? (a * c + b * d) / (sx * sy) : 0;
  return { angle: round((Math.atan2(b, a) * 180) / Math.PI, 2), skewed: Math.abs(dot) > 1e-4 || (a * d - b * c) < 0, scaleX: round(sx, 4), scaleY: round(sy, 4) };
}
const sizeBucket = (s) => (!Number.isFinite(s) ? 'unknown' : s < 6 ? '<6' : s < 9 ? '6-9' : s < 12 ? '9-12' : s < 18 ? '12-18' : s < 36 ? '18-36' : '>=36');

// Why an object that passed every gate is currently considered safe (evidence, not a promise).
function supportedEvidence(a, o, plan) {
  const s = o.show;
  const ix = showXs(s);
  const worst = ix.reduce((m, x, k) => Math.max(m, Math.abs(x - o.xs[k])), 0);
  const gb = gapBounds({ run: { size: o.size, tc: s.tc }, font: s.font });
  return [
    `document gates passed: not signed, not encrypted, modification permitted (flags 0x${a.doc.permissions.toString(16)}), no XFA, independent page tree agrees (${a.doc.pageCount} pages)`,
    `page gates passed: /Rotate 0, content stream not shared, content fully interpreted, ${a.mapping.detail}`,
    `mapped to content operation ${s.op} (op #${s.opIndex}${s.inForm ? `, form ${s.inForm}` : ''}); ${o.real.length} PDFium characters, contiguous, none generated`,
    `render mode 0 (fill), no clip path (PDFium and content stream), Ts 0${o.marks.length ? `, marked content ${o.marks.map((m) => `/${m.name}${m.keys.length ? `(${m.keys.join(',')})` : ''}`).join(' ')} (allowed)` : ', no marked content'}`,
    `first glyph at object origin; baseline residual ${o.baselineResidual.toFixed(4)} pt (<= 0.01)`,
    `font ${s.font.baseFont} is a validated class (${s.font.fontClass}); widths from ${s.font.widthSource}`,
    `independent interpreter agrees with PDFium: ${s.glyphs.length} glyph codes, Unicode per glyph, positions within ${worst.toExponential(1)} pt (limit ${POS_TOL_PT}), font size ${o.size}`,
    `planning probe on the object's own text passed: every glyph re-encodes, ${plan.font && plan.font.fontClass !== 'std14-type1' ? 'is present with an outline in the embedded font program, ' : ''}PDFium metrics agree, PDF.js extracts it contiguously at this position, gap policy [${gb.lo.toFixed(3)}, ${gb.hi.toFixed(3)}] em, no collision`,
  ];
}

// ------------------------------------------------------------------ page classification
// Classifies every direct text object of one page with the exact Phase 9 gates:
//   BLOCKED   documentGates() or targetGates() report at least one code, or the planning
//             probe (planEdit() replacing the object's own text with itself) reports codes;
//   SUPPORTED every gate passed and the probe plan is ok;
//   UNKNOWN   the probe could not run (error) or was skipped (quick mode).
// Returns plain records plus the raw analysis (callers drop it when done: it holds the
// parsed document).
export async function classifyPage(E, bytes, pageIndex, { pdfjs = null, probe = true } = {}) {
  const a = await analyze(E, bytes, pageIndex, { pdfjs });
  const gates = documentGates(a);
  const fonts = new Map();
  const fontOf = (model) => {
    if (!model) return null;
    const key = model.key || `inline:${model.subtype}:${model.baseFont}`;
    let f = fonts.get(key);
    if (!f) {
      const raw = a.independent.pdfDoc ? rawFontInfo(a.independent.pdfDoc, model) : { rawName: model.baseFont, subtype: model.subtype, embedded: !!model.embedded, toUnicode: !!model.hasToUnicode, vertical: !!model.vertical };
      f = { key, name: (raw.rawName || model.baseFont || '').replace(/^[A-Z]{6}\+/, ''), subset: /^[A-Z]{6}\+/.test(raw.rawName || ''), ...raw,
        fontClass: model.fontClass || null, validated: !!model.fontClass && VALIDATED_FONT_CLASSES.includes(model.fontClass) && !model.unsupported,
        blockCode: model.unsupported ? model.unsupported.code : (model.fontClass ? null : 'font-class-not-validated'), shows: 0, glyphs: 0, formShows: 0 };
      f.kind = fontKind(f);
      fonts.set(key, f);
    }
    return f;
  };
  for (const x of a.independent.shows || []) {
    const f = fontOf(x.font);
    if (!f) continue;
    f.shows++;
    f.glyphs += x.glyphs.length;
    if (x.inForm) f.formShows++;
  }
  const records = [];
  for (const o of a.objects) {
    if (o.type !== OBJ.TEXT) continue;
    const s = o.show || null;
    const mf = matrixFacts(o.matrix);
    const font = s ? fontOf(s.font) : null;
    const rec = {
      page: pageIndex, objIndex: o.index, status: null, codes: [], reasons: [], why: [],
      text: o.realText, glyphs: toCodePoints(o.realText).length, pdfiumChars: o.all.length, generatedChars: o.all.length - o.real.length,
      fontKey: font ? font.key : null, font, fontId: null, fontName: s && s.font ? s.font.baseFont : null, fontClass: s && s.font ? s.font.fontClass : null, fontEmbeddedPdfium: o.fontEmbedded,
      size: round(o.size, 4), matrix: o.matrix.map((v) => round(v, 5)), angle: mf.angle, skewed: mf.skewed, scaleX: mf.scaleX, scaleY: mf.scaleY,
      bounds: o.bounds ? { left: round(o.bounds.left, 2), bottom: round(o.bounds.bottom, 2), right: round(o.bounds.right, 2), top: round(o.bounds.top, 2) } : null,
      baseline: o.origins.length ? { x: round(o.origins[0].x, 3), y: round(o.origins[0].y, 3) } : null, baselineResidual: round(o.baselineResidual, 5),
      renderMode: o.renderMode, clipPaths: o.clipPaths, marks: o.marks.map((m) => ({ name: m.name, keys: m.keys.slice() })),
      tc: s ? s.tc : null, tw: s ? s.tw : null, tz: s ? round(s.tz, 3) : null, ts: s ? s.ts : null, tr: s ? s.tr : null, op: s ? s.op : null,
      tjAdjustments: s && s.tj ? s.tj.filter((x) => typeof x === 'number').length : 0, clipInStream: s ? !!s.clip : null, mapped: !!s,
    };
    const reasons = [...gates, ...targetGates(a, o.index)];
    if (reasons.length) { rec.status = STATUS.BLOCKED; rec.reasons = reasons; }
    else if (!probe) { rec.status = STATUS.UNKNOWN; rec.reasons = [{ stage: 'phase10', code: 'probe-not-run', detail: 'gates passed; the planning probe was skipped (quick mode)' }]; }
    else {
      try {
        const cps = toCodePoints(o.realText);
        const plan = await planEdit(E, bytes, { pageIndex, objIndex: o.index, start: 0, end: cps.length, replacement: o.realText, fit: false, analysis: a, pdfjs });
        if (plan.ok) { rec.status = STATUS.SUPPORTED; rec.why = supportedEvidence(a, o, plan); } else { rec.status = STATUS.BLOCKED; rec.reasons = plan.reasons.map((r) => ({ ...r, detail: `${r.detail} (planning probe on the object's own text)` })); }
      } catch (e) {
        rec.status = STATUS.UNKNOWN;
        rec.reasons = [{ stage: 'phase10', code: 'probe-error', detail: msg(e) }];
      }
    }
    rec.codes = [...new Set(rec.reasons.map((r) => r.code))];
    records.push(rec);
  }
  return { a, gates, records, fonts };
}

// ------------------------------------------------------------------ whole-document analysis
function newReport(name, bytes, sha256) {
  return {
    schema: REPORT_SCHEMA, version: TE_CORPUS_VERSION, name, size: bytes.length, sha256, status: 'analysed', intake: [], generator: null,
    doc: null, structure: null, pages: [], objects: [], fonts: [], documentReasons: [], formText: { shows: 0, glyphs: 0, pdfiumChars: 0 },
    textState: null, summary: null, seconds: 0,
  };
}
// Report for a file that could not be analysed at all (same shape as a full report).
export function failedReport(name, size, sha256, code, detail) {
  const rep = newReport(name, { length: size }, sha256);
  rep.status = 'failed';
  rep.intake.push(intake(code, detail));
  rep.textState = textStateSummary([]);
  rep.summary = summarize(rep);
  return rep;
}

// Returns a report object. Never throws for document problems: intake failures (not a PDF,
// too large, password, malformed) become a report with status 'failed' and reason codes.
// opts: { pdfjs, maxPages (0 = all), probe (default true), onProgress(done, total), isCancelled() }
export async function analyzeDocument(E, bytes, { name = '', pdfjs = null, maxPages = 0, probe = true, onProgress = null, isCancelled = null } = {}) {
  const t0 = Date.now();
  const rep = newReport(name, bytes, await sha256Hex(bytes));
  const fail = (code, detail) => { rep.status = 'failed'; rep.intake.push(intake(code, detail)); rep.textState = textStateSummary([]); rep.summary = summarize(rep); rep.seconds = round((Date.now() - t0) / 1000, 2); return rep; };
  if (bytes.length > MAX_FILE_BYTES) return fail('file-too-large', `${bytes.length} bytes (lab limit ${MAX_FILE_BYTES})`);
  if (!pdfHeaderVersion(bytes)) return fail('pdf-header-missing', 'no %PDF- header in the first 1024 bytes');
  try { rep.structure = await structureFacts(bytes); } catch (e) { rep.structure = { error: msg(e) }; }
  try { rep.doc = engineDocFacts(E, bytes); } catch (e) {
    const m = /PDFium error (\d+)/.exec(msg(e));
    const code = m ? Number(m[1]) : 0;
    const known = { 3: 'malformed-pdf', 4: 'password-required', 5: 'unsupported-security-handler' };
    return fail(known[code] || 'document-open-failed', `PDFium refused to open the document: ${PDFIUM_ERRORS[code] || msg(e)}`);
  }
  if (rep.doc.pageCount <= 0) return fail('no-pages', 'the document has no pages');
  rep.generator = generatorFamily(rep.doc.meta.Producer, rep.doc.meta.Creator);
  const total = maxPages > 0 ? Math.min(maxPages, rep.doc.pageCount) : rep.doc.pageCount;
  const fonts = new Map();
  const docReasons = new Map();
  for (let pi = 0; pi < rep.doc.pageCount; pi++) {
    if (isCancelled && isCancelled()) { rep.status = 'cancelled'; break; }
    const pg = { index: pi, status: 'analysed', size: rep.doc.pageSizes[pi] || null, rotation: null, rotateIndependent: null, census: null, annots: 0, annotSubtypes: {}, mediaBox: null, cropBox: null,
      independent: null, pageReasons: [], textObjects: 0, supported: 0, blocked: 0, unknown: 0, formTextShows: 0, markedTextObjects: 0, optionalContentShows: 0, actualTextShows: 0, clippedTextObjects: 0, error: null };
    rep.pages.push(pg);
    if (pi >= total) { pg.status = 'not-analysed'; continue; }
    try { Object.assign(pg, enginePageFacts(E, bytes, pi)); } catch (e) { pg.error = `page facts: ${msg(e)}`; }
    let c;
    try { c = await classifyPage(E, bytes, pi, { pdfjs, probe }); } catch (e) { pg.status = 'error'; pg.error = `analysis failed: ${msg(e)}`; if (onProgress) onProgress(pi + 1, total); continue; }
    const a = c.a;
    pg.rotation = a.page.rotation;
    pg.rotateIndependent = a.page.rotateIndependent;
    pg.census = a.page.census;
    pg.annots = a.page.annots;
    const k = a.independent.counters;
    pg.independent = a.independent.error ? { error: a.independent.error } : { images: k.images, inlineImages: k.inlineImages, forms: k.forms, paths: k.paths, shadings: k.shadings, tzOps: k.tzOps, tsOps: k.tsOps, contentStreams: k.streams, shows: a.independent.shows.length, unsupported: a.independent.unsupported.map((u) => u.code) };
    for (const g of c.gates) {
      if (g.stage === 'document') { if (!docReasons.has(g.code)) docReasons.set(g.code, g); } else pg.pageReasons.push(g);
    }
    const shows = a.independent.shows || [];
    const inForm = shows.filter((x) => x.inForm && x.glyphs.length);
    pg.formTextShows = inForm.length;
    rep.formText.shows += inForm.length;
    rep.formText.glyphs += inForm.reduce((n, x) => n + x.glyphs.length, 0);
    rep.formText.pdfiumChars += a.pdfium.chars.filter((ch) => ch.objIndex === -2 && ch.cp).length;
    pg.optionalContentShows = shows.filter((x) => x.marks.some((m) => m.oc)).length;
    pg.actualTextShows = shows.filter((x) => x.marks.some((m) => m.actualText || m.alt || m.expansion)).length;
    for (const [key, f] of c.fonts) {
      let g = fonts.get(key);
      if (!g) { g = { ...f, id: fonts.size, shows: 0, glyphs: 0, formShows: 0, pages: [] }; fonts.set(key, g); }
      g.shows += f.shows;
      g.glyphs += f.glyphs;
      g.formShows += f.formShows;
      g.pages.push(pi);
    }
    for (const rec of c.records) {
      rec.fontId = rec.fontKey && fonts.has(rec.fontKey) ? fonts.get(rec.fontKey).id : null;
      rec.font = null;
      pg.textObjects++;
      pg[rec.status]++;
      if (rec.marks.length) pg.markedTextObjects++;
      if (rec.clipPaths > 0 || rec.clipInStream) pg.clippedTextObjects++;
      rep.objects.push(rec);
    }
    if (onProgress) onProgress(pi + 1, total);
  }
  rep.documentReasons = [...docReasons.values()];
  rep.fonts = [...fonts.values()].sort((x, y) => x.id - y.id);
  rep.textState = textStateSummary(rep.objects);
  rep.summary = summarize(rep);
  rep.seconds = round((Date.now() - t0) / 1000, 2);
  return rep;
}

export function textStateSummary(objects) {
  const t = { sizes: {}, sizeMin: null, sizeMax: null, tcNonZero: 0, twNonZero: 0, tzNot100: 0, tsNonZero: 0, renderModes: {}, ops: {}, tjWithAdjustments: 0, rotated: 0, skewed: 0, nonUniformScale: 0, clipped: 0, marked: 0, unmapped: 0 };
  for (const o of objects) {
    bump(t.sizes, sizeBucket(o.size));
    if (Number.isFinite(o.size)) { t.sizeMin = t.sizeMin === null ? o.size : Math.min(t.sizeMin, o.size); t.sizeMax = t.sizeMax === null ? o.size : Math.max(t.sizeMax, o.size); }
    bump(t.renderModes, String(o.renderMode));
    if (!o.mapped) { t.unmapped++; } else {
      if (o.tc) t.tcNonZero++;
      if (o.tw) t.twNonZero++;
      if (o.tz !== null && Math.abs(o.tz - 100) > 1e-6) t.tzNot100++;
      if (o.ts) t.tsNonZero++;
      bump(t.ops, o.op);
      if (o.tjAdjustments) t.tjWithAdjustments++;
    }
    if (o.angle !== null && Math.abs(o.angle) > 0.01) t.rotated++;
    if (o.skewed) t.skewed++;
    if (o.scaleX !== null && Math.abs(o.scaleX - o.scaleY) > 1e-3) t.nonUniformScale++;
    if (o.clipPaths > 0 || o.clipInStream) t.clipped++;
    if (o.marks.length) t.marked++;
  }
  return t;
}

export function summarize(rep) {
  const s = { pages: rep.doc ? rep.doc.pageCount : 0, pagesAnalysed: rep.pages.filter((p) => p.status === 'analysed').length, pagesWithErrors: rep.pages.filter((p) => p.status === 'error').length,
    pagesNotAnalysed: rep.pages.filter((p) => p.status === 'not-analysed').length, textObjects: rep.objects.length, supported: 0, blocked: 0, unknown: 0,
    formTextShows: rep.formText.shows, formTextChars: rep.formText.pdfiumChars, blockReasons: {}, unsupportedFeatures: [], percentEditableObjects: 0, percentEditableChars: 0, safeEditExists: false, uniqueFonts: rep.fonts.length, fontKinds: {} };
  let chars = 0;
  let okChars = 0;
  for (const o of rep.objects) {
    s[o.status]++;
    chars += o.glyphs;
    if (o.status === STATUS.SUPPORTED) okChars += o.glyphs;
    if (o.status === STATUS.BLOCKED) for (const c of o.codes) bump(s.blockReasons, c);
  }
  chars += rep.formText.pdfiumChars;
  if (rep.formText.shows) bump(s.blockReasons, 'text-in-form-xobject', rep.formText.shows);
  s.percentEditableObjects = rep.objects.length ? round((100 * s.supported) / rep.objects.length, 1) : 0;
  s.percentEditableChars = chars ? round((100 * okChars) / chars, 1) : 0;
  s.safeEditExists = s.supported > 0;
  for (const f of rep.fonts) bump(s.fontKinds, f.kind);
  const feats = new Set();
  for (const r of rep.intake) feats.add(r.code);
  for (const r of rep.documentReasons) feats.add(r.code);
  for (const p of rep.pages) for (const r of p.pageReasons) feats.add(r.code);
  if (rep.formText.shows) feats.add('text-in-form-xobject');
  for (const f of rep.fonts) if (f.blockCode) feats.add(f.blockCode);
  s.unsupportedFeatures = [...feats];
  s.topBlockReasons = Object.entries(s.blockReasons).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return s;
}

// ------------------------------------------------------------------ edit test (exact Phase 9 sequence)
// Old text -> new text as one replacement on code points, widened to whole words. Same
// algorithm as the Phase 9 editor (phase9-editor.js diff(); tests/node/phase10-corpus.test.mjs
// proves the two agree).
const isWs = (cp) => cp === 0x20 || cp === 0x09 || cp === 0xa0;
export function diffText(oldText, newText) {
  const a = toCodePoints(oldText);
  const b = toCodePoints(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const same = a.length === b.length && p === a.length;
  let start = p;
  let end = a.length - s;
  while (start > 0 && !isWs(a[start - 1])) start--;
  while (end < a.length && !isWs(a[end])) end++;
  let repl = b.slice(start, b.length - (a.length - end));
  if ((start === end || !repl.length) && b.length) {
    if (start > 0) start--; else end++;
    repl = b.slice(start, b.length - (a.length - end));
  }
  return { start, end, replacement: fromCodePoints(repl), same };
}

// D01: invariants of the whole document that an edit of one page must not change. Additive
// to Phase 9's V01..V13 (which check the edited page), never a replacement for them.
export function documentInvariantCheck(E, before, after, pageIndex) {
  const facts = (bytes) => E.withDoc(bytes, null, (o) => {
    const p = E.p;
    const n = p.FPDF_GetPageCount(o.doc);
    const pages = [];
    for (let i = 0; i < n; i++) {
      if (i === pageIndex) { pages.push(null); continue; }
      const q = { page: p.FPDF_LoadPage(o.doc, i), textPage: 0 };
      try {
        if (!q.page) { pages.push({ error: 'page failed to load' }); continue; }
        q.textPage = p.FPDFText_LoadPage(q.page);
        pages.push({ text: q.textPage ? E.pageText(q.textPage) : null, census: E.census(q.page), annots: p.FPDFPage_GetAnnotCount(q.page), rotation: p.FPDFPage_GetRotation(q.page) });
      } finally { if (q.textPage) p.FPDFText_ClosePage(q.textPage); if (q.page) p.FPDF_ClosePage(q.page); }
    }
    return { n, signatures: p.FPDF_GetSignatureCount(o.doc), permissions: p.FPDF_GetDocPermissions(o.doc) >>> 0, security: p.FPDF_GetSecurityHandlerRevision(o.doc), formType: p.FPDF_GetFormType(o.doc), pages };
  });
  let f0;
  let f1;
  try { f0 = facts(before); f1 = facts(after); } catch (e) { return { id: 'D01', name: 'document invariants and every other page unchanged (PDFium)', pass: false, evidence: `could not reopen: ${msg(e)}` }; }
  const bad = [];
  for (const k of ['n', 'signatures', 'permissions', 'security', 'formType']) if (f0[k] !== f1[k]) bad.push(`${k} ${f0[k]} -> ${f1[k]}`);
  if (f0.n === f1.n) f0.pages.forEach((p, i) => { if (p && JSON.stringify(p) !== JSON.stringify(f1.pages[i])) bad.push(`page ${i + 1} changed`); });
  const others = Math.max(0, f0.n - 1);
  return { id: 'D01', name: 'document invariants (page count, signatures, permissions, security, form type) and every other page (text, object census, annotations, rotation) unchanged (PDFium)', pass: bad.length === 0, evidence: bad.length ? bad.slice(0, 6).join('; ') : `${others} other page(s) identical; ${f1.n} page(s), ${f1.signatures} signature(s), permissions 0x${f1.permissions.toString(16)}` };
}

// analyse -> classify -> encode + plan -> clone/candidate -> mutate -> GenerateContent ->
// non-incremental save -> destroy/reopen -> independent verification (+ D01 + extra checks).
// `bytes` is never written: applyEdit copies it into the engine heap and returns new bytes.
// Output bytes are returned only when every required check passed.
// opts: { pageIndex, objIndex, expectedOldText, newText, fit, pdfjs, extraChecks(before, out, plan) -> [checks], applyEngine }
// `selection` ({ start, end, replacement } in code points, as te-suite.mjs passes it) replaces
// the editor-style diff of old and new text; the fixture parity tests use it.
export async function runVerifiedEdit(E, bytes, { pageIndex, objIndex, expectedOldText, newText, selection = null, fit = false, pdfjs = null, extraChecks = null, applyEngine = null }) {
  const res = { status: null, stages: [], reasons: [], checks: [], plan: null, bytes: null, inputSha: await sha256Hex(bytes), outputSha: null, oldText: null, newText: null };
  const stage = (name, ok, detail) => res.stages.push({ name, ok, detail: String(detail) });
  const done = (status) => { res.status = status; return res; };
  let a;
  try { a = await analyze(E, bytes, pageIndex, { pdfjs }); stage('analyse', true, `page ${pageIndex + 1}: ${a.mapping.detail}`); } catch (e) { stage('analyse', false, msg(e)); res.reasons = [{ stage: 'analyse', code: 'analysis-failed', detail: msg(e) }]; return done('failed'); }
  const o = a.objects[objIndex];
  if (!o || o.type !== OBJ.TEXT || (expectedOldText !== undefined && o.realText !== expectedOldText)) {
    stage('classify', false, 'the selected object is no longer the same text object');
    res.reasons = [{ stage: 'classify', code: 'stale-object', detail: `object ${objIndex} on page ${pageIndex + 1} no longer holds the selected text` }];
    return done('stale');
  }
  res.oldText = o.realText;
  const gates = [...documentGates(a), ...targetGates(a, objIndex)];
  stage('classify', gates.length === 0, gates.length ? gates.map((g) => g.code).join(', ') : 'document and target gates passed');
  if (gates.length) { res.reasons = gates; return done('blocked'); }
  let sel = selection;
  if (!sel) {
    const d = diffText(o.realText, newText);
    if (d.same) { stage('encode', false, 'nothing changed'); res.reasons = [{ stage: 'input', code: 'no-change', detail: 'the new text equals the current text' }]; return done('unchanged'); }
    sel = { start: d.start, end: d.end, replacement: toCodePoints(newText).length ? d.replacement : '' };
  }
  const plan = await planEdit(E, bytes, { pageIndex, objIndex, start: sel.start, end: sel.end, replacement: sel.replacement, fit, analysis: a, pdfjs });
  res.plan = plan;
  stage('encode + plan', plan.ok, plan.ok ? `${plan.oldCodes.length} -> ${plan.newCodes.length} glyph codes (${plan.font.fontClass}); layout ${plan.discriminating ? 'needs SetPositions' : 'natural'}` : plan.reasons.map((r) => r.code).join(', '));
  if (!plan.ok) { res.reasons = plan.reasons; return done('blocked'); }
  res.newText = plan.newText;
  let out;
  try {
    out = applyEdit(applyEngine || E, bytes, plan);
    stage('clone/candidate + mutate + GenerateContent + non-incremental save', true, `candidate ${out.length} bytes (source copied into the engine; source bytes not written)`);
  } catch (e) {
    stage('clone/candidate + mutate + GenerateContent + non-incremental save', false, msg(e));
    res.reasons = [{ stage: 'mutation', code: 'engine-refused', detail: msg(e) }];
    return done('failed');
  }
  const v = await verifyEdit(E, bytes, out, plan, { pdfjs });
  const checks = [...v.checks];
  checks.push(documentInvariantCheck(E, bytes, out, pageIndex));
  if (extraChecks) {
    try { checks.push(...await extraChecks(bytes, out, plan)); } catch (e) { checks.push({ id: 'X00', name: 'extra verification ran', pass: false, evidence: msg(e) }); }
  }
  res.checks = checks;
  const ok = checks.length > 0 && checks.every((c) => c.pass);
  stage('destroy/reopen + independent verification', ok, `${checks.filter((c) => c.pass).length}/${checks.length} checks passed${ok ? '' : `; failed ${checks.filter((c) => !c.pass).map((c) => c.id).join(', ')}`}`);
  const inputAfter = await sha256Hex(bytes);
  if (inputAfter !== res.inputSha) { res.reasons = [{ stage: 'integrity', code: 'source-bytes-changed', detail: 'the source bytes changed during the edit' }]; return done('failed'); }
  if (!ok) { res.reasons = checks.filter((c) => !c.pass).map((c) => ({ stage: 'verification', code: c.id, detail: c.name })); return done('rejected'); }
  res.bytes = out;
  res.outputSha = await sha256Hex(out);
  return done('committed');
}

// ------------------------------------------------------------------ session state
// Holds every loaded document separately. Canonical bytes: `original` is never written after
// load; `working` changes only through commit() of a verified result, undo() and reset().
// Every change bumps the document revision; loading new files bumps the session generation.
// A selection is valid only for the generation, active document and revision it was made in.
export class CorpusSession {
  constructor() { this.generation = 0; this.docs = []; this.active = null; this.selection = null; this.seq = 0; this.tokens = 0; }
  beginLoad() { this.generation++; this.selection = null; return this.generation; }
  addDocument({ name, bytes, sha256 }) {
    const id = `doc-${++this.seq}`;
    const original = bytes.slice();
    const d = { id, name, size: original.length, sha256, original, originalSha: sha256, working: { bytes: original.slice(), sha: sha256, verified: false }, revision: 0, history: [], edits: [], report: null, loadedInGeneration: this.generation };
    this.docs.push(d);
    return d;
  }
  doc(id) { return this.docs.find((d) => d.id === id) || null; }
  setActive(id) { if (!this.doc(id)) throw new Error(`unknown document ${id}`); this.active = id; this.selection = null; }
  select(docId, pageIndex, objIndex, oldText) {
    const d = this.doc(docId);
    if (!d || this.active !== docId) throw new Error('select: document is not active');
    this.selection = Object.freeze({ token: ++this.tokens, generation: this.generation, docId, revision: d.revision, pageIndex, objIndex, oldText });
    return this.selection;
  }
  clearSelection() { this.selection = null; }
  checkSelection(sel) {
    if (!sel) return { ok: false, code: 'no-selection', detail: 'select a text object first' };
    if (sel.generation !== this.generation) return { ok: false, code: 'stale-generation', detail: 'new PDFs were loaded after this object was selected; select the text again' };
    if (!this.selection || this.selection.token !== sel.token) return { ok: false, code: 'stale-selection', detail: 'this is not the current selection; select the text again' };
    const d = this.doc(sel.docId);
    if (!d) return { ok: false, code: 'document-gone', detail: sel.docId };
    if (this.active !== sel.docId) return { ok: false, code: 'document-not-active', detail: `${sel.docId} is not the active document` };
    if (d.revision !== sel.revision) return { ok: false, code: 'stale-revision', detail: `the document changed after selection (revision ${sel.revision} -> ${d.revision}); select the text again` };
    return { ok: true, doc: d };
  }
  // Replaces the working bytes only with a committed (fully verified) result computed from
  // exactly the current working bytes of the selection's document and revision.
  async commit(sel, result) {
    const c = this.checkSelection(sel);
    if (!c.ok) return c;
    const d = c.doc;
    if (!result || result.status !== 'committed' || !result.bytes) return { ok: false, code: 'not-verified', detail: 'only a fully verified result can replace the working document' };
    if (result.inputSha !== d.working.sha || (await sha256Hex(d.working.bytes)) !== d.working.sha) return { ok: false, code: 'stale-bytes', detail: 'the result was computed from different bytes' };
    if ((await sha256Hex(result.bytes)) !== result.outputSha) return { ok: false, code: 'result-changed', detail: 'the verified bytes changed after verification' };
    d.history.push(d.working);
    d.working = { bytes: result.bytes, sha: result.outputSha, verified: true };
    d.revision++;
    this.selection = null;
    return { ok: true, doc: d };
  }
  undo(docId) { const d = this.doc(docId); if (!d || !d.history.length) return false; d.working = d.history.pop(); d.revision++; this.selection = null; return true; }
  async reset(docId) {
    const d = this.doc(docId);
    if (!d) return false;
    if ((await sha256Hex(d.original)) !== d.originalSha) throw new Error('original bytes changed in memory; refusing to reset');
    d.working = { bytes: d.original.slice(), sha: d.originalSha, verified: false };
    d.history = [];
    d.revision++;
    this.selection = null;
    return true;
  }
  // Download is allowed only for bytes that a fully verified commit produced, re-hashed now.
  async verifiedBytes(docId) {
    const d = this.doc(docId);
    if (!d || !d.working.verified) return null;
    return (await sha256Hex(d.working.bytes)) === d.working.sha ? d.working.bytes : null;
  }
  clear() { this.generation++; this.docs = []; this.active = null; this.selection = null; }
}

// ------------------------------------------------------------------ export
// Masks letters and digits but keeps the shape (case, punctuation, spacing): "Inv 12" -> "Aaa 99".
export function redactSample(text) {
  let out = '';
  for (const ch of String(text)) out += /\p{Lu}/u.test(ch) ? 'A' : /\p{L}/u.test(ch) ? 'a' : /\p{N}/u.test(ch) ? '9' : /\s/u.test(ch) ? ' ' : (/[\p{P}\p{S}]/u.test(ch) && ch.codePointAt(0) < 0x80 ? ch : '*');
  return out;
}
const clip = (t, n) => fromCodePoints(toCodePoints(String(t)).slice(0, n));
const SAMPLE_LEN = 24;

// Builds the exportable diagnostic report. Defaults leave out file names, object text, reason
// details (they can quote document text) and never include PDF bytes.
// options: { includeFileNames = false, samples = 'none' | 'redacted' | 'plain', includeGeneratorStrings = true, environment = null }
export function buildExport(session, { includeFileNames = false, samples = 'none', includeGeneratorStrings = true, environment = null, page = '' } = {}) {
  const docs = session.docs.filter((d) => d.report).map((d, i) => docExport(d, i, { includeFileNames, samples, includeGeneratorStrings }));
  return { schema: REPORT_SCHEMA, module: TE_CORPUS_VERSION, page, created: new Date().toISOString(), privacy: { fileNames: includeFileNames, samples, generatorStrings: includeGeneratorStrings, pdfBytes: false, reasonDetails: samples === 'plain' },
    environment, session: sessionSummary(session), documents: docs };
}

function sampleOf(text, mode) { if (mode === 'plain') return clip(text, SAMPLE_LEN); if (mode === 'redacted') return redactSample(clip(text, SAMPLE_LEN)); return undefined; }

function docExport(d, i, { includeFileNames, samples, includeGeneratorStrings }) {
  const r = d.report;
  const doc = r.doc || {};
  const st = r.structure || {};
  return {
    label: `document-${i + 1}`, fileName: includeFileNames ? d.name : null, sha256: r.sha256, bytes: r.size, status: r.status,
    intake: r.intake.map((x) => ({ code: x.code, detail: x.detail })),
    pdfVersion: { header: st.headerVersion || null, pdfium: doc.fileVersion || null },
    pages: doc.pageCount || 0,
    encrypted: r.doc ? doc.securityRevision >= 0 : (r.intake.some((x) => /password|security/.test(x.code)) ? true : null),
    securityHandlerRevision: r.doc ? doc.securityRevision : null, permissions: r.doc ? `0x${doc.permissions.toString(16)}` : null, modifyAllowed: r.doc ? (doc.permissions & 8) !== 0 : null,
    signatures: r.doc ? { count: doc.signatures, subFilters: doc.signatureInfo.map((s) => s.subFilter), docMdp: doc.signatureInfo.map((s) => s.docMdp), sigFields: st.catalog ? st.catalog.sigFields : null, signedSigFields: st.catalog ? st.catalog.signedSigFields : null, certified: st.catalog ? st.catalog.certified : null } : null,
    revisions: { pdfiumTrailerEnds: doc.trailerEnds ?? null, eofMarkers: st.eofCount ?? null, prevPointers: st.prevCount ?? null, linearized: st.linearized ?? null, incrementalUpdatesEstimate: st.incrementalUpdatesEstimate ?? null },
    xref: { style: st.xrefStyle || null, pdfiumValid: doc.validXref ?? null, objectStreams: st.objStmCount ?? null, objects: st.objectCount ?? null, streams: st.streamCount ?? null },
    catalog: st.catalog ? { acroForm: st.catalog.acroForm, fields: st.catalog.fields, xfa: st.catalog.xfa, xfaPackets: doc.xfaPackets ?? null, optionalContent: st.catalog.optionalContent, tagged: doc.tagged ?? st.catalog.markInfoMarked, structTree: st.catalog.structTree, xmpMetadata: st.catalog.xmpMetadata, javascript: st.catalog.javascript, formType: doc.formType ?? null } : null,
    generator: { family: r.generator || null, producer: includeGeneratorStrings && doc.meta ? clip(doc.meta.Producer || '', 80) : undefined, creator: includeGeneratorStrings && doc.meta ? clip(doc.meta.Creator || '', 80) : undefined },
    documentReasons: r.documentReasons.map((x) => x.code),
    pagesDetail: r.pages.map((p) => ({ index: p.index, status: p.status, size: p.size, rotation: p.rotation, rotateIndependent: p.rotateIndependent, mediaBox: p.mediaBox && p.mediaBox.map((v) => round(v, 2)), cropBox: p.cropBox && p.cropBox.map((v) => round(v, 2)), census: p.census, annots: p.annots, annotSubtypes: p.annotSubtypes,
      independent: p.independent, pageReasons: p.pageReasons.map((x) => x.code), textObjects: p.textObjects, supported: p.supported, blocked: p.blocked, unknown: p.unknown, formTextShows: p.formTextShows,
      markedTextObjects: p.markedTextObjects, optionalContentShows: p.optionalContentShows, actualTextShows: p.actualTextShows, clippedTextObjects: p.clippedTextObjects, error: p.error ? (samples === 'plain' ? p.error : 'error (detail withheld)') : null })),
    fonts: r.fonts.map((f) => ({ id: f.id, name: f.name, subset: f.subset, kind: f.kind, subtype: f.subtype, descendant: f.descendant, embedded: f.embedded, fontFile: f.fontFile, encoding: f.encoding, toUnicode: f.toUnicode, symbolic: f.symbolic, vertical: f.vertical, fontClass: f.fontClass, validated: f.validated, blockCode: f.blockCode, shows: f.shows, glyphs: f.glyphs, formShows: f.formShows, pages: f.pages.length })),
    textState: r.textState,
    objects: r.objects.map((o) => ({ page: o.page, objIndex: o.objIndex, status: o.status, codes: o.codes, stages: [...new Set(o.reasons.map((x) => x.stage))], fontId: o.fontId, fontClass: o.fontClass, size: o.size, glyphs: o.glyphs, generatedChars: o.generatedChars,
      tc: o.tc, tw: o.tw, tz: o.tz, ts: o.ts, renderMode: o.renderMode, op: o.op, tjAdjustments: o.tjAdjustments, angle: o.angle, skewed: o.skewed, clipped: o.clipPaths > 0 || !!o.clipInStream, marks: o.marks.map((m) => m.name),
      sample: sampleOf(o.text, samples), details: samples === 'plain' ? o.reasons.map((x) => `${x.code}: ${clip(x.detail, 120)}`) : undefined })),
    formText: r.formText, summary: r.summary, seconds: r.seconds,
    editTests: d.edits.map((e) => ({ page: e.page, objIndex: e.objIndex, status: e.status, codes: e.codes, failedChecks: e.failedChecks, checks: e.checks, discriminating: e.discriminating, naturalDelta: e.naturalDelta, fontClass: e.fontClass,
      oldSample: sampleOf(e.oldText || '', samples), newSample: sampleOf(e.newText || '', samples) })),
  };
}

export function sessionSummary(session) {
  const s = { documents: 0, failedIntake: 0, pages: 0, textObjects: 0, supported: 0, blocked: 0, unknown: 0, formTextShows: 0, documentsWithSafeEdit: 0, editTests: 0, committedEdits: 0, verifierRejections: 0, blockedEdits: 0, failedEdits: 0,
    blockReasons: {}, fontKinds: {}, generators: {}, intakeFailures: {} };
  for (const d of session.docs) {
    const r = d.report;
    if (!r) continue;
    if (r.status === 'failed') { s.failedIntake++; for (const x of r.intake) bump(s.intakeFailures, x.code); continue; }
    s.documents++;
    s.pages += r.summary.pages;
    s.textObjects += r.summary.textObjects;
    s.supported += r.summary.supported;
    s.blocked += r.summary.blocked;
    s.unknown += r.summary.unknown;
    s.formTextShows += r.summary.formTextShows;
    if (r.summary.safeEditExists) s.documentsWithSafeEdit++;
    for (const [c, n] of Object.entries(r.summary.blockReasons)) bump(s.blockReasons, c, n);
    for (const [k, n] of Object.entries(r.summary.fontKinds)) bump(s.fontKinds, k, n);
    bump(s.generators, r.generator || 'unknown');
    for (const e of d.edits) {
      s.editTests++;
      if (e.status === 'committed') s.committedEdits++;
      else if (e.status === 'rejected') s.verifierRejections++;
      else if (e.status === 'blocked') s.blockedEdits++;
      else if (e.status === 'failed') s.failedEdits++;
    }
  }
  s.percentEditableObjects = s.textObjects ? round((100 * s.supported) / s.textObjects, 1) : 0;
  s.topBlockReasons = Object.entries(s.blockReasons).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return s;
}

// Edit-test record kept per document (text stays in memory; buildExport decides what leaves).
export function editRecord(sel, result) {
  const p = result.plan || {};
  return { page: sel.pageIndex, objIndex: sel.objIndex, status: result.status, codes: [...new Set(result.reasons.map((r) => r.code))], failedChecks: result.checks.filter((c) => !c.pass).map((c) => c.id), checks: result.checks.length,
    discriminating: p.discriminating ?? null, naturalDelta: Number.isFinite(p.naturalDelta) ? round(p.naturalDelta, 3) : null, fontClass: p.font ? p.font.fontClass : null, oldText: result.oldText, newText: result.newText, stages: result.stages.map((s) => `${s.ok ? 'ok' : 'STOP'} ${s.name}`), t: new Date().toISOString() };
}

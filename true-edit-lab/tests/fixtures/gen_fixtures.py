#!/usr/bin/env python3
"""NoblePDF True Edit Phase 9 fixtures and INDEPENDENT reference PDFs.

Nothing here uses PDFium, PDF.js or the lab's JavaScript. The PDF writer, font
handling (fontTools, reportlab AFM metrics, Adobe Glyph List via pypdf) and the
expected replacement layout are implemented separately in Python, so the lab's
output can be compared with a reference that was not produced by the mutation code.

Expected layout rule (Run #10 semantics, re-implemented here from the written spec):
  common prefix/suffix by (code, Unicode) equality; prefix glyphs keep their original
  positions; changed glyphs at natural advance (width * size / 1000 + Tc + Tw on
  single-byte code 32); suffix keeps its internal positions, shifted so its first glyph
  sits at the natural position after the last changed glyph. Fit mode then spreads the
  width difference over interior real spaces of the new text.
Usage: gen_fixtures.py OUTDIR PHASE8_FIXTURE_DIR
"""
import hashlib, io, json, os, shutil, sys, zlib
from fontTools.ttLib import TTFont
from fontTools import subset as ftsubset
from reportlab.pdfbase import _fontdata as fd
from pypdf._codecs import adobe_glyphs as AGL
import pikepdf

OUT, P8DIR = sys.argv[1], sys.argv[2]
DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
os.makedirs(OUT, exist_ok=True)
AGL_REV = {}
for name, ch in AGL.items():
    n = name[1:]
    if len(ch) == 1 and ch not in AGL_REV and all(c.isalnum() for c in n):
        AGL_REV[ch] = n
def num(v):
    s = ('%.4f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s

# ----------------------------------------------------------------- PDF writer
class Pdf:
    def __init__(self):
        self.objs = []
    def reserve(self):
        self.objs.append(None)
        return len(self.objs)
    def set(self, n, body):
        self.objs[n - 1] = body if isinstance(body, bytes) else body.encode('latin-1')
    def add(self, body):
        n = self.reserve()
        self.set(n, body)
        return n
    def stream(self, dict_str, data, compress=True):
        raw = data if isinstance(data, bytes) else data.encode('latin-1')
        if compress:
            raw = zlib.compress(raw, 9)
            dict_str += ' /Filter /FlateDecode'
        return b'<< ' + dict_str.encode('latin-1') + b' /Length %d >>\nstream\n' % len(raw) + raw + b'\nendstream'
    def write(self, root, trailer_extra=''):
        out = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
        offs = []
        for i, b in enumerate(self.objs):
            offs.append(len(out))
            out += b'%d 0 obj\n' % (i + 1) + b + b'\nendobj\n'
        x = len(out)
        out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(self.objs) + 1)
        for o in offs:
            out += b'%010d 00000 n \n' % o
        out += ('trailer\n<< /Size %d /Root %d 0 R %s>>\nstartxref\n%d\n%%%%EOF\n' % (len(self.objs) + 1, root, trailer_extra, x)).encode('latin-1')
        return bytes(out)

# ----------------------------------------------------------------- fonts
class Font:
    single_byte = True
    bpc = 1
    def hexs(self, codes):
        return '<' + ''.join(('%02X' if self.bpc == 1 else '%04X') % c for c in codes) + '>'

class Std14(Font):
    def __init__(self, pdf, base='Helvetica', encoding='WinAnsiEncoding', differences=None, widths=True):
        names = list(fd.encodings[encoding])
        diff_ops = []
        if differences:
            for code, gname in differences:
                names[code] = gname
        self.names = names
        afm = fd.widthsByFontGlyph[base]
        self.w = {c: afm[n] for c, n in enumerate(names) if n and n in afm}
        self.rev = {}
        for c, n in enumerate(names):
            if n and n in afm:
                u = AGL.get('/' + n)
                if u and len(u) == 1 and u not in self.rev:
                    self.rev[u] = c
        enc = '/' + encoding
        if differences:
            parts, last = [], None
            for code, gname in differences:
                if last is None or code != last + 1:
                    parts.append(str(code))
                parts.append('/' + gname)
                last = code
            enc = '<< /Type /Encoding /BaseEncoding /%s /Differences [%s] >>' % (encoding, ' '.join(parts))
        wd = ''
        if widths:
            wd = ' /FirstChar 32 /LastChar 255 /Widths [%s]' % ' '.join(str(self.w.get(c, 0)) for c in range(32, 256))
        self.num = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /%s /Encoding %s%s >>' % (base, enc, wd))
    def codes(self, text):
        return [self.rev[ch] for ch in text]
    def width(self, code):
        return self.w.get(code, 0)

def subset_font(chars, retain_gids):
    f = TTFont(DEJAVU)
    opts = ftsubset.Options()
    opts.retain_gids = retain_gids
    opts.notdef_outline = True
    opts.glyph_names = True
    opts.hinting = False
    opts.layout_features = []
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
    sub = ftsubset.Subsetter(options=opts)
    sub.populate(unicodes=sorted({ord(c) for c in chars} | {0x20}))
    sub.subset(f)
    buf = io.BytesIO()
    f.save(buf)
    return f, buf.getvalue()

def descriptor(pdf, f, name, fontfile_num, flags):
    head, hhea = f['head'], f['hhea']
    s = 1000.0 / head.unitsPerEm
    return pdf.add('<< /Type /FontDescriptor /FontName /%s /Flags %d /FontBBox [%d %d %d %d] /ItalicAngle 0 /Ascent %d /Descent %d /CapHeight %d /StemV 80 /FontFile2 %d 0 R >>' % (
        name, flags, head.xMin * s, head.yMin * s, head.xMax * s, head.yMax * s, hhea.ascent * s, hhea.descent * s, hhea.ascent * s * 0.7, fontfile_num))

def tounicode(pdf, pairs, bpc):
    lines = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '/CMapName /NoblePDF-Fixture def', '/CMapType 2 def',
             '1 begincodespacerange', '<%s> <%s>' % ('00' * bpc, 'FF' * bpc), 'endcodespacerange']
    items = sorted(pairs.items())
    for i in range(0, len(items), 100):
        chunk = items[i:i + 100]
        lines.append('%d beginbfchar' % len(chunk))
        for code, ch in chunk:
            u16 = ch.encode('utf-16-be').hex().upper()
            lines.append(('<%02X> <%s>' if bpc == 1 else '<%04X> <%s>') % (code, u16))
        lines.append('endbfchar')
    lines += ['endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end']
    return pdf.add(pdf.stream('', '\n'.join(lines)))

class TTSimple(Font):
    """Embedded DejaVu Sans subset as a simple TrueType font (non-symbolic)."""
    def __init__(self, pdf, chars, mode='winansi', tag='AAAAAA'):
        f, data = subset_font(chars, retain_gids=False)
        upem = f['head'].unitsPerEm
        cmap = f.getBestCmap()
        hmtx = f['hmtx']
        self.rev = {}
        if mode == 'winansi':
            names = fd.encodings['WinAnsiEncoding']
            for c, n in enumerate(names):
                u = AGL.get('/' + n) if n else None
                if u and len(u) == 1 and u not in self.rev and ord(u) in cmap:
                    self.rev[u] = c
        else:
            # custom subset encoding: codes 1..n in sorted order, but the space keeps code 32
            # (as many subsetting producers do) so that Tw applies to it
            code = 1
            for ch in sorted(set(chars) - {' '}):
                if code == 32:
                    code += 1
                self.rev[ch] = code
                code += 1
            self.rev[' '] = 32
        self.gname = {ch: AGL_REV.get(ch) or cmap[ord(ch)] for ch in self.rev}
        self.w = {}
        for ch, c in self.rev.items():
            self.w[c] = round(hmtx[cmap[ord(ch)]][0] * 1000.0 / upem)
        first, last = min(self.w), max(self.w)
        ff = pdf.add(pdf.stream('/Length1 %d' % len(data), data))
        name = '%s+DejaVuSans' % tag
        fdn = descriptor(pdf, f, name, ff, 32)
        widths = ' '.join(str(self.w.get(c, 0)) for c in range(first, last + 1))
        if mode == 'winansi':
            enc = '/WinAnsiEncoding'
            tu = ''
        else:
            inv = {c: ch for ch, c in self.rev.items()}
            parts = [str(first)] + ['/' + self.gname[inv[c]] if c in inv else '/.notdef' for c in range(first, last + 1)]
            enc = '<< /Type /Encoding /Differences [%s] >>' % ' '.join(parts)
            tu = ' /ToUnicode %d 0 R' % tounicode(pdf, inv, 1)
        self.num = pdf.add('<< /Type /Font /Subtype /TrueType /BaseFont /%s /FirstChar %d /LastChar %d /Widths [%s] /Encoding %s /FontDescriptor %d 0 R%s >>' % (name, first, last, widths, enc, fdn, tu))
    def codes(self, text):
        return [self.rev[ch] for ch in text]
    def width(self, code):
        return self.w.get(code, 0)

class TTCid(Font):
    """Embedded DejaVu Sans subset as Type0 / CIDFontType2, CID = GID, Identity-H (or -V)."""
    single_byte = False
    bpc = 2
    def __init__(self, pdf, chars, vertical=False, tag='BBBBBB'):
        f, data = subset_font(chars, retain_gids=True)
        full = TTFont(DEJAVU)
        cmap = full.getBestCmap()
        order = full.getGlyphOrder()
        upem = f['head'].unitsPerEm
        hmtx = f['hmtx']
        self.rev = {}
        self.w = {}
        for ch in sorted(set(chars) | {' '}):
            gname = cmap[ord(ch)]
            gid = order.index(gname)
            self.rev[ch] = gid
            self.w[gid] = round(hmtx[f.getGlyphOrder()[gid]][0] * 1000.0 / upem)
        ff = pdf.add(pdf.stream('/Length1 %d' % len(data), data))
        name = '%s+DejaVuSans' % tag
        fdn = descriptor(pdf, f, name, ff, 32)
        W = ' '.join('%d [%d]' % (g, self.w[g]) for g in sorted(self.w))
        cid = pdf.add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /%s /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor %d 0 R /W [%s] /DW 1000 /CIDToGIDMap /Identity >>' % (name, fdn, W))
        tu = tounicode(pdf, {g: ch for ch, g in self.rev.items()}, 2)
        self.num = pdf.add('<< /Type /Font /Subtype /Type0 /BaseFont /%s /Encoding /%s /DescendantFonts [%d 0 R] /ToUnicode %d 0 R >>' % (name, 'Identity-V' if vertical else 'Identity-H', cid, tu))
    def codes(self, text):
        return [self.rev[ch] for ch in text]
    def width(self, code):
        return self.w.get(code, 1000)

class Type3(Font):
    def __init__(self, pdf):
        proc = pdf.add(pdf.stream('', '600 0 0 0 600 700 d1 50 0 500 700 re f'))
        self.num = pdf.add('<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a %d 0 R /b %d 0 R >> /Encoding << /Type /Encoding /Differences [97 /a /b] >> /FirstChar 97 /LastChar 98 /Widths [600 600] >>' % (proc, proc))
        self.rev = {'a': 97, 'b': 98}
    def codes(self, text):
        return [self.rev[ch] for ch in text]
    def width(self, code):
        return 600

# ----------------------------------------------------------------- runs and layout
class Run:
    """A text object: font resource, state, matrix and TJ items (str or kerning number)."""
    def __init__(self, font, res, size, items, tm, tc=0, tw=0, tz=100, tr=0, ts=0, cm=None, mark=None, clip=None, color=None):
        self.__dict__.update(dict(font=font, res=res, size=size, items=items, tm=tm, tc=tc, tw=tw, tz=tz, tr=tr, ts=ts, cm=cm, mark=mark, clip=clip, color=color))
    def text(self):
        return ''.join(i for i in self.items if isinstance(i, str))
    def glyphs(self):
        """[(code, char)], positions relative to the first glyph, leading offset (unscaled)."""
        out, xs, x, lead, seen = [], [], 0.0, 0.0, False
        for it in self.items:
            if not isinstance(it, str):
                if not seen:
                    lead += -it / 1000.0 * self.size
                else:
                    x += -it / 1000.0 * self.size
                continue
            for ch, code in zip(it, self.font.codes(it)):
                seen = True
                xs.append(x)
                out.append((code, ch))
                x += self.adv(code)
        return out, xs, lead
    def adv(self, code):
        return self.font.width(code) * self.size / 1000.0 + self.tc + (self.tw if code == 32 and self.font.single_byte else 0)
    def ops(self, glyph_xs=None):
        """Content operators. glyph_xs=(glyphs, xs, lead) writes an explicit layout instead of items."""
        f = self.font
        if glyph_xs is None:
            arr = []
            for it in self.items:
                arr.append(f.hexs(f.codes(it)) if isinstance(it, str) else num(it))
            tj = '[' + ' '.join(arr) + '] TJ'
        else:
            gl, xs, lead = glyph_xs
            arr = [num(-lead / self.size * 1000.0)] if abs(lead) > 1e-9 else []
            for i, (code, _) in enumerate(gl):
                arr.append(f.hexs([code]))
                if i + 1 < len(gl):
                    k = -(xs[i + 1] - xs[i] - self.adv(code)) * 1000.0 / self.size
                    if abs(k) > 5e-5:
                        arr.append(num(k))
            tj = '[' + ' '.join(arr) + '] TJ'
        s = 'BT /%s %s Tf %s Tc %s Tw %s Tz %d Tr %s Ts %s Tm %s ET' % (self.res, num(self.size), num(self.tc), num(self.tw), num(self.tz), self.tr, num(self.ts), ' '.join(num(v) for v in self.tm), tj)
        if self.color:
            s = '%s rg %s' % (self.color, s)
        if self.mark:
            s = '%s BDC %s EMC' % (self.mark, s)
        if self.clip:
            s = 'q %s re W n %s Q' % (self.clip, s)
        if self.cm:
            s = 'q %s cm %s Q' % (' '.join(num(v) for v in self.cm), s)
        return s

def expected_layout(run, start, end, repl, fit=False):
    old, xs, lead = run.glyphs()
    new = old[:start] + list(zip(run.font.codes(repl), repl)) + old[end:]
    on, nn = len(old), len(new)
    p = 0
    while p < on and p < nn and old[p] == new[p]:
        p += 1
    s = 0
    while s < on - p and s < nn - p and old[on - 1 - s] == new[nn - 1 - s]:
        s += 1
    nx = [0.0] * nn
    for i in range(p):
        nx[i] = xs[i]
    x = nx[p - 1] + run.adv(new[p - 1][0]) if p > 0 else xs[0]
    for i in range(p, nn - s):
        nx[i] = x
        x += run.adv(new[i][0])
    if s:
        shift = x - xs[on - s]
        for j in range(s):
            nx[nn - s + j] = xs[on - s + j] + shift
    if fit:
        old_end = xs[-1] + run.adv(old[-1][0])
        new_end = nx[-1] + run.adv(new[-1][0])
        slack = old_end - new_end
        spaces = [i for i in range(1, nn - 1) if new[i][1] == ' ']
        if spaces and abs(slack) > 1e-6:
            per = slack / len(spaces)
            if per >= -0.75 * run.adv(new[spaces[0]][0]):
                acc = 0.0
                for i in range(nn):
                    nx[i] += acc
                    if i in spaces:
                        acc += per
    natural = [nx[0]]
    for i in range(nn - 1):
        natural.append(natural[-1] + run.adv(new[i][0]))
    disc = max(abs(a - b) for a, b in zip(nx, natural))
    return new, nx, lead, disc

# ----------------------------------------------------------------- documents
def build(pages, fonts, extra_objs=None, page_extra=None, rotate=None, annots=None, shared=False, catalog_extra=''):
    """pages: list of lists of Run or raw op strings. fonts: {res: Font}. Returns bytes."""
    pdf = fonts.pop('__pdf__')
    xobj = (extra_objs or {}).get('xobjects', {})
    res = '<< /Font << %s >>%s%s >>' % (' '.join('/%s %d 0 R' % (k, v.num) for k, v in fonts.items()),
                                     (' /XObject << %s >>' % ' '.join('/%s %d 0 R' % kv for kv in xobj.items())) if xobj else '',
                                     (extra_objs or {}).get('res_extra', ''))
    pages_num = pdf.reserve()
    kids = []
    shared_num = None
    for items in pages:
        content = '\n'.join(i if isinstance(i, str) else i.ops() for i in items)
        if shared and shared_num:
            cnum = shared_num
        else:
            cnum = pdf.add(pdf.stream('', content, compress=False))
            shared_num = cnum
        pn = pdf.reserve()
        extra = (page_extra or '')
        if rotate:
            extra += ' /Rotate %d' % rotate
        if annots:
            extra += ' /Annots [%s]' % ' '.join('%d 0 R' % pdf.add(a.replace('PAGE', str(pn))) for a in annots)
        pdf.set(pn, '<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources %s /Contents %d 0 R%s >>' % (pages_num, res, cnum, extra))
        kids.append(pn)
    pdf.set(pages_num, '<< /Type /Pages /Kids [%s] /Count %d >>' % (' '.join('%d 0 R' % k for k in kids), len(kids)))
    root = pdf.add('<< /Type /Catalog /Pages %d 0 R%s >>' % (pages_num, catalog_extra.replace('PAGE1', str(kids[0]))))
    return pdf.write(root)

def gray_image(pdf, w=64, h=24):
    data = bytes(((x * 7 + y * 13) % 200) + 30 for y in range(h) for x in range(w))
    return pdf.add(pdf.stream('/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8' % (w, h), data))

manifest = {'version': 'phase9-fixtures-1', 'generator': 'tests/fixtures/gen_fixtures.py', 'fixtures': []}
written = {}
def save(name, data):
    path = os.path.join(OUT, name)
    open(path, 'wb').write(data)
    written[name] = hashlib.sha256(data).hexdigest()
    return name

def reference_for(make, target_key, start, end, repl, fit=False):
    """Rebuild the document with the target run laid out per the expected-layout rule."""
    pages, fonts, kw = make()
    for items in pages:
        for k, it in enumerate(items):
            if isinstance(it, Run) and getattr(it, 'key', None) == target_key:
                new, nx, lead, disc = expected_layout(it, start, end, repl, fit)
                ops = it.ops(glyph_xs=(new, nx, lead))
                items[k] = ops
                return build(pages, fonts, **kw), disc, ''.join(ch for _, ch in new)
    raise KeyError(target_key)

def fixture(fid, title, make, edit=None, expect='committed', reasons=None, covers=(), reference=True, notes='', before_name=None, post=None):
    if before_name:
        bname = before_name
    else:
        pages, fonts, kw = make()
        before = build(pages, fonts, **kw)
        if post:
            before = post(before)
        bname = save(fid + '-before.pdf', before)
    entry = {'id': fid, 'title': title, 'before': bname, 'expect': {'status': expect, 'reasons': reasons or []}, 'covers': list(covers), 'notes': notes}
    if edit:
        target = None
        for items in make()[0]:
            for it in items:
                if isinstance(it, Run) and getattr(it, 'key', None) == edit.get('key'):
                    target = it
        text = edit['object'] if 'object' in edit else target.text()
        start = text.index(edit['find'])
        end = start + len(edit['find'])
        e = {'page': 0, 'object': text, 'find': edit['find'], 'occurrence': 0, 'replace': edit['replace'], 'fit': edit.get('fit', False)}
        if expect == 'committed' and reference:
            ref, disc, newtext = reference_for(make, edit['key'], start, end, edit['replace'], edit.get('fit', False))
            entry['reference'] = save(fid + '-reference.pdf', ref)
            e['expectedText'] = newtext
            entry['expect']['discriminating'] = disc >= 0.05
            entry['expect']['naturalDelta'] = round(disc, 4)
        entry['edit'] = e
    manifest['fixtures'].append(entry)

def K(run, key):
    run.key = key
    return run

# ----------------------------------------------------------------- fixture documents
def doc_invoice(with_signature=False, with_collision=False):
    pdf = Pdf()
    F1 = Std14(pdf, 'Helvetica')
    F2 = Std14(pdf, 'Helvetica-Bold')
    F3 = Std14(pdf, 'Helvetica-Oblique')
    img = gray_image(pdf)
    items = [
        '0.2 0.2 0.2 RG 1 w 72 700 m 540 700 l S',
        'q 64 0 0 24 476 716 cm /Im1 Do Q',
        Run(F2, 'F2', 24, ['INVOICE'], (1, 0, 0, 1, 72, 712)),
        K(Run(F1, 'F1', 12, ['I', 30, 'nvoice', -80, ' Number: 12345'], (1, 0, 0, 1, 72, 670)), 'number'),
        Run(F1, 'F1', 12, ['Date: 30 September 2026'], (1, 0, 0, 1, 72, 650)),
        K(Run(F1, 'F1', 12, ['Bi', 30, 'll to: Jane Citizen'], (1, 0, 0, 1, 72, 620), tw=1.5), 'billto'),
        '0.85 0.85 0.85 rg 72 572 468 20 re f 0 0 0 rg',
        Run(F1, 'F1', 11, ['Consulting services'], (1, 0, 0, 1, 76, 578)),
        Run(F1, 'F1', 11, ['1,200.00'], (1, 0, 0, 1, 480, 578)),
        K(Run(F1, 'F1', 12, ['Total due: 1,234.50 A', 25, 'UD'], (1, 0, 0, 1, 72, 540)), 'total'),
        K(Run(F1, 'F1', 12, ['Status: PENDING REVIEW'], (1, 0, 0, 1, 72, 510)), 'status'),
        Run(F3, 'F3', 10, ['Thank you for your business'], (1, 0, 0, 1, 72, 100)),
    ]
    if with_collision:
        items.append(Run(F1, 'F1', 12, ['Due: 14 days'], (1, 0, 0, 1, 205, 670)))
    kw = {'extra_objs': {'xobjects': {'Im1': img}}, 'annots': ['<< /Type /Annot /Subtype /Link /Rect [72 96 250 110] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/) >> >>']}
    if with_signature:
        sig = pdf.add('<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 10 20 10] /Contents <%s> /M (D:20260930000000Z) >>' % ('00' * 64))
        wid = pdf.add('<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /V %d 0 R /Rect [0 0 0 0] /F 132 >>' % sig)
        kw['catalog_extra'] = ' /AcroForm << /Fields [%d 0 R] /SigFlags 3 >>' % wid
    return [items], {'__pdf__': pdf, 'F1': F1, 'F2': F2, 'F3': F3}, kw

def simple_doc(runs_fn, extra=None):
    def make():
        pdf = Pdf()
        pages, fonts = runs_fn(pdf)
        fonts['__pdf__'] = pdf
        return pages, fonts, dict(extra or {})
    return make

def helv(pdf, widths=True, base='Helvetica'):
    return Std14(pdf, base, widths=widths)

# ---- supported fixtures -------------------------------------------------------------
shutil.copy(os.path.join(P8DIR, 'pure-tj-before.pdf'), os.path.join(OUT, 'p8-waveskern-before.pdf'))
shutil.copy(os.path.join(P8DIR, 'pure-tj-reference.pdf'), os.path.join(OUT, 'p8-waveskern-reference.pdf'))
for n in ('p8-waveskern-before.pdf', 'p8-waveskern-reference.pdf'):
    written[n] = hashlib.sha256(open(os.path.join(OUT, n), 'rb').read()).hexdigest()
manifest['fixtures'].append({'id': 'p8-waveskern', 'title': 'Phase 8 hard fixture WAVESKERN -> TOKYOLAKE (pure TJ kerning)', 'before': 'p8-waveskern-before.pdf', 'reference': 'p8-waveskern-reference.pdf',
    'edit': {'page': 0, 'object': 'WAVESKERN', 'find': 'WAVESKERN', 'occurrence': 0, 'replace': 'TOKYOLAKE', 'fit': False, 'expectedText': 'TOKYOLAKE'},
    'expect': {'status': 'committed', 'reasons': [], 'discriminating': False, 'naturalDelta': 0.0}, 'covers': ['phase8-baseline', 'full-replacement', 'tj-kerning-dropped-by-design'],
    'notes': 'Reference produced independently in Phase 8. Anchored layout of a full replacement equals natural advances, so this fixture alone cannot discriminate SetPositions; the Phase 8 V2 page keeps the legacy discrimination arm.'})

fixture('invoice-number-longer', 'Invoice: "12345" -> "INV-2026-0012345" (non-empty prefix with kerning fixed, shorter -> longer)', lambda: doc_invoice(),
        {'key': 'number', 'find': '12345', 'replace': 'INV-2026-0012345'}, covers=['prefix', 'shorter-to-longer', 'prefix-kerning', 'document-like', 'untouched-neighbours'])
fixture('invoice-total-shorter', 'Invoice: "1,234.50" -> "987.00" (prefix fixed, suffix " AUD" with kerning shifts left)', lambda: doc_invoice(),
        {'key': 'total', 'find': '1,234.50', 'replace': '987.00'}, covers=['prefix', 'suffix', 'longer-to-shorter', 'suffix-kerning'])
fixture('invoice-billto-spaces-tw', 'Invoice: "Jane Citizen" -> "Dr Jane Q Citizen" (real spaces, Tw 1.5)', lambda: doc_invoice(),
        {'key': 'billto', 'find': 'Jane Citizen', 'replace': 'Dr Jane Q Citizen'}, covers=['real-spaces', 'tw', 'prefix'])
fixture('invoice-status-fit', 'Invoice: "PENDING REVIEW" -> "OVERDUE NOTICE" with width-preserving fit', lambda: doc_invoice(),
        {'key': 'status', 'find': 'PENDING REVIEW', 'replace': 'OVERDUE NOTICE', 'fit': True}, covers=['fit', 'real-spaces', 'width-preserving'])


def mk(builder, **kw):
    def make():
        pdf = Pdf()
        items, fonts = builder(pdf)
        fonts['__pdf__'] = pdf
        extra = dict(kw)
        if callable(extra.get('extra_objs')):
            extra['extra_objs'] = extra['extra_objs'](pdf, fonts)
        return ([items] if not (items and isinstance(items[0], list)) else items), fonts, extra
    return make

def b_tc(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Refer', 40, 'ence code ABC-123'], (1, 0, 0, 1, 72, 700), tc=0.6), 't'), Run(F1, 'F1', 12, ['Unrelated line stays put'], (1, 0, 0, 1, 72, 670))], {'F1': F1}
fixture('state-tc', 'Tc 0.6 pt (0.05 em): "ABC-123" -> "XYZ-98765"', mk(b_tc), {'key': 't', 'find': 'ABC-123', 'replace': 'XYZ-98765'}, covers=['tc', 'shorter-to-longer', 'prefix'])

def b_tz(tz):
    def b(pdf):
        F1 = Std14(pdf)
        return [K(Run(F1, 'F1', 12, ['Con', 30, 'densed caption te', -20, 'xt'], (1, 0, 0, 1, 72, 700), tz=tz), 't'), Run(F1, 'F1', 12, ['Plain neighbour line'], (1, 0, 0, 1, 72, 670))], {'F1': F1}
    return b
fixture('state-tz80', 'Tz 80: "caption" -> "legend" (prefix and suffix, Tz folded into Tm by the generator)', mk(b_tz(80)), {'key': 't', 'find': 'caption', 'replace': 'legend'}, covers=['tz', 'prefix', 'suffix'])
fixture('state-tz150', 'Tz 150: "caption" -> "banner title"', mk(b_tz(150)), {'key': 't', 'find': 'caption', 'replace': 'banner title'}, covers=['tz', 'real-spaces', 'suffix'])

def b_rot(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 14, ['Rotated st', 50, 'amp APPROVED'], (0.866025, 0.5, -0.5, 0.866025, 150, 450)), 't'), Run(F1, 'F1', 12, ['Level text line'], (1, 0, 0, 1, 72, 700))], {'F1': F1}
fixture('rotated-30', 'Text rotated 30 degrees: "APPROVED" -> "REJECTED"', mk(b_rot), {'key': 't', 'find': 'APPROVED', 'replace': 'REJECTED'}, covers=['rotation', 'prefix'])

def b_scaled(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 9, ['Sca', 40, 'led label 42 un', -30, 'its'], (2, 0, 0, 2, 40, 500), cm=(0.8, 0, 0, 0.8, 30, 60)), 't'), Run(F1, 'F1', 12, ['Unscaled neighbour'], (1, 0, 0, 1, 72, 700))], {'F1': F1}
fixture('scaled-tm', 'Scaled Tm (2x, 9 pt) inside a 0.8 cm: "42" -> "4242"', mk(b_scaled), {'key': 't', 'find': '42', 'replace': '4242'}, covers=['scaled-tm', 'cm', 'prefix', 'suffix'])

def b_ttf(pdf):
    F4 = TTSimple(pdf, 'Menu: Caf\u00e9 Z\u00fcrich' + 'Cr\u00e8me br\u00fbl\u00e9e \u20ac4' + 'Unrelated', mode='winansi', tag='TTWINA')
    return [K(Run(F4, 'F4', 14, ['Me', 30, 'nu: Caf\u00e9 Z\u00fcrich'], (1, 0, 0, 1, 72, 700)), 't'), Run(F4, 'F4', 12, ['Unrelated'], (1, 0, 0, 1, 72, 670))], {'F4': F4}
fixture('ttf-winansi-nonascii', 'Embedded TrueType (WinAnsi): "Caf\\u00e9 Z\\u00fcrich" -> "Cr\\u00e8me br\\u00fbl\\u00e9e \\u20ac4" (euro: code 0x80 != U+20AC)', mk(b_ttf),
        {'key': 't', 'find': 'Caf\u00e9 Z\u00fcrich', 'replace': 'Cr\u00e8me br\u00fbl\u00e9e \u20ac4'}, covers=['embedded-truetype', 'non-ascii', 'code-ne-unicode', 'real-spaces', 'prefix'])

def b_ttfc(pdf):
    F5 = TTSimple(pdf, 'Order ref: KX-42' + 'ZQ-9001' + 'Footer', mode='custom', tag='TTCUST')
    return [K(Run(F5, 'F5', 13, ['Or', 40, 'der ref: KX-42'], (1, 0, 0, 1, 72, 700)), 't'), Run(F5, 'F5', 12, ['Footer'], (1, 0, 0, 1, 72, 100))], {'F5': F5}
fixture('ttf-custom-encoding', 'Embedded TrueType with a custom encoding (codes 1..n, ToUnicode): "KX-42" -> "ZQ-9001"', mk(b_ttfc),
        {'key': 't', 'find': 'KX-42', 'replace': 'ZQ-9001'}, covers=['embedded-truetype', 'code-ne-unicode', 'f7-trap', 'shorter-to-longer'])

def b_diff(pdf):
    F6 = Std14(pdf, 'Helvetica', 'WinAnsiEncoding', differences=[(65, 'H'), (66, 'E'), (67, 'L'), (68, 'O'), (69, 'W'), (70, 'R'), (71, 'D')])
    return [K(Run(F6, 'F6', 16, ['Wo', 50, 'rd: HELLO'], (1, 0, 0, 1, 72, 700)), 't')], {'F6': F6}
fixture('std-differences', 'Helvetica with /Differences remapping codes 65-71: "HELLO" -> "WORLD"', mk(b_diff),
        {'key': 't', 'find': 'HELLO', 'replace': 'WORLD'}, covers=['differences', 'code-ne-unicode', 'f7-trap', 'prefix'])

def b_euro(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Pri', 30, 'ce: 5 EUR ea', -20, 'ch'], (1, 0, 0, 1, 72, 700)), 't')], {'F1': F1}
fixture('euro-winansi', 'Helvetica WinAnsi with /Widths: "5 EUR" -> "\\u20ac5" (code 0x80, not U+20AC)', mk(b_euro),
        {'key': 't', 'find': '5 EUR', 'replace': '\u20ac5'}, covers=['non-ascii', 'code-ne-unicode', 'f7-trap', 'suffix', 'longer-to-shorter'])

def b_cid(pdf):
    F7 = TTCid(pdf, '\u0391\u03b8\u03ae\u03bd\u03b1 2026 \u0398\u03b5\u03c3\u03c3\u03b1\u03bb\u03bf\u03bd\u03af\u03ba\u03b7', tag='CIDGRK')
    return [K(Run(F7, 'F7', 14, ['\u0391\u03b8\u03ae\u03bd\u03b1 20', 40, '26'], (1, 0, 0, 1, 72, 700)), 't')], {'F7': F7}
fixture('cid-greek', 'CID (Type0 Identity-H, embedded TrueType): Greek "\\u0391\\u03b8\\u03ae\\u03bd\\u03b1" -> "\\u0398\\u03b5\\u03c3\\u03c3\\u03b1\\u03bb\\u03bf\\u03bd\\u03af\\u03ba\\u03b7"', mk(b_cid),
        {'key': 't', 'find': '\u0391\u03b8\u03ae\u03bd\u03b1', 'replace': '\u0398\u03b5\u03c3\u03c3\u03b1\u03bb\u03bf\u03bd\u03af\u03ba\u03b7'}, covers=['cid', 'non-ascii', 'code-ne-unicode', 'suffix', 'shorter-to-longer'])

def b_astral(pdf):
    F8 = TTCid(pdf, 'Old Italic: \U00010300\U00010301\U00010302\U00010303\U00010304', tag='CIDAST')
    return [K(Run(F8, 'F8', 14, ['Old It', 30, 'alic: \U00010300\U00010301'], (1, 0, 0, 1, 72, 700)), 't')], {'F8': F8}
fixture('cid-astral', 'CID with astral characters (surrogate pairs in JavaScript): U+10300 U+10301 -> U+10302 U+10303 U+10304', mk(b_astral),
        {'key': 't', 'find': '\U00010300\U00010301', 'replace': '\U00010302\U00010303\U00010304'}, covers=['cid', 'astral', 'f9', 'prefix'])

def b_astral_tw(pdf):
    F12 = TTSimple(pdf, 'Rune \U00010300 mark here new sign', mode='custom', tag='TTASTR')
    return [K(Run(F12, 'F12', 13, ['Ru', 30, 'ne \U00010300 mark here'], (1, 0, 0, 1, 72, 700), tw=4), 't')], {'F12': F12}
fixture('ttf-astral-tw', 'Simple embedded font mapping an astral character (U+10300) with Tw 4: "mark" -> "new sign" (UTF-16 indexing misplaces word spacing after the astral character)', mk(b_astral_tw),
        {'key': 't', 'find': 'mark', 'replace': 'new sign'}, covers=['astral', 'f9-trap', 'tw', 'real-spaces', 'embedded-truetype', 'code-ne-unicode', 'suffix'])

def b_one(pdf):
    F1 = Std14(pdf)
    return [Run(F1, 'F1', 12, ['Grade:'], (1, 0, 0, 1, 72, 700)), K(Run(F1, 'F1', 12, ['A'], (1, 0, 0, 1, 115, 700)), 't'), K(Run(F1, 'F1', 12, ['Gr', 40, 'ade: A'], (1, 0, 0, 1, 72, 670)), 'u')], {'F1': F1}
fixture('one-glyph-object', 'One-glyph text object "A" -> "B" (SetPositions must be skipped: count 0 is rejected)', mk(b_one), {'key': 't', 'find': 'A', 'replace': 'B'}, covers=['one-glyph', 'setpositions-count-0'])
fixture('one-char-replacement', 'One character inside a longer object: "Grade: A" -> "Grade: B"', mk(b_one), {'key': 'u', 'find': 'A', 'replace': 'B'}, covers=['one-char', 'prefix'])

def b_lead(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, [-400, 'Sec', 30, 'tion 4.2 Scope'], (1, 0, 0, 1, 72, 700)), 't')], {'F1': F1}
fixture('leading-tj', 'Leading TJ offset [-400 (...)]: "Scope" -> "Coverage" (PDFium folds the offset into the object matrix)', mk(b_lead), {'key': 't', 'find': 'Scope', 'replace': 'Coverage'}, covers=['leading-tj', 'prefix'])

def b_mix(pdf):
    F1 = Std14(pdf)
    return [
        K(Run(F1, 'F1', 12, ['Ed', 40, 'it me here'], (1, 0, 0, 1, 72, 720)), 't'),
        Run(F1, 'F1', 12, ['Lightly tracked label'], (1, 0, 0, 1, 72, 690), tc=0.4),
        Run(F1, 'F1', 12, ['Word spaced words here'], (1, 0, 0, 1, 72, 665), tw=3),
        Run(F1, 'F1', 12, ['Ke', 60, 'rned', -30, ' words'], (1, 0, 0, 1, 72, 640)),
        Run(F1, 'F1', 12, ['Vertical margin note'], (0, 1, -1, 0, 560, 300)),
        Run(F1, 'F1', 10, ['Scaled by cm'], (1, 0, 0, 1, 0, 0), cm=(1.5, 0, 0, 1.5, 72, 520)),
        Run(F1, 'F1', 12, ['Stretched plain'], (1, 0, 0, 1, 72, 480), tz=120),
        Run(F1, 'F1', 12, ['Red warning'], (1, 0, 0, 1, 72, 455), color='0.8 0.1 0.1'),
        Run(F1, 'F1', 12, ['Rotated 45'], (0.7071, 0.7071, -0.7071, 0.7071, 300, 380)),
        Run(F1, 'F1', 12, ['subscript'], (1, 0, 0, 1, 72, 420), ts=-3),
        '0 0 1 RG 2 w 72 400 m 300 400 l S',
    ], {'F1': F1}
fixture('untouched-mix', 'Edit one object; untouched Tc, Tw, TJ kerning, rotation 90/45, cm scale, Tz 120, colour, rise and a path must not change', mk(b_mix),
        {'key': 't', 'find': 'here', 'replace': 'there and back'}, covers=['untouched-tc', 'untouched-tw', 'untouched-kerning', 'untouched-rotation', 'untouched-transform', 'untouched-tz', 'untouched-rise'])

def b_tag(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Tag', 30, 'ged paragraph text'], (1, 0, 0, 1, 72, 700), mark='/P <</MCID 0>>'), 't')], {'F1': F1}
fixture('tagged-mcid', 'Tagged text (/P with MCID only): "text" -> "content"; BDC/EMC must survive', mk(b_tag), {'key': 't', 'find': 'text', 'replace': 'content'}, covers=['marked-content-mcid', 'prefix'])

# ---- blocked fixtures --------------------------------------------------------------
INV = 'invoice-number-longer-before.pdf'
def inv_edit(repl='INV-2026-0012345'):
    return {'key': 'number', 'find': '12345', 'replace': repl}
fixture('blocked-signed', 'Signed document (signature field)', lambda: doc_invoice(with_signature=True), inv_edit(), expect='blocked', reasons=['signed-document'], covers=['gate-signature'])
def encrypt(b):
    pdf = pikepdf.open(io.BytesIO(b))
    out = io.BytesIO()
    pdf.save(out, encryption=pikepdf.Encryption(owner='owner-secret', user='', R=6, allow=pikepdf.Permissions(modify_other=False, modify_form=False, modify_annotation=False, modify_assembly=False)))
    return out.getvalue()
fixture('blocked-encrypted-restricted', 'Encrypted (AES-256, empty user password) with modification not permitted', lambda: doc_invoice(), inv_edit(), expect='blocked', reasons=['encrypted-document', 'permissions-restrict-modify'], covers=['gate-permissions'], post=encrypt)

def b_actual(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Displayed words'], (1, 0, 0, 1, 72, 700), mark='/Span <</ActualText (Different words)>>'), 't')], {'F1': F1}
fixture('blocked-actualtext', 'Marked content with /ActualText (extraction would disagree with the glyphs)', mk(b_actual), {'key': 't', 'find': 'words', 'replace': 'texts'}, expect='blocked', reasons=['marked-content-ambiguous', 'marked-content-actualtext'], covers=['gate-marked-content'])

def b_form(pdf):
    F1 = Std14(pdf)
    form = pdf.add(pdf.stream('/Type /XObject /Subtype /Form /BBox [0 0 300 40] /Resources << /Font << /F1 %d 0 R >> >>' % F1.num, 'BT /F1 12 Tf 1 0 0 1 0 10 Tm %s Tj ET' % F1.hexs(F1.codes('Form text 123'))))
    pdf._form = form
    return ['q 1 0 0 1 72 600 cm /Fm1 Do Q', Run(F1, 'F1', 12, ['Direct text'], (1, 0, 0, 1, 72, 700))], {'F1': F1}
fixture('blocked-form-xobject', 'Target text lives inside a Form XObject (possibly shared appearance)', mk(b_form, extra_objs=lambda pdf, fonts: {'xobjects': {'Fm1': pdf._form}}),
        {'object': 'Form text 123', 'find': '123', 'replace': '456'}, expect='blocked', reasons=['text-in-form-xobject'], covers=['gate-form-xobject'])

def b_t3(pdf):
    F9 = Type3(pdf)
    F1 = Std14(pdf)
    return [K(Run(F9, 'F9', 12, ['abab'], (1, 0, 0, 1, 72, 700)), 't'), Run(F1, 'F1', 12, ['Normal text'], (1, 0, 0, 1, 72, 670))], {'F9': F9, 'F1': F1}
fixture('blocked-type3', 'Type3 font', mk(b_t3), {'key': 't', 'find': 'ab', 'replace': 'ba'}, expect='blocked', reasons=['font-type3'], covers=['gate-type3'])

class TTSym(TTSimple):
    def __init__(self, pdf, chars):
        super().__init__(pdf, chars, mode='winansi', tag='TTSYMB')
        body = pdf.objs[self.num - 1].decode('latin-1').replace(' /Encoding /WinAnsiEncoding', '')
        pdf.set(self.num, body)
        fdn = int(body.split('/FontDescriptor ')[1].split()[0])
        pdf.set(fdn, pdf.objs[fdn - 1].decode('latin-1').replace('/Flags 32', '/Flags 4'))
def b_sym(pdf):
    F10 = TTSym(pdf, 'Symbolic words')
    return [K(Run(F10, 'F10', 12, ['Symbolic words'], (1, 0, 0, 1, 72, 700)), 't')], {'F10': F10}
fixture('blocked-no-unicode-map', 'Symbolic embedded TrueType without /Encoding or /ToUnicode', mk(b_sym), {'key': 't', 'find': 'words', 'replace': 'terms'}, expect='blocked', reasons=['font-no-unicode-map'], covers=['gate-font-mapping'])

def b_vert(pdf):
    F11 = TTCid(pdf, 'Vertical text', vertical=True, tag='CIDVRT')
    return [K(Run(F11, 'F11', 12, ['Vertical text'], (1, 0, 0, 1, 300, 700)), 't')], {'F11': F11}
fixture('blocked-vertical', 'Vertical writing (Type0 Identity-V)', mk(b_vert), {'key': 't', 'find': 'text', 'replace': 'copy'}, expect='blocked', reasons=['font-vertical'], covers=['gate-vertical'])

def b_img(pdf):
    img = gray_image(pdf, 120, 160)
    pdf._img = img
    return ['q 400 0 0 520 100 150 cm /Im1 Do Q'], {}
fixture('blocked-image-only', 'Scanned / image-only page', mk(b_img, extra_objs=lambda pdf, fonts: {'xobjects': {'Im1': pdf._img}}),
        {'object': '', 'find': '', 'replace': 'x'}, expect='blocked', reasons=['no-editable-text'], covers=['gate-scanned'])

def b_ocr(pdf):
    img = gray_image(pdf, 120, 160)
    pdf._img = img
    F1 = Std14(pdf)
    return ['q 400 0 0 520 100 150 cm /Im1 Do Q', K(Run(F1, 'F1', 12, ['Scanned invoice 777'], (1, 0, 0, 1, 110, 600), tr=3), 't')], {'F1': F1}
fixture('blocked-ocr-invisible', 'Scanned page with an invisible OCR text layer (Tr 3)', mk(b_ocr, extra_objs=lambda pdf, fonts: {'xobjects': {'Im1': pdf._img}}),
        {'key': 't', 'find': '777', 'replace': '778'}, expect='blocked', reasons=['invisible-text', 'no-editable-text'], covers=['gate-scanned', 'gate-invisible'])

def b_shared(pdf):
    F1 = Std14(pdf)
    return [[K(Run(F1, 'F1', 12, ['Shared content 42'], (1, 0, 0, 1, 72, 700)), 't')], [K(Run(F1, 'F1', 12, ['Shared content 42'], (1, 0, 0, 1, 72, 700)), 't2')]], {'F1': F1}
fixture('blocked-shared-content', 'Two pages share one content stream (edit would change both)', mk(b_shared, shared=True), {'key': 't', 'find': '42', 'replace': '43'}, expect='blocked', reasons=['shared-content-stream'], covers=['gate-shared'])

def b_missing(pdf):
    F4 = TTSimple(pdf, 'Menu: Cafe', mode='winansi', tag='TTMISS')
    return [K(Run(F4, 'F4', 14, ['Menu: Cafe'], (1, 0, 0, 1, 72, 700)), 't')], {'F4': F4}
fixture('blocked-glyph-missing', 'Embedded subset lacks glyphs needed by the replacement ("Cafe" -> "Zoo")', mk(b_missing), {'key': 't', 'find': 'Cafe', 'replace': 'Zoo'}, expect='blocked', reasons=['glyph-not-in-font-subset'], covers=['gate-glyph-availability'])

def b_tracked(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Tracked heading text'], (1, 0, 0, 1, 72, 700), tc=1.5), 't')], {'F1': F1}
fixture('blocked-tracked-text', 'Tracked text Tc 1.5 pt at 12 pt: PDF.js already splits every glyph', mk(b_tracked), {'key': 't', 'find': 'heading', 'replace': 'title'}, expect='blocked', reasons=['original-extraction-inconsistent-pdfjs', 'tracked-text'], covers=['gate-semantic-gap'])

fixture('blocked-collision', 'Longer value would run into the next object on the same line', lambda: doc_invoice(with_collision=True), inv_edit(), expect='blocked', reasons=['collision-with-neighbour'], covers=['gate-collision'])

def b_group(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Editable line'], (1, 0, 0, 1, 72, 700)), 't'), Run(F1, 'F1', 12, ['Stret', -80, 'ched'], (1, 0, 0, 1, 72, 670), tz=150)], {'F1': F1}
fixture('rejected-untouched-grouping', 'Untouched Tz 150 object with 0.08 em kerning: regeneration writes Tz into Tm and PDF.js stops splitting it', mk(b_group),
        {'key': 't', 'find': 'line', 'replace': 'row'}, expect='rejected', reasons=['V12'], covers=['untouched-pdfjs-grouping', 'fail-closed-verification'])

def b_clip(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Clipped cell value 99'], (1, 0, 0, 1, 72, 700), clip='60 690 300 30'), 't')], {'F1': F1}
fixture('blocked-clip', 'Target text drawn under a clipping path', mk(b_clip), {'key': 't', 'find': '99', 'replace': '100'}, expect='blocked', reasons=['target-clipped'], covers=['gate-clip'])

def b_rotp(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Rotated page text'], (1, 0, 0, 1, 72, 700)), 't')], {'F1': F1}
fixture('blocked-page-rotate', 'Page /Rotate 90 (not yet validated)', mk(b_rotp, rotate=90), {'key': 't', 'find': 'text', 'replace': 'copy'}, expect='blocked', reasons=['page-rotation-not-validated'], covers=['gate-page-rotation'])

def b_euro_nw(pdf):
    F1 = Std14(pdf, widths=False)
    return [K(Run(F1, 'F1', 12, ['Price: 5 EUR each'], (1, 0, 0, 1, 72, 700)), 't')], {'F1': F1}
fixture('blocked-std14-no-widths-euro', 'Helvetica without /Widths: the Euro width differs between PDFium (667) and AFM/PDF.js (556)', mk(b_euro_nw), {'key': 't', 'find': '5 EUR', 'replace': '\u20ac5'}, expect='blocked', reasons=['metrics-disagree'], covers=['gate-metrics'])

def b_rise(pdf):
    F1 = Std14(pdf)
    return [K(Run(F1, 'F1', 12, ['Raised note'], (1, 0, 0, 1, 72, 700), ts=3), 't')], {'F1': F1}
fixture('blocked-text-rise', 'Target text with a text rise (Ts 3)', mk(b_rise), {'key': 't', 'find': 'note', 'replace': 'memo'}, expect='blocked', reasons=['text-rise-not-validated'], covers=['gate-rise'])

def b_oc(pdf):
    F1 = Std14(pdf)
    ocg = pdf.add('<< /Type /OCG /Name (Layer 1) >>')
    pdf._ocg = ocg
    return [K(Run(F1, 'F1', 12, ['Layered words'], (1, 0, 0, 1, 72, 700), mark='/OC /oc1'), 't')], {'F1': F1}
fixture('blocked-optional-content', 'Target text inside an optional content group', mk(b_oc, extra_objs=lambda pdf, fonts: {'res_extra': ' /Properties << /oc1 %d 0 R >>' % pdf._ocg}),
        {'key': 't', 'find': 'words', 'replace': 'terms'}, expect='blocked', reasons=['optional-content'], covers=['gate-optional-content'])

for fid, repl, code in [('input-empty', '', 'empty-replacement'), ('input-combining', 'e\u0301', 'combining-mark-unsupported'), ('input-rtl', '\u05e9\u05dc\u05d5\u05dd', 'rtl-unsupported'),
                        ('input-line-break', '12\n345', 'line-break-unsupported'), ('input-lone-surrogate', '12\ud800', 'invalid-unicode'), ('input-zwj', '12\u200d3', 'format-character-unsupported')]:
    fixture(fid, 'Input rejection: %s' % code, lambda: doc_invoice(), inv_edit(repl), expect='blocked', reasons=[code], covers=['input-validation', 'f9'], before_name=INV)

for f in manifest['fixtures']:
    f['sha256'] = {k: written[f[k]] for k in ('before', 'reference') if k in f}
manifest['fixtures'].sort(key=lambda f: (f['expect']['status'] != 'committed', f['id']))
# .txt, not .json: the live host answers 403 to every *.json URL.
open(os.path.join(OUT, 'manifest.txt'), 'w').write(json.dumps(manifest, indent=1, ensure_ascii=True))
print('fixtures', len(manifest['fixtures']), 'files', len(written), 'bytes', sum(os.path.getsize(os.path.join(OUT, n)) for n in written))

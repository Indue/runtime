#!/usr/bin/env python3
"""HARNESS ONLY. Headless-Chromium tests for the Phase 10 corpus harness page.

Starts tests/harness/server-phase10.mjs with the REAL Run #10 engine, opens
phase10-corpus.html in fresh browser contexts and drives it through the real UI: preflight,
<input type=file> selection of local PDFs (Phase 9 fixtures and synthetic inputs), clicks on
the rendered page, typing, the verified edit test, undo, reset, download and report export.
Every browser request is recorded by Playwright (method, URL, request body) and by the
server; any request that carries a body, is not GET, leaves localhost or contains PDF bytes
fails the run. A crash is a failure, never a pass.

Usage (from the package root):
  REAL_PATCHED_DIR=... python3 tests/harness/run-phase10.py [SCENARIO_ID ...]
Writes tests/results/phase10-browser-results.json and .txt.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.abspath(os.path.join(HERE, '..', '..'))
RESULTS = os.path.join(PKG, 'tests', 'results')
PORT = int(os.environ.get('PORT', '8793'))
BASE = f'http://localhost:{PORT}'
PAGE = '/lab/true-text-edit/phase10-corpus.html'
# SHA-256 of the a3f9038 phase8.css; phase10-base.css is its byte copy (build_phase10_package.py).
FROZEN_PHASE8_CSS = 'd36798cccf827b2c1fb7a6c510fe3761e2e86a6ceb517eaef779d5cac5ad03a7'
LAB_DIR = os.path.join(PKG, 'public_html', 'app.noblepdf.com', 'lab', 'true-text-edit')
FIX_DIR = os.path.join(LAB_DIR, 'fixtures-phase9')
MANIFEST = json.loads(open(os.path.join(FIX_DIR, 'manifest.txt'), 'rb').read().decode('utf-8'))
FX = {f['id']: f for f in MANIFEST['fixtures']}
INPUTS = tempfile.mkdtemp(prefix='phase10-inputs-')
# LOCAL DEBUGGING ONLY: P10_DEV=1 uses the stock engine with swapped pins (server-phase10.mjs
# dev mode). Edits then fail closed (no SetPositions). A DEV run never counts as a pass: it
# exits with status 3 and writes *-DEV results. CI never sets P10_DEV.
DEV = os.environ.get('P10_DEV') == '1'


def fixture(fid):
    return os.path.join(FIX_DIR, FX[fid]['before'])


def synthetic(name):
    return os.path.join(INPUTS, name)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def http_get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))


def start_server():
    subprocess.run(['node', os.path.join(PKG, 'tests', 'node', 'phase10-make-inputs.mjs'), INPUTS], check=True, stdout=subprocess.DEVNULL)
    proc = subprocess.Popen(['node', os.path.join(HERE, 'server-phase10.mjs')], env=dict(os.environ, PORT=str(PORT), P10_DEV='1' if DEV else '0'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            info = http_get('/__p10/scenario')
            if not info.get('realEngine') and not DEV:
                raise SystemExit('REAL_PATCHED_DIR does not hold the Run #10 engine (run tests/tools/fetch-engine.sh)')
            return proc
        except SystemExit:
            proc.terminate()
            raise
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError('harness server exited: ' + proc.stdout.read().decode('utf-8', 'replace'))
            time.sleep(0.2)
    raise RuntimeError('harness server did not start')


def configure(engine='real', inject='none', csp='strict'):
    if DEV and engine == 'real':
        engine = 'dev-stock'
    return http_get('/__p10/scenario?' + urllib.parse.urlencode(dict(engine=engine, inject=inject, csp=csp, host='live', resetlog='1')))


class Run:
    """One scenario: a fresh browser context, request capture and step bookkeeping."""

    def __init__(self, browser, sc):
        self.sc = sc
        self.out = dict(id=sc['id'], note=sc['note'], steps=[], console=[])
        self.problems = []
        self.requests = []
        self.ctx = browser.new_context(viewport={'width': 1500, 'height': 2400}, accept_downloads=True)
        self.ctx.on('request', self._on_request)
        self.failed = {}
        self.ctx.on('requestfailed', lambda req: self.failed.__setitem__(req.url, req.failure or ''))
        self.page = self.ctx.new_page()
        self.page.on('console', lambda m: self.out['console'].append(f'{m.type}: {m.text}'[:300]))
        self.page.on('pageerror', lambda e: self.out['console'].append(f'pageerror: {e}'[:300]))
        self.t0 = time.time()

    def _on_request(self, req):
        try:
            body = req.post_data_buffer
        except Exception:
            body = None
        self.requests.append(dict(method=req.method, url=req.url, body=len(body) if body else 0, pdf=bool(body and b'%PDF' in body), type=req.resource_type))

    def check(self, cond, what):
        self.out['steps'].append(('OK   ' if cond else 'FAIL ') + what)
        if not cond:
            self.problems.append(what)
        return cond

    def ev(self, js, arg=None):
        return self.page.evaluate(js, arg) if arg is not None else self.page.evaluate(js)

    def hook(self, expr, arg=None):
        return self.ev(f'(a) => window.__phase10Corpus.{expr}', arg) if arg is not None else self.ev(f'() => window.__phase10Corpus.{expr}')

    def open(self):
        self.page.goto(BASE + PAGE, wait_until='load')
        self.page.wait_for_function("() => !document.getElementById('privacyStatus').textContent.startsWith('Checking')", timeout=60000)

    def preflight(self):
        self.page.click('#start')
        self.page.wait_for_function("() => document.getElementById('preflightReport').textContent !== 'Not run.' && !document.getElementById('start').disabled", timeout=180000)
        return self.page.inner_text('#readyStatus').strip()

    def load(self, paths):
        if self.page.is_disabled('#files'):
            raise RuntimeError('file input is disabled (corpus processing not ready)')
        self.page.set_input_files('#files', paths)
        self.page.wait_for_function("() => { const t = document.getElementById('loadStatus').textContent; return (t.startsWith('Analysed') || t.startsWith('Stopped') || t.startsWith('Corpus processing disabled')) && !window.__phase10Corpus.state().busy; }", timeout=600000)
        self.page.wait_for_timeout(200)
        self.page.wait_for_function("() => !window.__phase10Corpus.state().busy", timeout=300000)
        return self.page.inner_text('#loadStatus')

    def state(self):
        return self.hook('state()')

    def doc(self, name):
        for d in self.state()['docs']:
            if d['name'] == name:
                return d
        return None

    def show(self, doc_id):
        self.ev('(id) => window.__phase10Corpus.showDocument(id)', doc_id)
        self.page.wait_for_function("() => !window.__phase10Corpus.state().busy", timeout=300000)

    def show_page(self, i):
        v = self.hook('view()')
        if v and v['pageIndex'] == i:
            return
        self.page.select_option('#pageSel', str(i))
        self.page.wait_for_function("(i) => { const v = window.__phase10Corpus.view(); return v && v.pageIndex === i && !window.__phase10Corpus.state().busy; }", arg=i, timeout=300000)

    def click_text(self, text):
        self.page.locator('#pageWrap').scroll_into_view_if_needed()
        pt = self.ev('(t) => window.__phase10Corpus.pointFor(t)', text)
        if not pt:
            raise RuntimeError(f'no point for {text!r}')
        self.page.mouse.click(pt['x'], pt['y'])
        self.page.wait_for_timeout(200)

    def apply(self, text):
        self.page.fill('#text', text)
        self.page.click('#apply')
        self.page.wait_for_function("() => { const t = document.getElementById('result').textContent; return !t.startsWith('Analyse ->') && t !== '-' && !window.__phase10Corpus.state().busy; }", timeout=600000)
        return self.page.inner_text('#result').strip()

    def finish(self, allow_errors=False, no_requests_check=False, allow_foreign=()):
        self.out['privacy'] = self.page.inner_text('#privacyStatus')
        self.out['network'] = self.page.inner_text('#networkResults')[:4000]
        server_log = http_get('/__p10/requests')
        if not no_requests_check:
            bad = [r for r in self.requests if r['method'] not in ('GET', 'HEAD') or r['body'] or r['pdf']]
            self.check(not bad, f'browser: no request with a body, no non-GET request, no PDF bytes in any request ({len(self.requests)} requests seen){": " + str(bad[:3]) if bad else ""}')
            others = [r['url'] for r in self.requests if not r['url'].startswith(BASE + '/') and not r['url'].startswith('blob:') and not r['url'].startswith('data:') and r['url'] not in allow_foreign]
            # Chromium reports a CSP-blocked request as a request that failed with reason 'csp'
            # (or ERR_BLOCKED_*); it never reaches the network (the server log below confirms it).
            blocked = [u for u in others if str(self.failed.get(u, '')).lower() == 'csp' or 'blocked' in str(self.failed.get(u, '')).lower()]
            foreign = [u for u in others if u not in blocked]
            self.check(not foreign, f'browser: every request stayed on {BASE}{f" ({len(blocked)} cross-origin attempt(s) blocked by CSP before the network)" if blocked else ""} {foreign[:3] if foreign else ""}')
            srv_foreign = [x for x in server_log if not x['host'].startswith(f'localhost:{PORT}') and x['path'] not in [urllib.parse.urlparse(u).path for u in allow_foreign]]
            self.check(not srv_foreign, f'server: no request arrived through another origin {srv_foreign[:3] if srv_foreign else ""}')
            sbad = [r for r in server_log if r['method'] not in ('GET', 'HEAD') or r['bodyBytes'] or r['pdfLike']]
            self.check(not sbad, f'server: {len(server_log)} request(s) received, none with a body or PDF bytes {sbad[:3] if sbad else ""}')
        self.out['requests'] = len(self.requests)
        self.out['server_requests'] = len(server_log)
        errs = [c for c in self.out['console'] if c.startswith('pageerror') or (c.startswith('error') and not c.startswith('error: Refused to') and 'Failed to load resource' not in c)]
        if errs and not allow_errors:
            self.problems.append('console errors: ' + ' | '.join(errs[:3]))
        self.out['seconds'] = round(time.time() - self.t0, 1)
        self.out['problems'] = self.problems
        self.ctx.close()
        return self.out


# ------------------------------------------------------------------ scenarios
def c01_preflight(r):
    r.open()
    ready = r.preflight()
    r.check(ready == 'YES', f'ready {ready}')
    r.check(r.page.inner_text('#identityStatus').strip() == 'RUN #10 MATCH', 'engine identity RUN #10 MATCH')
    r.check(r.page.inner_text('#apiStatus').strip() == 'COMPLETE', 'API surface COMPLETE')
    r.check(r.page.inner_text('#pdfjsStatus').strip() == '3.11.174 PINNED', 'PDF.js 3.11.174 pinned')
    r.check(r.page.inner_text('#privacyGate').strip() == 'PASS' and r.page.inner_text('#privacyStatus').startswith('PASS'), 'privacy audit PASS')
    r.check(r.page.inner_text('#swStatus').strip() == 'none', 'no service worker')
    net = r.page.inner_text('#networkResults')
    r.check('exact Phase 10 policy' in net and 'observer active (complete)' in net and 'complete: PerformanceObserver since module start' in net, 'CSP exact, Phase 10 ledger and Phase 9 observer both complete')
    r.check(not r.page.is_disabled('#files'), 'file input enabled only after a passing preflight')


def c02_local_no_upload(r):
    r.open()
    r.check(r.page.is_disabled('#files'), 'file input disabled before preflight')
    r.preflight()
    before = len(r.requests)
    status = r.load([fixture('invoice-number-longer')])
    during = r.requests[before:]
    r.check(status.startswith('Analysed 1 PDF'), f'loaded locally ({status[:160]})')
    d = r.doc(os.path.basename(fixture('invoice-number-longer')))
    r.check(d and d['sha256'] == FX['invoice-number-longer']['sha256']['before'], 'SHA-256 computed in the page equals the file on disk')
    r.check(d and d['status'] == 'analysed' and d['summary']['supported'] == d['summary']['textObjects'] > 0, 'every text object classified SUPPORTED')
    lp = r.state()['lastProcessing']
    r.check(lp and lp['withBody'] == 0 and lp['nonGet'] == 0 and not lp['bad'], f'page ledger while processing: {lp and lp["calls"]} call(s), {lp and lp["entries"]} load(s), 0 bodies, 0 non-GET')
    r.check(all(x['method'] == 'GET' and not x['body'] for x in during), f'browser requests during processing: {len(during)}, all GET without body')
    name = os.path.basename(fixture('invoice-number-longer'))
    r.check(not any(name in x['url'] for x in r.requests), 'the file name never appears in a request URL')
    r.check('Requests while processing 1 local PDF(s)' in status and '0 with a request body' in status, 'the page reports the processing requests')


def c03_blocked(r):
    r.open()
    r.preflight()
    ids = ['blocked-signed', 'blocked-form-xobject', 'blocked-type3', 'blocked-vertical', 'blocked-glyph-missing', 'blocked-encrypted-restricted']
    r.load([fixture(i) for i in ids])
    docs = {d['name']: d for d in r.state()['docs']}
    sig = docs[FX['blocked-signed']['before']]
    objs = r.ev('(id) => window.__phase10Corpus.objects(id)', sig['id'])
    r.check('signed-document' in sig['documentReasons'] and objs and all(o['status'] == 'blocked' and 'signed-document' in o['codes'] for o in objs), 'signed: every object BLOCKED with signed-document')
    r.show(sig['id'])
    r.click_text('Invoice Number: 12345')
    r.check('signed-document' in r.page.inner_text('#reasons') and r.page.is_disabled('#apply') and r.page.is_disabled('#text'), 'signed: selected object shows the gate, edit input and apply disabled')
    form = docs[FX['blocked-form-xobject']['before']]
    r.check(form['summary']['blockReasons'].get('text-in-form-xobject', 0) >= 1 and 'text-in-form-xobject' in form['summary']['unsupportedFeatures'], 'Form XObject text counted BLOCKED (text-in-form-xobject)')
    objs = r.ev('(id) => window.__phase10Corpus.objects(id)', form['id'])
    r.check(not any(o['text'] == 'Form text 123' for o in objs), 'Form XObject text is never offered as a direct object')
    for fid, text, code in [('blocked-type3', 'abab', 'font-type3'), ('blocked-vertical', 'Vertical text', 'font-vertical')]:
        d = docs[FX[fid]['before']]
        objs = r.ev('(id) => window.__phase10Corpus.objects(id)', d['id'])
        o = next((x for x in objs if x['text'] == text), None)
        r.check(o and o['status'] == 'blocked' and code in o['codes'], f'{fid}: {text!r} BLOCKED with {code} ({o and o["codes"]})')
    enc = docs[FX['blocked-encrypted-restricted']['before']]
    r.check('encrypted-document' in enc['documentReasons'] and 'permissions-restrict-modify' in enc['documentReasons'], 'encrypted with restricted permissions: encrypted-document and permissions-restrict-modify')
    gm = docs[FX['blocked-glyph-missing']['before']]
    r.show(gm['id'])
    orig = r.ev('(id) => window.__phase10Corpus.workingSha(id)', gm['id'])
    r.click_text('Menu: Cafe')
    r.check(not r.page.is_disabled('#apply'), 'glyph-missing: the object itself is SUPPORTED')
    res = r.apply('Menu: Zoo')
    r.check(res.startswith('Blocked before mutation') and 'glyph-not-in-font-subset' in res and 'NOT replaced' in res, f'glyph-missing: edit blocked before mutation ({res[:120]})')
    r.check(r.ev('(id) => window.__phase10Corpus.workingSha(id)', gm['id']) == orig and r.page.is_disabled('#download'), 'glyph-missing: working bytes unchanged, download disabled')


def c04_rejected(r):
    r.open()
    r.preflight()
    r.load([fixture('rejected-untouched-grouping')])
    d = r.state()['docs'][0]
    orig = r.ev('(id) => window.__phase10Corpus.originalSha(id)', d['id'])
    r.click_text('Editable line')
    res = r.apply('Editable row')
    r.check(res == 'Rejected by verification. The working document was NOT replaced.', f'exact rejection message ({res[:100]})')
    checks = r.page.inner_text('#checks')
    r.check('V12' in checks and 'FAIL' in checks, 'the failing verifier (V12) is shown with every other check')
    st = r.doc(d['name'])
    r.check(r.ev('(id) => window.__phase10Corpus.workingSha(id)', d['id']) == orig and st['revision'] == 0 and not st['verified'], 'working bytes byte-identical to the source; no revision change')
    r.check(r.page.is_disabled('#download'), 'download stays disabled after a rejection')
    r.check(st['edits'] and st['edits'][-1]['status'] == 'rejected' and 'V12' in st['edits'][-1]['failedChecks'], 'the rejection is recorded in the corpus report')


def c05_commit_download(r):
    r.open()
    r.preflight()
    r.load([fixture('invoice-number-longer')])
    d = r.state()['docs'][0]
    orig = r.ev('(id) => window.__phase10Corpus.originalSha(id)', d['id'])
    r.check(r.page.is_disabled('#download'), 'download disabled before any verified commit')
    r.click_text('Invoice Number: 12345')
    r.check(r.page.input_value('#text') == 'Invoice Number: 12345', 'click on the rendered page selected the object')
    res = r.apply('Invoice Number: INV-2026-0012345')
    r.check(res.startswith('Committed') and 'SetPositions' in res, f'verified commit ({res[:120]})')
    rows = r.page.inner_text('#checks')
    want = ['V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V10', 'V11', 'V12', 'V13', 'D01', 'X01', 'D02']
    r.check(all(w in rows for w in want) and 'FAIL' not in rows, f'all {len(want)} verifier rows present and PASS')
    stages = r.page.inner_text('#stages')
    r.check(all(s in stages for s in ['analyse', 'classify', 'encode + plan', 'clone/candidate + mutate + GenerateContent + non-incremental save', 'destroy/reopen + independent verification']), 'every Phase 9 transaction stage shown')
    st = r.doc(d['name'])
    w1 = r.ev('(id) => window.__phase10Corpus.workingSha(id)', d['id'])
    r.check(st['verified'] and st['revision'] == 1 and w1 != orig, 'working copy replaced by the verified bytes')
    r.check(r.ev('(id) => window.__phase10Corpus.originalSha(id)', d['id']) == orig, 'original bytes untouched')
    r.check(not r.page.is_disabled('#download'), 'download enabled after the verified commit')
    with r.page.expect_download() as dl:
        r.page.click('#download')
    data = open(dl.value.path(), 'rb').read()
    r.check(sha(data) == w1, 'downloaded bytes equal the verified working copy')
    r.check(data.count(b'%%EOF') == 1 and b'/Prev' not in data, 'download is a single revision (one %%EOF, no /Prev)')
    r.click_text('Invoice Number: INV-2026-0012345')
    r.check(r.page.input_value('#text') == 'Invoice Number: INV-2026-0012345', 'the edited text is re-analysed and selectable')
    r.page.click('#undo')
    r.page.wait_for_function("() => document.getElementById('result').textContent.startsWith('Undone')", timeout=120000)
    r.check(r.ev('(id) => window.__phase10Corpus.workingSha(id)', d['id']) == orig and r.page.is_disabled('#download'), 'undo restores the original and disables download')


def c06_stale(r):
    r.open()
    r.preflight()
    r.load([fixture('invoice-number-longer')])
    d = r.state()['docs'][0]
    r.click_text('Invoice Number: 12345')
    old = r.hook('selection()')
    res = r.apply('Invoice Number: 555')
    r.check(res.startswith('Committed'), f'first edit committed ({res[:80]})')
    w1 = r.ev('(id) => window.__phase10Corpus.workingSha(id)', d['id'])
    out = r.ev('(s) => window.__phase10Corpus.applyWith(s, "Invoice Number: 999")', old)
    r.check(out['status'] == 'refused' and out['code'] in ('stale-selection', 'stale-revision'), f'the pre-commit selection is refused ({out})')
    r.check(r.page.inner_text('#result').startswith('Refused') and 'NOT replaced' in r.page.inner_text('#result'), 'refusal shown')
    r.check(r.ev('(id) => window.__phase10Corpus.workingSha(id)', d['id']) == w1, 'working bytes unchanged by the stale attempt')


def c07_new_load_invalidates(r):
    r.open()
    r.preflight()
    r.load([fixture('invoice-number-longer')])
    a = r.state()['docs'][0]
    r.click_text('Invoice Number: 12345')
    sel = r.hook('selection()')
    gen = r.state()['generation']
    r.load([fixture('cid-greek')])
    st = r.state()
    r.check(st['generation'] == gen + 1 and st['selection'] is None, 'loading a new PDF bumps the generation and clears the selection')
    out = r.ev('(s) => window.__phase10Corpus.applyWith(s, "Invoice Number: 1")', sel)
    r.check(out['status'] == 'refused' and out['code'] == 'stale-generation', f'the old selection cannot commit ({out})')
    r.check(r.doc(a['name'])['revision'] == 0 and r.doc(a['name'])['workingSha'] == a['sha256'], 'the first document is untouched')


def c08_intake_failures(r):
    r.open()
    r.preflight()
    r.load([synthetic('p10-malformed.pdf'), synthetic('p10-not-a-pdf.pdf'), synthetic('p10-password.pdf')])
    docs = {d['name']: d for d in r.state()['docs']}
    r.check(docs['p10-malformed.pdf']['status'] == 'failed' and docs['p10-malformed.pdf']['intake'][0] in ('malformed-pdf', 'document-open-failed'), f'malformed PDF fails closed ({docs["p10-malformed.pdf"]["intake"]})')
    r.check(docs['p10-not-a-pdf.pdf']['intake'] == ['pdf-header-missing'], 'non-PDF fails closed (pdf-header-missing)')
    r.check(docs['p10-password.pdf']['intake'] == ['password-required'], 'user-password PDF fails safely (password-required)')
    r.show(docs['p10-password.pdf']['id'])
    r.check(r.page.is_disabled('#apply') and r.page.is_disabled('#pageSel') and r.page.is_disabled('#download'), 'nothing to inspect or edit on a failed file')
    r.check(r.page.inner_text('#privacyStatus').startswith('PASS'), 'privacy audit still PASS')


def c09_multi_isolation(r):
    r.open()
    r.preflight()
    r.load([fixture('invoice-number-longer'), fixture('invoice-total-shorter'), fixture('cid-greek')])
    docs = r.state()['docs']
    r.check(len(docs) == 3 and all(d['status'] == 'analysed' for d in docs), 'three documents analysed separately')
    a, b, c = docs
    r.show(a['id'])
    r.click_text('Invoice Number: 12345')
    sel_a = r.hook('selection()')
    r.show(b['id'])
    out = r.ev('(s) => window.__phase10Corpus.applyWith(s, "Invoice Number: 1")', sel_a)
    r.check(out['status'] == 'refused', f'a selection from document A cannot commit while B is active ({out})')
    r.show(a['id'])
    r.click_text('Invoice Number: 12345')
    res = r.apply('Invoice Number: 2468')
    r.check(res.startswith('Committed'), 'edit on A committed')
    st = {d['id']: d for d in r.state()['docs']}
    r.check(st[b['id']]['workingSha'] == b['sha256'] and st[b['id']]['revision'] == 0 and not st[b['id']]['edits'], 'B (same bytes as A) is untouched')
    r.check(st[c['id']]['workingSha'] == c['sha256'] and st[c['id']]['revision'] == 0, 'C is untouched')
    r.show(b['id'])
    r.check(r.page.is_disabled('#download'), 'download disabled for B')
    r.check(r.page.inner_text('#sEdits').strip() == '1 of 1', 'session summary counts one successful edit test')


def c10_multipage(r):
    r.open()
    r.preflight()
    r.load([synthetic('p10-multipage.pdf'), synthetic('p10-multipage-graphics.pdf')])
    docs = {d['name']: d for d in r.state()['docs']}
    d = docs['p10-multipage.pdf']
    r.check(d['summary']['pages'] == 3 and d['summary']['pagesAnalysed'] == 3, 'three pages analysed')
    r.check('Microsoft Word' in r.page.inner_text('#sessionReport'), 'generator family from metadata')
    r.show(d['id'])
    r.show_page(2)
    view = r.hook('view()')
    r.check(view['records'] and all(x['status'] == 'blocked' and 'page-rotation-not-validated' in x['codes'] for x in view['records']), 'rotated page 3 blocked')
    r.show_page(1)
    orig = r.ev('(id) => window.__phase10Corpus.workingSha(id)', d['id'])
    r.click_text('Reference code ABC-123')
    res = r.apply('Reference code XYZ-98765')
    rows = r.page.inner_text('#checks')
    # Known Phase 9 verifier behaviour (not relaxed): V11 only sees the edited page's streams.
    r.check(res == 'Rejected by verification. The working document was NOT replaced.', f'text on the other pages: rejected by verification ({res[:80]})')
    fails = [ln.split('\t')[0] for ln in rows.splitlines() if ln.rstrip().endswith('FAIL')]
    r.check(fails == ['V11'], f'only V11 fails (page-scoped reference set); D01, X01, D02 and V01..V13 otherwise pass ({fails})')
    r.check('V11 in multi-page documents' in r.page.inner_text('#reasons'), 'the page explains the V11 multi-page limitation')
    r.check(r.ev('(id) => window.__phase10Corpus.workingSha(id)', d['id']) == orig and r.page.is_disabled('#download'), 'working bytes unchanged; download disabled')
    g = docs['p10-multipage-graphics.pdf']
    r.show(g['id'])
    r.show_page(1)
    r.click_text('Reference code ABC-123')
    res = r.apply('Reference code XYZ-98765')
    r.check(res.startswith('Committed'), f'other pages without text: edit on page 2 committed ({res[:100]})')
    rows = r.page.inner_text('#checks')
    r.check('D01' in rows and 'D02' in rows and rows.count('2 other page(s) identical') >= 2 and 'FAIL' not in rows, 'D01 (PDFium) and D02 (render) prove both other pages unchanged')
    r.check(not r.page.is_disabled('#download'), 'download enabled for the verified multi-page result')


def c11_injected_after(r):
    configure(inject='after')
    r.open()
    ready = r.preflight()
    r.check(ready == 'YES', f'host-style scripts after the CSP meta are blocked; still ready ({ready})')
    a = r.hook('audit()')
    r.check(a['pass'], f'audit PASS ({a["fail"][:2]})')
    net = r.page.inner_text('#networkResults')
    r.check('WARN' in net and 'blocked' in net, 'blocked injections are reported as warnings')
    r.check(not r.ev('() => !!window.__monitorRan || !!window.__inlineInjected'), 'no injected script executed')
    r.load([fixture('invoice-number-longer')])
    r.check(r.state()['docs'][0]['status'] == 'analysed', 'processing still works')
    arrived = [x for x in http_get('/__p10/requests') if x['host'].startswith('127.0.0.1')]
    r.check(not arrived, f'the injected cross-origin script never reached the network (server saw {len(arrived)} request(s) via 127.0.0.1)')


def c12_injected_before(r):
    configure(inject='before')
    r.open()
    ready = r.preflight()
    r.check(ready == 'NO', 'script before the CSP meta: not ready')
    r.check(r.page.inner_text('#privacyStatus').startswith('FAIL') and r.page.is_disabled('#files'), 'privacy FAIL; file input disabled')


def c13_service_worker(r):
    r.page.goto(BASE + '/__p10/sw-install.html', wait_until='load')
    r.page.wait_for_function("() => document.title === 'sw ready' || document.title.startsWith('sw failed')", timeout=30000)
    r.check(r.page.title() == 'sw ready', f'harness service worker installed ({r.page.title()})')
    r.open()
    r.check(r.ev('() => !!navigator.serviceWorker.controller'), 'the page is controlled by the service worker')
    ready = r.preflight()
    r.check(ready == 'NO' and r.page.inner_text('#swStatus').startswith('CONTROLLING'), f'service worker control fails the preflight ({ready})')
    r.check('service worker controls this page' in r.page.inner_text('#networkResults') and r.page.is_disabled('#files'), 'reported; corpus processing disabled')


def c14_engine_mismatch(r):
    configure(engine='stock')
    r.open()
    ready = r.preflight()
    r.check(ready == 'NO' and r.page.inner_text('#identityStatus').strip() == 'MISMATCH', 'engine bytes that are not Run #10 are refused')
    r.check(r.page.is_disabled('#files'), 'file input disabled')


def c15_export(r):
    r.open()
    r.preflight()
    r.check(not r.page.is_checked('#optGen') and not r.page.is_checked('#optNames') and r.page.input_value('#optSamples') == 'none', 'export options default to: no raw Producer/Creator, no file names, no samples')
    r.load([fixture('invoice-number-longer'), fixture('blocked-signed'), synthetic('p10-xref-stream.pdf')])
    d0 = r.state()['docs'][0]
    r.show(d0['id'])
    r.click_text('Invoice Number: 12345')
    r.apply('Invoice Number: 31337')
    with r.page.expect_download() as dl:
        r.page.click('#export')
    raw = open(dl.value.path(), 'rb').read()
    rep = json.loads(raw.decode('utf-8'))
    r.check(rep['schema'] == 'noblepdf-phase10-corpus-report/2' and len(rep['documents']) == 3, 'export schema and document count')
    # Exact raw Producer/Creator values of p10-xref-stream.pdf. (A bare "Mozilla/5.0" would also
    # match the tester's own browser user agent, which environment.userAgent reports on purpose.)
    leaks = [x for x in ['Invoice Number', 'Jane Citizen', 'Consulting', '31337', 'invoice-number-longer', 'blocked-signed', 'p10-xref-stream', '%PDF', 'Skia/PDF m128', 'Mozilla/5.0 Chrome/128.0.0.0'] if x.encode() in raw]
    r.check(not leaks, f'default export has no text, no file names, no PDF bytes and no raw Producer/Creator ({leaks})')
    r.check(rep['privacy']['generatorStrings'] is False and rep['documents'][2]['generator'] == {'family': 'Chrome print (Skia)'}, 'generator family exported by default; raw strings withheld')
    first = rep['documents'][0]
    r.check(first['sha256'] == FX['invoice-number-longer']['sha256']['before'] and first['summary']['textObjects'] > 0 and first['editTests'][0]['status'] == 'committed', 'hashes, counts and edit results are exported')
    r.check(rep['environment']['privacyAudit'] is True and rep['environment']['engine']['run10'] is True, 'environment verdicts are exported')
    r.page.select_option('#optSamples', 'redacted')
    with r.page.expect_download() as dl:
        r.page.click('#export')
    red = open(dl.value.path(), 'rb').read()
    r.check(b'Aaaaaaa Aaaaaa: 99999' in red and b'Invoice Number' not in red and b'Skia/PDF' not in red, 'redacted samples keep only the text shape; still no raw Producer/Creator')
    r.page.check('#optGen')
    with r.page.expect_download() as dl:
        r.page.click('#export')
    gen = json.loads(open(dl.value.path(), 'rb').read().decode('utf-8'))
    r.check(gen['privacy']['generatorStrings'] is True and gen['documents'][2]['generator'].get('producer') == 'Skia/PDF m128', 'raw Producer/Creator only after explicit opt-in')


def c16_late_request(r):
    r.open()
    r.check(r.preflight() == 'YES', 'ready under the exact Phase 10 CSP')
    # 300 requests of one pinned URL in its exact allowed form (no cache): completeness, not a query loophole.
    r.ev("async () => { for (let i = 0; i < 300; i++) await (await fetch('./phase10.css?v=1', { cache: 'no-store' })).arrayBuffer(); }")
    a = r.hook('audit()')
    r.check(a['pass'] and a['ledger']['entries'] > 300 and a['ledger']['calls'] > 300, f'after 300 extra requests of a pinned URL in its exact form the ledger sees all of them and passes ({a["ledger"]})')
    late = f'{BASE}/lab/true-text-edit/not-a-pinned-file.txt?late=1'
    r.ev("async (u) => { try { await (await fetch(u, { cache: 'no-store' })).arrayBuffer(); } catch (e) { /* 404 is fine */ } }", late)
    a = r.hook('audit()')
    r.check(not a['pass'] and any('not-a-pinned-file.txt' in f for f in a['fail']), f'a late request outside the pinned file list fails the audit ({[f for f in a["fail"] if "not-a-pinned" in f][:1]})')
    r.check(r.page.is_disabled('#files'), 'corpus processing disabled')


def c18_relaxed_csp(r):
    configure(csp='img-relaxed')
    r.open()
    r.check(r.page.inner_text('#privacyStatus').startswith('FAIL') and 'CSP is not the Phase 10 policy' in r.page.inner_text('#networkResults'), 'a relaxed CSP (img-src with a foreign origin) fails the exact-CSP check at load')
    r.check(r.preflight() == 'NO' and r.page.is_disabled('#files'), 'not ready; file input disabled')
    late = f'http://127.0.0.1:{PORT}/__p10/pixel.png?late=1'
    loaded = r.ev("(u) => new Promise((res) => { const i = new Image(); i.onload = () => res('load'); i.onerror = () => res('error'); i.src = u; })", late)
    a = r.hook('audit()')
    r.check(loaded == 'load' and any(late in f for f in a['fail']), f'a cross-origin load that this CSP allowed is also named by the audit ({loaded})')


def c19_host_files(r):
    """Every Phase 10 deploy file and every file it requires, fetched from the page through the
    emulated live host (403 for every *.json URL), must return 200 with its pinned SHA-256."""
    r.open()
    pins = []
    unpinned = []
    for lst in ('phase10-deploy-files.txt', 'phase10-required-unchanged.txt'):
        for line in open(os.path.join(PKG, 'deploy', lst), encoding='ascii'):
            if line.strip():
                want, rel = line.split()
                if not re.fullmatch(r'[0-9a-f]{64}', want):
                    unpinned.append(rel)
                if rel.startswith('lab/'):
                    pins.append((want, rel))
    r.check(not unpinned, f'every Phase 10 list entry is pinned by SHA-256, none as ANY {unpinned}')
    r.check(not any(rel.endswith('/phase8.css') for _, rel in pins), 'phase8.css is in neither Phase 10 list')
    got = r.ev("""async (urls) => {
      const out = [];
      for (const u of urls) {
        const res = await fetch(u, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
        const b = new Uint8Array(await res.arrayBuffer());
        const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('');
        out.push({ u, status: res.status, sha: h });
      }
      return out;
    }""", ['/' + rel for _, rel in pins])
    bad = [f"{g['u']} HTTP {g['status']}" for g, (want, _) in zip(got, pins) if g['status'] != 200 or g['sha'] != want]
    r.check(len(pins) == 20 and not bad, f'{len(pins)} lab files (9 Phase 10 deploy + 11 required) served with their pinned SHA-256 through the emulated live host {bad[:4] if bad else ""}')


def c17_upload_refused(r):
    r.open()
    r.preflight()
    out = r.ev("""async () => {
      const res = {};
      try { await fetch('./phase10.css', { method: 'POST', body: new Uint8Array([37, 80, 68, 70]) }); res.post = 'sent'; } catch (e) { res.post = 'refused'; }
      try { await fetch('./phase10.css', { method: 'PUT' }); res.put = 'sent'; } catch (e) { res.put = 'refused'; }
      try { const x = new XMLHttpRequest(); x.open('POST', './phase10.css'); x.send('%PDF-1.7'); res.xhr = 'sent'; } catch (e) { res.xhr = 'refused'; }
      res.beacon = navigator.sendBeacon('./phase10.css', '%PDF-1.7') ? 'sent' : 'refused';
      try { new WebSocket('ws://localhost:1/'); res.ws = 'opened'; } catch (e) { res.ws = 'refused'; }
      return res;
    }""")
    r.check(out == dict(post='refused', put='refused', xhr='refused', beacon='refused', ws='refused'), f'upload attempts refused in the page ({out})')
    a = r.hook('audit()')
    r.check(not a['pass'] and any('refused' in f for f in a['fail']), 'refused attempts fail the audit and disable processing')
    r.check(r.page.is_disabled('#files'), 'file input disabled')


IMAGE_JS = "(u) => new Promise((res) => { const i = new Image(); i.onload = () => res('load'); i.onerror = () => res('error'); i.src = u; })"


def c20_favicon(r):
    """The page declares one pinned favicon; loading it the way a browser does keeps the audit
    at PASS. The implicit /favicon.ico (what live Chrome requested for the Phase 9 pages, which
    declare no icon) and unpinned icon URLs fail the audit and disable processing."""
    r.open()
    icons = r.ev("() => [...document.querySelectorAll('link[rel~=icon]')].map((l) => l.getAttribute('href'))")
    r.check(icons == ['phase10-favicon.png?v=1'], f'exactly one declared icon, the pinned phase10-favicon.png?v=1 ({icons})')
    r.check(r.preflight() == 'YES', 'ready')
    href = r.ev("() => document.querySelector('link[rel~=icon]').href")
    r.check(r.ev(IMAGE_JS, href) == 'load', 'the declared icon loads (same-origin, allowed by img-src self)')
    pin = [ln.split()[0] for ln in open(os.path.join(PKG, 'deploy', 'phase10-deploy-files.txt'), encoding='ascii') if ln.strip().endswith('lab/true-text-edit/phase10-favicon.png')]
    got = r.ev("""async (u) => { const b = new Uint8Array(await (await fetch(u, { cache: 'no-store' })).arrayBuffer()); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join(''); }""", href)
    r.check(pin and got == pin[0], f'the served icon has its pinned SHA-256 ({got[:16]}...)')
    a = r.hook('audit()')
    r.check(a['pass'], f'the pinned icon request is allowed by the exact URL policy ({a["fail"][:2]})')
    r.check(not any(x['url'].endswith('/favicon.ico') for x in r.requests), 'no implicit /favicon.ico request while an icon is declared')
    for u in ['/favicon.ico', 'phase10-favicon.png?v=2', 'other-favicon.png?v=1']:
        r.ev(IMAGE_JS, u)
    a = r.hook('audit()')
    named = {u: any(u in f for f in a['fail']) for u in ['/favicon.ico', 'phase10-favicon.png?v=2', 'other-favicon.png?v=1']}
    r.check(not a['pass'] and all(named.values()), f'unpinned icon URLs fail the audit and are named ({named})')
    r.check(r.page.is_disabled('#files'), 'corpus processing disabled')


def c21_query_privacy(r):
    """A query string can carry data to the server even on an allowed file. Only the exact
    query of each pinned URL is accepted; anything else fails closed, whether it is seen as a
    fetch call or only through Resource Timing."""
    r.open()
    r.check(r.preflight() == 'YES', 'ready')
    r.ev("async () => { await (await fetch('./phase10.css?secret=JaneCitizen', { cache: 'no-store' })).arrayBuffer(); }")
    a = r.hook('audit()')
    hit = [f for f in a['fail'] if 'secret=JaneCitizen' in f]
    r.check(not a['pass'] and hit and 'unexpected query' in hit[0], f'phase10.css?secret=JaneCitizen fails the audit as an unexpected query ({hit[:1]})')
    r.check(r.page.is_disabled('#files') and r.page.inner_text('#privacyStatus').startswith('FAIL'), 'corpus processing disabled')
    probes = {
        'fetch %PDF value': './phase10.css?data=%25PDF-1.7',
        'fetch fixture text': './phase10.css?q=Invoice%20Number%3A%2012345',
        'fetch extra key': './phase10.css?v=1&x=1',
        'fetch other version': './phase10.css?v=2',
        'engine nonce not hex': '/vendor/pdfium-2.15.1-setpositions/index.js?te=patched-NOTHEXNOTHEX',
        'PDF.js with a query': '/vendor/pdfjs-3.11.174/pdf.min.js?x=1',
    }
    for u in probes.values():
        r.ev("async (u) => { try { await (await fetch(u, { cache: 'no-store' })).arrayBuffer(); } catch (e) { /* 404 is fine */ } }", u)
    img = 'phase10-favicon.png?leak=Jane%20Citizen'
    r.ev(IMAGE_JS, img)  # seen only by Resource Timing, not by the fetch/XHR ledger
    a = r.hook('audit()')
    missing = [k for k, u in probes.items() if not any(u.lstrip('.') in f for f in a['fail'])]
    r.check(not missing, f'every query outside the policy is named in the audit (missing: {missing})')
    r.check(any('leak=Jane%20Citizen' in f and 'unexpected query' in f for f in a['fail']), 'a query seen only through Resource Timing (image load) fails too')
    srv = [x for x in http_get('/__p10/requests') if 'secret=' in x['query'] or 'leak=' in x['query']]
    r.check(len(srv) >= 2, f'the harness server did receive those query strings ({len(srv)}): exactly why the policy must refuse them')


def c22_self_contained_styles(r):
    """The live phase8.css is not the a3f9038 build. The Phase 10 page must not depend on it:
    it loads its own phase10-base.css (the byte copy of the frozen a3f9038 phase8.css), never
    requests phase8.css, renders with the frozen styles, and a phase8.css request fails the
    exact URL policy. The emulated live host serves an 826-byte different phase8.css throughout."""
    with urllib.request.urlopen(BASE + '/lab/true-text-edit/phase8.css', timeout=10) as resp:
        live = resp.read()
    r.check(len(live) == 826 and sha(live) != FROZEN_PHASE8_CSS, f'the emulated live host serves an 826-byte phase8.css that is not the a3f9038 build ({sha(live)[:12]}...)')
    configure()  # reset the server log: the probe above is not a page request
    r.open()
    sheets = r.ev("() => [...document.styleSheets].map((s) => s.href && new URL(s.href).pathname.split('/').pop() + new URL(s.href).search)")
    r.check(sheets == ['phase10-base.css?v=1', 'phase9.css?v=1', 'phase10.css?v=1'], f'the page applies exactly phase10-base.css, phase9.css, phase10.css ({sheets})')
    r.check(r.preflight() == 'YES', 'ready (engine, PDF.js, CSP, network) with the different live phase8.css on the host')
    style = r.ev("() => ({ bg: getComputedStyle(document.body).backgroundColor, radius: getComputedStyle(document.querySelector('.card')).borderTopLeftRadius, brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() })")
    r.check(style['bg'] == 'rgb(246, 248, 252)' and style['radius'] == '18px' and style['brand'] == '#5a45d6', f'the frozen a3f9038 styles apply (from phase10-base.css), not the live phase8.css ({style})')
    got = r.ev("""async () => { const b = new Uint8Array(await (await fetch('./phase10-base.css?v=1', { cache: 'no-store' })).arrayBuffer()); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join(''); }""")
    r.check(got == FROZEN_PHASE8_CSS, f'phase10-base.css is served byte-identical to the a3f9038 phase8.css ({got[:12]}...)')
    r.check(r.hook('audit()')['pass'], 'audit PASS: every request so far is inside the exact URL policy')
    r.check(not any('/phase8.css' in x['url'] for x in r.requests), f'the browser never requested phase8.css ({len(r.requests)} requests)')
    r.check(not any(x['path'].endswith('/phase8.css') for x in http_get('/__p10/requests')), 'the server never received a phase8.css request from the page')
    r.ev("async () => { await (await fetch('./phase8.css?v=2', { cache: 'no-store' })).arrayBuffer(); }")
    a = r.hook('audit()')
    hit = [f for f in a['fail'] if 'phase8.css?v=2' in f]
    r.check(not a['pass'] and hit and 'outside the pinned file list' in hit[0], f'a phase8.css?v=2 request (the Phase 9 URL) fails the audit: not in the Phase 10 allowlist ({hit[:1]})')
    r.check(r.page.is_disabled('#files'), 'corpus processing disabled')


def c23_clip_ui(r):
    """Phase 10B through the UI: a page-size clip is shown as proven irrelevant and the edit
    commits with every check including K01, X01 and D02; a clip that cuts the text blocks the
    object; a replacement that would cross its clip is blocked before mutation."""
    r.open()
    r.preflight()
    r.load([synthetic('p10b-page-clip.pdf'), synthetic('p10b-cut.pdf'), synthetic('p10b-tight.pdf')])
    docs = {d['name']: d for d in r.state()['docs']}
    pc = docs['p10b-page-clip.pdf']
    objs = r.ev('(id) => window.__phase10Corpus.objects(id)', pc['id'])
    r.check(objs and all(o['status'] == 'supported' and o['clip'] and o['clip']['verdict'] == 'contained' for o in objs), f'page clip: all {len(objs or [])} objects SUPPORTED, clip proven irrelevant')
    r.show(pc['id'])
    r.click_text('Invoice Number: 12345')
    ins = r.page.inner_text('#inspector')
    r.check('Clip geometry (Phase 10B): rectangular-known [0, 0, 612, 792]; verdict contained; PDFium and stream agree' in ins, 'inspector shows the clip geometry, the verdict and the agreement')
    res = r.apply('Invoice Number: INV-2026-0012345')
    r.check(res.startswith('Committed'), f'benign clip: verified commit ({res[:120]})')
    rows = r.page.inner_text('#checks')
    want = ['V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V10', 'V11', 'V12', 'V13', 'D01', 'K01', 'X01', 'D02']
    r.check(all(w in rows for w in want) and 'FAIL' not in rows, f'all {len(want)} checks present and PASS (K01 = clip containment after the edit)')
    cut = docs['p10b-cut.pdf']
    r.show(cut['id'])
    orig = r.ev('(id) => window.__phase10Corpus.workingSha(id)', cut['id'])
    r.click_text('Menu: Caf\u00e9 Z\u00fcrich')
    reasons = r.page.inner_text('#reasons')
    r.check('target-clipped' in reasons and 'clip-cuts-text' in reasons and r.page.is_disabled('#apply'), 'a clip that cuts the text: BLOCKED with target-clipped and clip-cuts-text, apply disabled')
    r.check(r.ev('(id) => window.__phase10Corpus.workingSha(id)', cut['id']) == orig, 'cut: working bytes unchanged')
    tight = docs['p10b-tight.pdf']
    r.show(tight['id'])
    orig = r.ev('(id) => window.__phase10Corpus.workingSha(id)', tight['id'])
    r.click_text('Invoice Number: 12345')
    r.check(not r.page.is_disabled('#apply'), 'tight clip: the object itself is inside its clip (SUPPORTED)')
    res = r.apply('Invoice Number: INV-2026-0012345')
    r.check(res.startswith('Blocked before mutation') and 'clip-candidate-outside' in res and 'NOT replaced' in res, f'a replacement crossing the clip is blocked before mutation ({res[:140]})')
    stages = r.page.inner_text('#stages')
    r.check('mutate' not in stages and 'planned replacement' in r.page.inner_text('#inspector'), 'no mutation stage ran; the planned replacement bounds are shown')
    r.check(r.ev('(id) => window.__phase10Corpus.workingSha(id)', tight['id']) == orig and r.page.is_disabled('#download'), 'tight clip: working bytes unchanged, download disabled')
    r.check(r.hook('audit()')['pass'], 'privacy audit still PASS')


GEN_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:"DejaVu Sans","Liberation Sans",Arial,sans-serif;font-size:11pt;margin:0}
h1{font-size:18pt} table{border-collapse:collapse} td,th{border:1px solid #444;padding:4pt 6pt}
</style></head><body><h1>Tax Invoice</h1><p>Invoice Number: 12345</p><p>Date: 30 September 2026</p>
<table><tr><th>Item</th><th>Amount</th></tr><tr><td>Consulting services</td><td>450.00</td></tr></table><p>Total: 570.00</p></body></html>"""


def c24_real_generator(r):
    """A real generator: Chromium prints a PDF during the test (Skia, content-area clip around
    all page content, flipped CTM). Before Phase 10B every text object was target-clipped;
    now the page clip is proven irrelevant, and the export carries the clip facts, no text."""
    path = os.path.join(INPUTS, 'p10b-chromium-print.pdf')
    gen = r.ctx.browser.new_context()
    try:
        gp = gen.new_page()
        gp.set_content(GEN_HTML)
        gp.pdf(path=path, format='A4', margin={'top': '20mm', 'bottom': '20mm', 'left': '18mm', 'right': '18mm'})
    finally:
        gen.close()
    raw = open(path, 'rb').read()
    r.check(raw.startswith(b'%PDF') and b'Skia/PDF' in raw, f'Chromium printed a Skia PDF ({len(raw)} bytes)')
    r.open()
    r.preflight()
    r.load([path])
    d = r.state()['docs'][0]
    objs = r.ev('(id) => window.__phase10Corpus.objects(id)', d['id']) or []
    contained = [o for o in objs if o['clip'] and o['clip']['verdict'] == 'contained']
    clipped_only = [o for o in objs if o['codes'] == ['target-clipped']]
    r.check(objs and len(contained) >= 1 and all('target-clipped' not in o['codes'] for o in contained), f'{len(contained)} of {len(objs)} text objects sit inside the page clip, and none of them is blocked by it')
    r.check(not clipped_only, f'no object is blocked by target-clipped alone ({len(clipped_only)})')
    sm = d['summary']
    r.check(sm['supported'] >= 1, f'real Chromium PDF: {sm["supported"]} supported, {sm["blocked"]} blocked, {sm["unknown"]} unknown; reasons {dict(list(sm["blockReasons"].items())[:6])}')
    ex = r.ev('() => window.__phase10Corpus.exportReport()')
    blob = json.dumps(ex)
    eo = ex['documents'][0]['objects']
    r.check(all('clip' in o for o in eo) and any(o['clip'] and o['clip']['verdict'] == 'contained' and o['clip']['effectiveRect'] for o in eo), 'export: clip facts per object (kind, rectangle, verdict)')
    r.check('Invoice Number' not in blob and 'Consulting' not in blob and 'p10b-chromium-print' not in blob, 'export: no text and no file name by default')


SCENARIOS = [
    dict(id='C01', run=c01_preflight, note='Preflight: Run #10 identity, API, pinned PDF.js, exact CSP, complete network ledger, no service worker'),
    dict(id='C02', run=c02_local_no_upload, note='Local file path: <input type=file> -> File.arrayBuffer -> analysis; no request with a body; file name never sent'),
    dict(id='C03', run=c03_blocked, note='Blocked fixtures loaded together: signed, Form XObject, Type3, vertical, encrypted stay blocked; missing-glyph edit blocked before mutation'),
    dict(id='C04', run=c04_rejected, note='Verifier rejection: exact message, V12 shown, working bytes identical, download disabled'),
    dict(id='C05', run=c05_commit_download, note='Successful verified edit: every stage and verifier shown, download enabled and equal to the verified bytes, undo'),
    dict(id='C06', run=c06_stale, note='Stale selection/revision cannot commit'),
    dict(id='C07', run=c07_new_load_invalidates, note='Loading a new PDF invalidates earlier selections'),
    dict(id='C08', run=c08_intake_failures, note='Malformed, non-PDF and password-protected files fail closed'),
    dict(id='C09', run=c09_multi_isolation, note='Three PDFs (two with identical bytes): no state leaks between documents'),
    dict(id='C10', run=c10_multipage, note='Multi-page: rotated page blocked; with text on other pages the edit is rejected by Phase 9 V11 (page-scoped, not relaxed); with graphics-only other pages it commits with D01/D02'),
    dict(id='C11', run=c11_injected_after, note='Host-style scripts after the CSP meta: blocked, reported, processing still verified and local'),
    dict(id='C12', run=c12_injected_before, note='Script before the CSP meta: fails closed'),
    dict(id='C13', run=c13_service_worker, note='A service worker controlling the page: fails closed'),
    dict(id='C14', run=c14_engine_mismatch, note='Engine bytes that are not Run #10: fails closed'),
    dict(id='C15', run=c15_export, note='Report export: no text, file names, PDF bytes or raw Producer/Creator by default; redacted samples and raw generator strings only on request'),
    dict(id='C16', run=c16_late_request, note='Network completeness under the exact CSP: after 300 requests of a pinned URL in its exact form, a late request outside the policy still fails the audit'),
    dict(id='C17', run=c17_upload_refused, note='Upload attempts (POST, PUT, XHR, beacon, WebSocket) are refused in the page and fail the audit'),
    dict(id='C18', run=c18_relaxed_csp, note='A relaxed CSP fails closed at load; a cross-origin load it allowed is named by the audit'),
    dict(id='C19', run=c19_host_files, note='Live-host compatibility: every Phase 10 deploy file and required lab file served with its pin through the emulated host (403 for *.json)'),
    dict(id='C20', run=c20_favicon, note='Favicon: the declared pinned icon is allowed; /favicon.ico and unpinned icons fail the audit and disable processing'),
    dict(id='C21', run=c21_query_privacy, note='Query privacy: phase10.css?secret=JaneCitizen, %PDF and fixture-text values, extra keys, wrong versions, bad engine nonces and PDF.js queries all fail closed (fetch and Resource Timing)'),
    dict(id='C22', run=c22_self_contained_styles, note='Self-contained styles: with an 826-byte live phase8.css that is not the a3f9038 build, the page uses phase10-base.css (frozen copy), never requests phase8.css, renders the frozen styles; a phase8.css request fails the audit'),
    dict(id='C23', run=c23_clip_ui, note='Phase 10B clip in the UI: page clip proven irrelevant (commit with V01..V13, D01, K01, X01, D02); a cutting clip blocks; a replacement crossing its clip is blocked before mutation'),
    dict(id='C24', run=c24_real_generator, note='Real generator: a PDF printed by Chromium (Skia) during the test; its content-area clip no longer blocks ordinary text; export carries clip facts, no text'),
]
NO_REQUEST_CHECK = {'C16', 'C17', 'C18'}  # these scenarios deliberately make the requests the check forbids
ALLOW_FOREIGN = {'C12': (f'http://127.0.0.1:{PORT}/__p10/monitor.js',)}  # the injected script before the CSP loads by design


def main():
    wanted = set(sys.argv[1:])
    scenarios = [s for s in SCENARIOS if not wanted or s['id'] in wanted]
    os.makedirs(RESULTS, exist_ok=True)
    server = start_server()
    results = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            for sc in scenarios:
                configure()
                r = Run(browser, sc)
                try:
                    sc['run'](r)
                    out = r.finish(no_requests_check=sc['id'] in NO_REQUEST_CHECK, allow_foreign=ALLOW_FOREIGN.get(sc['id'], ()))
                except Exception as e:  # a crash is a failure, never a pass
                    r.problems.append(f'harness error: {e}')
                    try:
                        out = r.finish(allow_errors=True, no_requests_check=True)
                    except Exception:
                        out = dict(id=sc['id'], note=sc['note'], steps=r.out['steps'], problems=r.problems)
                out['verdict'] = 'OK' if not out['problems'] else 'UNEXPECTED'
                results.append(out)
                ok = sum(1 for s in out.get('steps', []) if s.startswith('OK'))
                print(f"{out['id']} {out['verdict']:10} steps={ok}/{len(out.get('steps', []))} requests={out.get('requests')} {out.get('seconds')}s {'; '.join(out['problems'])[:600]}", flush=True)
            browser.close()
    finally:
        server.terminate()
    suffix = ('' if not wanted else '-' + '-'.join(sorted(wanted))) + ('-DEV' if DEV else '')
    with open(os.path.join(RESULTS, f'phase10-browser-results{suffix}.json'), 'w', encoding='utf-8') as f:
        json.dump([{k: v for k, v in x.items() if k != 'console'} | {'console': x.get('console', [])[:20]} for x in results], f, indent=1, ensure_ascii=True)
    lines = []
    for x in results:
        lines.append(f"{x['id']} [{x['verdict']}] {x['note']}")
        for s in x.get('steps', []):
            lines.append('    ' + s)
        if x['problems']:
            lines.append('    PROBLEMS: ' + '; '.join(x['problems']))
    with open(os.path.join(RESULTS, f'phase10-browser-results{suffix}.txt'), 'w', encoding='ascii', errors='backslashreplace') as f:
        f.write('\n'.join(lines) + '\n')
    bad = [x for x in results if x['verdict'] != 'OK']
    if DEV:
        print(f'PHASE 10 BROWSER DEV RUN (stock engine, not evidence): {len(bad)} unexpected')
        sys.exit(3)
    print('PHASE 10 BROWSER OK' if not bad else f'PHASE 10 BROWSER: {len(bad)} unexpected')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()

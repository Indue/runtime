// NoblePDF True Edit Phase 9 lab: browser fixture suite. ASCII only.
import { loadVerifiedEngine, RUN10 } from './te-engine.mjs?v=1';
import { runFixture, discriminationLabel } from './te-suite.mjs?v=1';
import { pdfjsLib, browserPdfjs, compareRenders, grow, union, PDFJS_PIN } from './te-render.mjs?v=1';
import { environmentAudit } from './te-env.mjs?v=2';
import { sha256Hex } from './phase8-verify.mjs?v=1';

const PAGE_VERSION = 'phase9-suite-1';
// The fixture manifest is JSON served as .txt: the live host answers 403 to every *.json URL.
const MANIFEST = Object.freeze({ url: './fixtures-phase9/manifest.txt?v=1', sha256: '9026394f2c900433e7e199ce943e509554311c324a34bea0b0fbfcb2e968eeee' });
const PATCHED_BASE = '/vendor/pdfium-2.15.1-setpositions/';
const CONTROL_FIXTURE = 'invoice-number-longer';
const $ = (id) => document.getElementById(id);
const state = { env: null, engine: null, manifest: null, pdfjs: null, report: [], running: false };

async function fetchBytes(url) {
  const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
const loadFixture = (name) => fetchBytes(`./fixtures-phase9/${encodeURIComponent(name)}?v=1`);
const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

async function showEnvironment() {
  const env = await environmentAudit({ expectedScripts: ['phase8-csp-guard.js', 'phase9-suite.js', PDFJS_PIN.lib, PDFJS_PIN.worker] });
  $('networkResults').textContent = env.lines.join('\n');
  $('privacyStatus').className = `status-line ${env.pass ? 'pass' : 'fail'}`;
  $('privacyStatus').textContent = env.pass ? `PASS - nothing cross-origin loaded, no unexpected script executed, eval blocked${env.violations ? ` (${env.violations} CSP-blocked attempt(s) recorded as warnings)` : ''}.` : `FAIL - ${env.fail.length} problem(s). The suite stays blocked.`;
  state.env = env;
  return env;
}

async function preflight() {
  $('runPreflight').disabled = true;
  const lines = [`Page ${PAGE_VERSION}; html data-phase9=${document.documentElement.dataset.phase9}`];
  try {
    const env = await showEnvironment();
    const rec = await loadVerifiedEngine({ base: PATCHED_BASE, label: 'patched', expected: RUN10, nonce: nonce() });
    lines.push(`Engine: wasm ${rec.wasmSha256} (${rec.wasmBytes} B), index.js ${rec.indexSha256}, hook calls ${rec.hookCalls}, from verified bytes ${rec.fromVerifiedBytes}`);
    if (rec.problems.length) lines.push(...rec.problems.map((p) => `FAIL  ${p}`));
    $('identityStatus').textContent = rec.ok ? 'RUN #10 MATCH' : 'MISMATCH';
    const missing = rec.engine ? rec.engine.missingApi() : ['engine not loaded'];
    $('apiStatus').textContent = missing.length ? `MISSING ${missing.length}` : 'COMPLETE';
    if (missing.length) lines.push(`FAIL  missing API: ${missing.join(', ')}`);
    const mBytes = await fetchBytes(MANIFEST.url);
    const mSha = await sha256Hex(mBytes);
    const mOk = mSha === MANIFEST.sha256;
    lines.push(`Manifest ${mSha} ${mOk ? '(pinned)' : '(DOES NOT MATCH PIN)'}`);
    state.manifest = mOk ? JSON.parse(new TextDecoder().decode(mBytes)) : null;
    $('fixtureStatus').textContent = state.manifest ? `${state.manifest.fixtures.length} pinned` : 'MISMATCH';
    state.pdfjs = browserPdfjs(pdfjsLib());
    const ready = env.pass && rec.ok && !missing.length && !!state.manifest;
    state.engine = ready ? rec.engine : null;
    $('readyStatus').textContent = ready ? 'YES' : 'NO';
    $('runSuite').disabled = !ready;
    lines.push(`Ready: ${ready ? 'YES' : 'NO'}`);
  } catch (e) {
    lines.push(`FAIL  ${e && e.message ? e.message : e}`);
    $('readyStatus').textContent = 'NO';
  }
  $('preflightReport').textContent = lines.join('\n');
  $('runPreflight').disabled = false;
}

function cell(text, cls) { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; }

async function renderChecks(fx, r) {
  const lib = pdfjsLib();
  const out = [];
  const box = grow(union(r.plan.oldBox, r.plan.newBox), 2);
  const outside = await compareRenders(lib, r.before, r.out, { pageIndex: r.plan.pageIndex, scale: 4, exclude: box });
  out.push({ id: 'X01', name: 'outside the edit: output equals the original at 288 dpi', pass: outside.ok, evidence: outside.detail });
  if (fx.reference) {
    const ref = await loadFixture(fx.reference);
    const near = await compareRenders(lib, r.out, ref, { pageIndex: r.plan.pageIndex, scale: 4, region: grow(box, 24) });
    out.push({ id: 'X02', name: 'around the edit: output equals the independent reference at 288 dpi', pass: near.ok, evidence: near.detail });
    const full = await compareRenders(lib, r.out, ref, { pageIndex: r.plan.pageIndex, scale: 2 });
    out.push({ id: 'X03', name: 'full page: output equals the independent reference at 144 dpi', pass: full.ok, evidence: full.detail });
  }
  return out;
}

async function runSuite() {
  if (state.running || !state.engine) return;
  state.running = true;
  $('runSuite').disabled = true;
  const body = $('suiteBody');
  body.textContent = '';
  const E = state.engine;
  const rows = [];
  let committed = 0;
  let failedClosed = 0;
  for (const fx of state.manifest.fixtures) {
    const tr = document.createElement('tr');
    tr.append(cell(fx.id, 'mono'), cell(fx.expect.status), cell('running...'), cell(''), cell(''), cell(''), cell(fx.title, 'small'));
    body.append(tr);
    let r;
    let renders = [];
    try {
      r = await runFixture(E, fx, loadFixture, { pdfjs: state.pdfjs });
      if (r.status === 'committed') { renders = await renderChecks(fx, r); if (renders.some((x) => !x.pass)) { r.ok = false; r.mismatch.push(...renders.filter((x) => !x.pass).map((x) => `${x.id} ${x.name}`)); } }
    } catch (e) {
      r = { ok: false, status: 'error', reasons: [], mismatch: [String(e && e.message ? e.message : e)], checks: [], ref: [] };
    }
    if (r.ok && r.status === 'committed') committed++;
    if (r.ok && r.status !== 'committed') failedClosed++;
    const why = r.status === 'committed' ? `${r.checks.length} gates + ${r.ref.length} reference checks passed` : r.reasons.map((x) => x.code).join(', ');
    tr.children[2].textContent = r.status;
    tr.children[3].textContent = discriminationLabel(r);
    tr.children[4].textContent = renders.length ? (renders.every((x) => x.pass) ? `${renders.length}/${renders.length} identical` : 'DIFFERS') : 'n/a';
    tr.children[5].textContent = r.ok ? 'PASS' : 'FAIL';
    tr.children[5].className = r.ok ? 'pass' : 'fail';
    tr.children[6].textContent = r.ok ? why : `${r.mismatch.join('; ')} | ${why}`;
    rows.push({ id: fx.id, expected: fx.expect.status, observed: r.status, ok: r.ok, disc: discriminationLabel(r), why, mismatch: r.mismatch, renders, failedChecks: (r.checks || []).filter((c) => !c.pass).map((c) => `${c.id} ${c.evidence}`) });
  }
  // Live discrimination control: with SetPositions disabled the kerned invoice edit must be rejected.
  const control = state.manifest.fixtures.find((f) => f.id === CONTROL_FIXTURE);
  const noop = Object.create(E);
  noop.setPositions = () => true;
  const c = await runFixture(E, control, loadFixture, { pdfjs: state.pdfjs, applyEngine: noop });
  const controlOk = c.status === 'rejected' && c.reasons.some((x) => x.code === 'V05');
  const tr = document.createElement('tr');
  tr.append(cell(`${CONTROL_FIXTURE} (SetPositions disabled)`, 'mono'), cell('rejected'), cell(c.status), cell(discriminationLabel(c)), cell('n/a'), cell(controlOk ? 'PASS' : 'FAIL', controlOk ? 'pass' : 'fail'), cell(`live discrimination control: ${c.reasons.map((x) => x.code).join(', ')}`, 'small'));
  body.append(tr);
  const matched = rows.filter((x) => x.ok).length;
  const pass = matched === rows.length && controlOk;
  $('matchedStatus').textContent = `${matched}/${rows.length}`;
  $('committedStatus').textContent = String(committed);
  $('blockedStatus').textContent = String(failedClosed);
  $('decisionStatus').textContent = pass ? 'PHASE 9 SUITE PASS (fixtures only)' : 'KEEP BLOCKED';
  const env = await showEnvironment();
  const lines = [
    `NoblePDF True Edit Phase 9 fixture suite - ${pass && env.pass ? 'PASS (fixtures only)' : 'BLOCKED'}`,
    `Time: ${new Date().toISOString()}  Page: ${PAGE_VERSION}  PDF.js ${state.pdfjs.version}  UA: ${navigator.userAgent}`,
    `Engine: Run #10 (pinned); manifest ${MANIFEST.sha256}`,
    `Matched ${matched}/${rows.length}; committed ${committed}; failed closed as expected ${failedClosed}; live discrimination control ${controlOk ? 'PASS' : 'FAIL'} (${c.status})`,
    `Environment: ${env.pass ? 'PASS' : 'FAIL'}; CSP-blocked attempts ${env.violations}; eval blocked ${env.evalBlocked}; service worker ${env.serviceWorker ? 'YES' : 'no'}`,
    '',
    ...rows.map((x) => `${x.ok ? 'PASS' : 'FAIL'}  ${x.id.padEnd(30)} expected ${x.expected.padEnd(9)} observed ${String(x.observed).padEnd(9)} disc ${x.disc.padEnd(14)} ${x.ok ? x.why : `${x.mismatch.join('; ')} | ${x.why}`}${x.renders.length ? ` | ${x.renders.map((q) => `${q.id} ${q.evidence}`).join(' | ')}` : ''}${x.failedChecks.length ? ` | ${x.failedChecks.join(' | ')}` : ''}`),
    '',
    ...env.lines.slice(0, 12),
  ];
  $('suiteReport').textContent = lines.join('\n');
  document.documentElement.dataset.suiteResult = pass && env.pass ? 'pass' : 'blocked';
  $('copyReport').disabled = false;
  state.running = false;
  $('runSuite').disabled = false;
}

function boot() {
  if (document.documentElement.dataset.phase9 !== 'suite-1') { $('privacyStatus').textContent = 'FAIL - page/module version mismatch (stale cache?)'; return; }
  $('runPreflight').addEventListener('click', preflight);
  $('runSuite').addEventListener('click', runSuite);
  $('copyReport').addEventListener('click', () => navigator.clipboard.writeText($('suiteReport').textContent).catch(() => {}));
  showEnvironment();
}
boot();

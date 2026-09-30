// NoblePDF True Edit (Phase 10 lab): strict privacy and integrity audit for the corpus page.
// Runs the Phase 9 audit (te-env.mjs?v=2, unchanged: CSP present and without unsafe-eval or
// inline script, every unexpected script matched by a recorded CSP violation, complete
// Resource Timing through its PerformanceObserver, eval blocked, pinned PDF.js bytes) and
// adds the Phase 10 requirements, each of which fails closed:
//  - the exact Phase 10 CSP, delivered once, before every script;
//  - the CSP recorder and the network ledger/upload guard (phase10-net-guard.js) are the
//    first two scripts and are intact;
//  - no request with a body, no method other than GET/HEAD, no refused attempt (beacon,
//    WebSocket, EventSource, upload), no cross-origin request, and no same-origin request
//    outside the exact URL policy (pinned path AND its one allowed query), from page start;
//  - no service worker controls the page (Phase 9 only warns);
//  - no analytics global exists.
// Browser only. ASCII only.
import { environmentAudit } from './te-env.mjs?v=2';
import { PDFJS_PIN } from './te-render.mjs?v=1';

export const TE_CORPUS_ENV_VERSION = 'te-corpus-env-3';
export const PHASE10_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; media-src 'none'; manifest-src 'none'";
export const PAGE_SCRIPTS = Object.freeze(['phase8-csp-guard.js', 'phase10-net-guard.js', 'phase10-corpus.js']);
export const ENGINE_BASE = '/vendor/pdfium-2.15.1-setpositions/';
// Exact URL policy: every same-origin resource the page may request, each with the ONE query
// string it is requested with. The lab files carry the exact cache-version query that the page
// and its module graph use (tests/tools/check_phase10_refs.py proves this map equals those
// references); the engine files carry "?te=patched-<12 lowercase hex>" as produced by
// loadVerifiedEngine() with the page's 6-byte nonce; PDF.js files carry no query. Anything
// else fails: unknown or extra query keys, other values, a fragment, other paths. A query can
// carry data to the server, so no value outside this policy is accepted.
export const LAB_QUERIES = Object.freeze({
  'phase8-csp-guard.js': '?v=1', 'phase10-net-guard.js': '?v=1', 'phase10-base.css': '?v=1', 'phase9.css': '?v=1', 'phase10.css': '?v=1', 'phase10-favicon.png': '?v=1', 'phase10-corpus.js': '?v=1',
  'te-engine.mjs': '?v=1', 'te-render.mjs': '?v=1', 'phase8-verify.mjs': '?v=1', 'te-corpus.mjs': '?v=1', 'te-corpus-env.mjs': '?v=1', 'te-env.mjs': '?v=2',
  'te-pipeline.mjs': '?v=1', 'te-edit.mjs': '?v=1', 'te-pdf.mjs': '?v=1', 'te-data.mjs': '?v=1', 'te-ttf.mjs': '?v=1',
});
export const ENGINE_QUERY = /^\?te=patched-[0-9a-f]{12}$/;
const ANALYTICS_GLOBALS = ['ga', 'gtag', '_gaq', 'dataLayer', 'fbq', '_fbq', '_paq', 'mixpanel', 'amplitude', 'heap', 'hj', '_hjSettings', '__insp', 'clarity', '_trfq', '_trfd', 'tccl', '_tccl', 'wsb', '_wsb', 'Sentry', 'newrelic', 'NREUM', 'analytics'];
const HOST_MONITOR = /wsimg\.com|tccl|godaddy|secureserver|traffic-?cop/i;

// Pure (no window access) so Node tests can exercise it. pageHref is the corpus page URL.
export function urlVerdict(url, pageHref, pdfjsPaths = [PDFJS_PIN.lib, PDFJS_PIN.worker]) {
  let u;
  let page;
  try { page = new URL(pageHref); u = new URL(url, pageHref); } catch (e) { return { ok: false, why: 'invalid URL' }; }
  if (u.origin !== page.origin) return { ok: false, why: `cross-origin (${u.origin})`, cross: true };
  if (u.username || u.password) return { ok: false, why: 'credentials in the URL' };
  if (u.hash) return { ok: false, why: `unexpected fragment ${JSON.stringify(u.hash.slice(0, 40))}` };
  const dir = new URL('./', page).pathname;
  const q = u.search;
  const show = JSON.stringify(q.slice(0, 60));
  if (u.pathname.startsWith(dir) && u.pathname.indexOf('/', dir.length) === -1) {
    const file = u.pathname.slice(dir.length);
    if (Object.prototype.hasOwnProperty.call(LAB_QUERIES, file)) {
      return q === LAB_QUERIES[file] ? { ok: true } : { ok: false, why: `unexpected query ${show} on ${file} (only ${LAB_QUERIES[file]} is allowed)` };
    }
  }
  if (u.pathname === `${ENGINE_BASE}index.js` || u.pathname === `${ENGINE_BASE}pdfium.wasm`) {
    return ENGINE_QUERY.test(q) ? { ok: true } : { ok: false, why: `unexpected query ${show} on the engine (only ?te=patched-<12 hex> is allowed)` };
  }
  if (pdfjsPaths.includes(u.pathname)) return q === '' ? { ok: true } : { ok: false, why: `unexpected query ${show} on PDF.js (no query is allowed)` };
  return { ok: false, why: `same-origin path outside the pinned file list (${u.pathname})` };
}

// A cross-origin Resource Timing entry counts as a blocked attempt (not a load) only when the
// CSP recorder holds a violation for the same origin and path; the same rule as te-env.mjs.
function blockedByCsp(url) {
  const g = window.__phase8Guard;
  if (!g) return false;
  return g.violations.some((v) => {
    if (!v.blocked) return false;
    try { const b = new URL(v.blocked, location.href); const u = new URL(url, location.href); return b.origin === u.origin && (b.pathname === u.pathname || b.pathname === '/'); } catch (e) { return false; }
  });
}

const classify = (url) => urlVerdict(url, location.href);

// Position in the network ledger; requestsSince(mark) lists what happened after it.
export function ledgerMark() {
  const n = window.__phase10Net;
  return n ? { calls: n.calls().length, entries: n.entries().length } : { calls: 0, entries: 0 };
}

export function requestsSince(mark) {
  const n = window.__phase10Net;
  if (!n) return { calls: [], entries: [], bad: ['network ledger missing'], blocked: [] };
  const calls = n.calls().slice(mark.calls);
  const entries = n.entries().slice(mark.entries);
  const bad = [];
  const blocked = [];
  for (const c of calls) {
    if (c.refused) bad.push(`refused ${c.kind} ${c.method} ${c.url}: ${c.refused}`);
    else if (c.body || (c.method !== 'GET' && c.method !== 'HEAD')) bad.push(`${c.kind} ${c.method} with body ${c.body} to ${c.url}`);
    else { const k = classify(c.url); if (!k.ok) bad.push(`${c.kind} ${c.url}: ${k.why}`); }
  }
  for (const e of entries) {
    const k = classify(e.name);
    if (k.ok) continue;
    if (k.cross && blockedByCsp(e.name)) blocked.push(e.name);
    else bad.push(`${e.type || 'resource'} ${e.name}: ${k.why}`);
  }
  return { calls, entries, bad, blocked, withBody: calls.filter((c) => c.body).length, nonGet: calls.filter((c) => c.method !== 'GET' && c.method !== 'HEAD').length };
}

// Cheap synchronous gate run before each file and each edit; the full audit runs around them.
export function quickCheck() {
  const fail = [];
  const n = window.__phase10Net;
  if (!n) fail.push('network ledger (phase10-net-guard.js) missing');
  else {
    if (!n.fetchIntact() || !n.xhrIntact()) fail.push('fetch or XMLHttpRequest guard was replaced');
    if (n.refused().length) fail.push(`${n.refused().length} refused network attempt(s)`);
    const since = requestsSince({ calls: 0, entries: 0 });
    if (since.bad.length) fail.push(...since.bad.slice(0, 4));
  }
  if (navigator.serviceWorker && navigator.serviceWorker.controller) fail.push('a service worker now controls this page');
  return { pass: fail.length === 0, fail };
}

export async function corpusAudit() {
  const out = { pass: true, fail: [], warn: [], lines: [], phase9: null, hostBlocked: 0, serviceWorker: false, registrations: 0, ledger: null };
  const p9 = await environmentAudit({ expectedScripts: [...PAGE_SCRIPTS, PDFJS_PIN.lib, PDFJS_PIN.worker] });
  out.phase9 = p9;
  for (const f of p9.fail) out.fail.push(`[phase 9 audit] ${f}`);
  for (const w of p9.warn) if (!/service worker controls/.test(w)) out.warn.push(`[phase 9 audit] ${w}`);
  const metas = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
  if (metas.length !== 1) out.fail.push(`${metas.length} CSP meta elements (exactly one expected)`);
  else if (metas[0].getAttribute('content') !== PHASE10_CSP) out.fail.push(`CSP is not the Phase 10 policy: ${metas[0].getAttribute('content')}`);
  const head = document.head ? [...document.head.children] : [];
  const firstScript = head.findIndex((el) => el.tagName === 'SCRIPT');
  if (metas.length && firstScript >= 0 && head.indexOf(metas[0]) > firstScript) out.fail.push('a script precedes the CSP meta element');
  const srcs = [...document.scripts].filter((s) => s.src).map((s) => new URL(s.src, location.href).pathname);
  const dir = new URL('./', location.href).pathname;
  if (srcs[0] !== `${dir}phase8-csp-guard.js` || srcs[1] !== `${dir}phase10-net-guard.js`) out.fail.push(`the CSP recorder and the network guard must be the first two scripts (found ${srcs.slice(0, 2).join(', ')})`);
  const n = window.__phase10Net;
  if (!n) out.fail.push('network ledger (phase10-net-guard.js) did not run');
  else {
    if (!n.fetchIntact() || !n.xhrIntact()) out.fail.push('the fetch or XMLHttpRequest guard was replaced after page start');
    if (!n.observerActive()) out.fail.push('PerformanceObserver unavailable: the ledger cannot prove every request was seen');
    const all = requestsSince({ calls: 0, entries: 0 });
    for (const b of all.bad) out.fail.push(`network: ${b}`);
    for (const b of all.blocked) out.warn.push(`network: cross-origin attempt blocked by CSP (matching violation recorded): ${b}`);
    out.ledger = { blockedByCsp: all.blocked.length, calls: all.calls.length, entries: all.entries.length, withBody: all.withBody, nonGet: all.nonGet, refused: n.refused().length, observer: n.observerActive(), overflowed: n.overflowed() };
  }
  out.serviceWorker = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  if (out.serviceWorker) out.fail.push(`a service worker controls this page (${navigator.serviceWorker.controller.scriptURL}); corpus processing stays disabled`);
  try {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    const covering = regs.filter((r) => location.href.startsWith(r.scope));
    out.registrations = covering.length;
    if (covering.length && !out.serviceWorker) out.warn.push(`${covering.length} service worker registration(s) cover this URL (${covering.map((r) => r.scope).join(', ')}) but do not control this load; reload with a hard refresh only`);
  } catch (e) { out.warn.push(`service worker registrations unreadable: ${e && e.message ? e.message : e}`); }
  const found = ANALYTICS_GLOBALS.filter((g) => Object.prototype.hasOwnProperty.call(window, g) && window[g] !== undefined);
  if (found.length) out.fail.push(`analytics/monitoring global(s) present: ${found.join(', ')}`);
  const guard = window.__phase8Guard;
  const violations = guard ? guard.violations.filter((v) => v.blocked !== 'eval') : [];
  out.hostBlocked = violations.filter((v) => HOST_MONITOR.test(`${v.blocked} ${v.source} ${v.sample}`)).length;
  const inlineBlocked = violations.filter((v) => /script-src/.test(v.directive) && (v.blocked === 'inline' || v.blocked === '')).length;
  out.pass = out.fail.length === 0;
  const L = out.ledger || {};
  out.lines = [
    `Phase 10 privacy audit (${TE_CORPUS_ENV_VERSION}) - ${out.pass ? 'PASS' : 'FAIL: corpus processing disabled'}`,
    `CSP: ${metas.length === 1 && metas[0].getAttribute('content') === PHASE10_CSP ? 'exact Phase 10 policy (connect-src self, form-action none, no eval, no inline script)' : 'NOT the Phase 10 policy'}`,
    `Network ledger since page start: ${L.calls ?? '?'} fetch/XHR call(s), ${L.entries ?? '?'} resource entr(ies); with a request body ${L.withBody ?? '?'}; non-GET ${L.nonGet ?? '?'}; refused ${L.refused ?? '?'}; observer ${L.observer ? 'active (complete)' : 'MISSING'}`,
    `Service worker controlling this page: ${out.serviceWorker ? 'YES (FAIL)' : 'no'}; registrations covering this URL: ${out.registrations}`,
    `Host-injected monitoring blocked by CSP: ${out.hostBlocked} attempt(s); inline scripts blocked: ${inlineBlocked}; analytics globals: ${found.length ? found.join(', ') : 'none'}`,
    `PDF.js ${PDFJS_PIN.version} pinned; engine ${ENGINE_BASE} (Run #10 hash check at start)`,
    ...out.fail.map((x) => `FAIL  ${x}`),
    ...out.warn.map((x) => `WARN  ${x}`),
    '',
    '--- Phase 9 audit (te-env.mjs?v=2) ---',
    ...p9.lines,
  ];
  return out;
}

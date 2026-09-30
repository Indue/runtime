// NoblePDF True Edit Phase 10 lab: real-PDF corpus harness page. ASCII only.
// Local only: PDFs come from <input type=file> / drag and drop and are read with
// File.arrayBuffer(); nothing is uploaded. Analysis, gates, planning, mutation and
// verification are the audited Phase 9 modules (through te-corpus.mjs). The working copy
// of a document changes only through CorpusSession.commit() of a fully verified result.
import { loadVerifiedEngine, RUN10 } from './te-engine.mjs?v=1';
import { pdfjsLib, browserPdfjs, renderToCanvas, compareRenders, grow, union, PDFJS_PIN } from './te-render.mjs?v=1';
import { sha256Hex } from './phase8-verify.mjs?v=1';
import { analyzeDocument, classifyPage, runVerifiedEdit, CorpusSession, buildExport, sessionSummary, editRecord, failedReport, MAX_FILE_BYTES, STATUS, TE_CORPUS_VERSION } from './te-corpus.mjs?v=1';
import { corpusAudit, quickCheck, ledgerMark, requestsSince, ENGINE_BASE } from './te-corpus-env.mjs?v=1';

const PAGE_VERSION = 'phase10-corpus-1';
const DISPLAY_SCALE = 1.5;
const $ = (id) => document.getElementById(id);
const S = { E: null, engine: null, pdfjs: null, ready: false, audit: null, session: new CorpusSession(), busy: false, view: null, lastResult: null, lastProcessing: null, log: [] };
const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const esc = (t) => JSON.stringify(String(t));
function cell(text, cls) { const c = document.createElement('td'); c.textContent = text === null || text === undefined ? '' : String(text); if (cls) c.className = cls; return c; }
function line(el, text, ok) { el.className = `status-line ${ok === true ? 'pass' : (ok === false ? 'fail' : '')}`; el.textContent = text; }
const statusCls = (s) => (s === STATUS.SUPPORTED ? 'sup' : s === STATUS.BLOCKED ? 'blk' : 'unk');

// ------------------------------------------------------------------ privacy / preflight
async function audit() {
  const env = await corpusAudit();
  S.audit = env;
  $('networkResults').textContent = env.lines.join('\n');
  line($('privacyStatus'), env.pass ? `PASS - exact CSP, no cross-origin or unexpected request, no request body, no unexpected script executed, no service worker, eval blocked${env.hostBlocked ? `; host monitoring blocked by CSP (${env.hostBlocked})` : ''}.` : `FAIL - ${env.fail.length} problem(s). Corpus processing is disabled.`, env.pass);
  $('privacyGate').textContent = env.pass ? 'PASS' : 'FAIL';
  $('swStatus').textContent = env.serviceWorker ? 'CONTROLLING (FAIL)' : (env.registrations ? 'registered, not controlling' : 'none');
  if (!env.pass) disableProcessing('privacy or integrity audit failed');
  return env;
}

function disableProcessing(why) {
  S.ready = false;
  $('readyStatus').textContent = 'NO';
  $('files').disabled = true;
  $('drop').setAttribute('aria-disabled', 'true');
  for (const id of ['apply', 'download', 'undo', 'reset', 'text', 'fit']) $(id).disabled = true;
  line($('loadStatus'), `Corpus processing disabled: ${why}.`, false);
}

async function preflight() {
  $('start').disabled = true;
  const lines = [`Page ${PAGE_VERSION}; module ${TE_CORPUS_VERSION}; html data-phase10=${document.documentElement.dataset.phase10}`];
  try {
    const env = await audit();
    if (!env.pass) throw new Error('privacy audit failed (see section 7)');
    const rec = await loadVerifiedEngine({ base: ENGINE_BASE, label: 'patched', expected: RUN10, nonce: nonce() });
    lines.push(`Engine: wasm ${rec.wasmSha256} (${rec.wasmBytes} B), index.js ${rec.indexSha256}, hook calls ${rec.hookCalls}, from verified bytes ${rec.fromVerifiedBytes}`);
    if (rec.problems.length) lines.push(...rec.problems.map((p) => `FAIL  ${p}`));
    $('identityStatus').textContent = rec.ok ? 'RUN #10 MATCH' : 'MISMATCH';
    const missing = rec.engine ? rec.engine.missingApi() : ['engine not loaded'];
    $('apiStatus').textContent = missing.length ? `MISSING ${missing.length}` : 'COMPLETE';
    if (missing.length) lines.push(`FAIL  missing API: ${missing.join(', ')}`);
    S.pdfjs = browserPdfjs(pdfjsLib());
    $('pdfjsStatus').textContent = `${S.pdfjs.version} PINNED`;
    const env2 = await audit();
    lines.push(`PDF.js ${S.pdfjs.version} (library and worker SHA-256 pinned, SRI on the script tag)`);
    lines.push(`Privacy audit after engine load: ${env2.pass ? 'PASS' : 'FAIL'}; network ledger ${env2.ledger ? `${env2.ledger.calls} call(s), ${env2.ledger.entries} entr(ies), bodies ${env2.ledger.withBody}` : 'missing'}`);
    const ready = env2.pass && rec.ok && !missing.length;
    S.engine = rec;
    S.E = ready ? rec.engine : null;
    S.ready = ready;
    $('readyStatus').textContent = ready ? 'YES' : 'NO';
    lines.push(`Ready: ${ready ? 'YES' : 'NO'}`);
    if (ready) {
      $('files').disabled = false;
      $('drop').setAttribute('aria-disabled', 'false');
      line($('loadStatus'), 'Ready. Choose one or more PDFs; they are read and analysed in this browser only.', true);
    } else disableProcessing('preflight failed');
  } catch (e) {
    lines.push(`FAIL  ${e && e.message ? e.message : e}`);
    $('readyStatus').textContent = 'NO';
    disableProcessing(e && e.message ? e.message : String(e));
  }
  $('preflightReport').textContent = lines.join('\n');
  $('start').disabled = false;
}

// ------------------------------------------------------------------ intake (local files only)
async function processFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length || S.busy) return;
  if (!S.ready || !S.E) { line($('loadStatus'), 'Run the preflight first.', false); return; }
  const q = quickCheck();
  if (!q.pass) { disableProcessing(q.fail.join('; ')); await audit(); return; }
  setBusy(true);
  const gen = S.session.beginLoad();
  clearSelectionUi('New PDFs loaded: previous selections are no longer valid.');
  const mark = ledgerMark();
  const quick = $('quick').checked;
  const maxPages = Number($('maxPages').value) || 0;
  const added = [];
  let stopped = '';
  for (const [i, f] of files.entries()) {
    const label = `${i + 1}/${files.length} ${f.name}`;
    let d;
    if (f.size > MAX_FILE_BYTES) {
      d = S.session.addDocument({ name: f.name, bytes: new Uint8Array(0), sha256: '' });
      d.report = failedReport(f.name, f.size, '', 'file-too-large', `${f.size} bytes (lab limit ${MAX_FILE_BYTES}); not read`);
    } else {
      line($('loadStatus'), `Reading ${label} locally (File.arrayBuffer)...`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const sha = await sha256Hex(bytes);
      d = S.session.addDocument({ name: f.name, bytes, sha256: sha });
      line($('loadStatus'), `Analysing ${label}...`);
      d.report = await analyzeDocument(S.E, d.original, { name: f.name, pdfjs: S.pdfjs, maxPages, probe: !quick, isCancelled: () => S.session.generation !== gen,
        onProgress: (done, total) => line($('loadStatus'), `Analysing ${label}: page ${done}/${total}...`) });
    }
    if (S.session.generation !== gen) { stopped = 'a newer load replaced this batch'; break; }
    added.push(d);
    renderSession();
    const qc = quickCheck();
    if (!qc.pass) { stopped = qc.fail.join('; '); break; }
  }
  const net = requestsSince(mark);
  S.lastProcessing = { files: added.length, calls: net.calls.length, entries: net.entries.length, withBody: net.withBody, nonGet: net.nonGet, bad: net.bad };
  const env = await audit();
  const netText = `Requests while processing ${added.length} local PDF(s): ${net.calls.length} fetch/XHR call(s), ${net.entries.length} resource load(s), ${net.withBody} with a request body, ${net.nonGet} non-GET${net.bad.length ? `; PROBLEMS: ${net.bad.slice(0, 3).join('; ')}` : ' (all same-origin pinned files)'}`;
  if (stopped || !env.pass || net.bad.length) {
    disableProcessing(stopped || (net.bad.length ? net.bad[0] : 'privacy audit failed after processing'));
    line($('loadStatus'), `Stopped: ${stopped || 'privacy check failed'}. ${netText}`, false);
  } else line($('loadStatus'), `Analysed ${added.length} PDF(s) locally. ${netText}.`, true);
  $('files').value = '';
  setBusy(false);
  if (added.length && S.session.generation === gen) await showDocument(added[0].id);
}

// ------------------------------------------------------------------ rendering: session and documents
function renderSession() {
  const s = sessionSummary(S.session);
  $('sDocs').textContent = `${s.documents}${s.failedIntake ? ` (+${s.failedIntake} failed intake)` : ''}`;
  $('sPages').textContent = String(s.pages);
  $('sObjects').textContent = String(s.textObjects);
  $('sSplit').textContent = `${s.supported} / ${s.blocked} / ${s.unknown}`;
  $('sEdits').textContent = `${s.committedEdits} of ${s.editTests}`;
  $('sRejected').textContent = String(s.verifierRejections);
  $('sPct').textContent = s.textObjects ? `${s.percentEditableObjects}%` : '-';
  $('sSafe').textContent = `${s.documentsWithSafeEdit} of ${s.documents}`;
  const kv = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`).join('\n') || '  -';
  $('sessionReport').textContent = [
    `Documents tested ${s.documents}; failed intake ${s.failedIntake}; pages ${s.pages}; text objects ${s.textObjects} (supported ${s.supported}, blocked ${s.blocked}, unknown ${s.unknown}); text in Form XObjects ${s.formTextShows} show(s)`,
    `Edit tests ${s.editTests}: committed (verified) ${s.committedEdits}, verifier rejections ${s.verifierRejections}, blocked before mutation ${s.blockedEdits}, failed closed ${s.failedEdits}`,
    `Percentage of detected direct text objects currently editable: ${s.percentEditableObjects}% (engineering diagnostic only; it never relaxes a gate)`,
    '', 'Top block reasons (objects):', kv(Object.fromEntries(s.topBlockReasons)),
    '', 'Font kinds (unique fonts per document):', kv(s.fontKinds),
    '', 'Generator / source (Producer, Creator metadata):', kv(s.generators),
    ...(s.failedIntake ? ['', 'Intake failures:', kv(s.intakeFailures)] : []),
  ].join('\n');
  const body = $('docsBody');
  body.textContent = '';
  for (const d of S.session.docs) {
    const r = d.report;
    if (!r) continue;
    const doc = r.doc || {};
    const st = r.structure || {};
    const tr = document.createElement('tr');
    tr.className = `clickable${S.session.active === d.id ? ' active' : ''}`;
    tr.dataset.doc = d.id;
    const enc = r.doc ? (doc.securityRevision >= 0 ? `yes (R${doc.securityRevision})` : 'no') : (r.intake.some((x) => /password|security/.test(x.code)) ? 'yes' : '?');
    tr.append(cell(d.name, 'mono'), cell(fmtBytes(r.size)), cell(r.sha256 ? `${r.sha256.slice(0, 12)}...` : '-', 'mono'), cell(st.headerVersion || '-'), cell(r.doc ? doc.pageCount : '-'), cell(enc),
      cell(r.doc ? `${doc.signatures}${st.catalog && st.catalog.sigFields ? ` (${st.catalog.sigFields} field(s))` : ''}` : '-'), cell(r.doc ? `${doc.trailerEnds ?? '?'}${st.incrementalUpdatesEstimate ? ` (${st.incrementalUpdatesEstimate} incr.)` : ''}` : '-'),
      cell(st.xrefStyle || '-'), cell(r.summary.textObjects), cell(r.summary.supported, 'sup'), cell(r.summary.blocked, 'blk'), cell(r.summary.unknown, 'unk'), cell(r.doc ? `${r.summary.percentEditableObjects}%` : '-'),
      cell(r.summary.safeEditExists ? 'YES' : 'no'), cell(r.status === 'failed' ? `FAILED CLOSED: ${r.intake.map((x) => x.code).join(', ')}` : `${r.status}${d.edits.length ? `; ${d.edits.filter((e) => e.status === 'committed').length}/${d.edits.length} edits` : ''}`));
    tr.addEventListener('click', () => { if (!S.busy) showDocument(d.id); });
    body.append(tr);
  }
  if (!body.children.length) body.innerHTML = '<tr><td colspan="16">No documents.</td></tr>';
  $('export').disabled = !S.session.docs.length;
  $('copySummary').disabled = !S.session.docs.length;
}

function documentText(d) {
  const r = d.report;
  const doc = r.doc || {};
  const st = r.structure || {};
  const c = st.catalog || {};
  const s = r.summary;
  const kv = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
  const out = [
    `Document ${d.name}  (${d.id}; loaded locally; ${fmtBytes(r.size)})`,
    `SHA-256 ${r.sha256}`,
    `Status ${r.status}${r.intake.length ? `: ${r.intake.map((x) => `${x.code} - ${x.detail}`).join('; ')}` : ''}; analysed in ${r.seconds} s`,
  ];
  if (r.doc) {
    out.push(
      `PDF version: header ${st.headerVersion || '?'}, PDFium ${doc.fileVersion || '?'}; pages ${doc.pageCount}`,
      `Encrypted: ${doc.securityRevision >= 0 ? `yes (security handler revision ${doc.securityRevision})` : 'no'}; permissions 0x${doc.permissions.toString(16)} (modify ${(doc.permissions & 8) ? 'allowed' : 'NOT allowed'})`,
      `Signatures: ${doc.signatures}${doc.signatureInfo.length ? ` [${doc.signatureInfo.map((x) => `${x.subFilter || '?'} DocMDP ${x.docMdp}`).join('; ')}]` : ''}; signature fields ${c.sigFields ?? '?'} (signed ${c.signedSigFields ?? '?'}); certified ${c.certified ? 'yes' : 'no'}`,
      `Revisions: PDFium trailer ends ${doc.trailerEnds ?? '?'}; %%EOF ${st.eofCount}; /Prev ${st.prevCount}; linearized ${st.linearized ? 'yes' : 'no'}; incremental updates (estimate) ${st.incrementalUpdatesEstimate}`,
      `Cross-reference: ${st.xrefStyle}; PDFium valid xref ${doc.validXref === null ? '?' : doc.validXref ? 'yes' : 'NO (repaired)'}; object streams ${st.objStmCount}; objects ${st.objectCount}; streams ${st.streamCount}`,
      `Catalog: AcroForm ${c.acroForm ? `yes (${c.fields} field(s))` : 'no'}; XFA ${c.xfa ? 'yes' : 'no'} (packets ${doc.xfaPackets ?? '?'}); form type ${doc.formType}; optional content ${c.optionalContent ? 'yes' : 'no'}; tagged ${doc.tagged ? 'yes' : 'no'} (StructTreeRoot ${c.structTree ? 'yes' : 'no'}); XMP ${c.xmpMetadata ? 'yes' : 'no'}; JavaScript ${c.javascript ? 'yes' : 'no'}`,
      `Generator: ${r.generator}; Producer ${esc(doc.meta.Producer || '')}; Creator ${esc(doc.meta.Creator || '')}`,
      '',
      `SUMMARY: pages ${s.pages} (analysed ${s.pagesAnalysed}, errors ${s.pagesWithErrors}, not analysed ${s.pagesNotAnalysed}); text objects ${s.textObjects}; supported ${s.supported}; blocked ${s.blocked}; unknown ${s.unknown}`,
      `Editable: ${s.percentEditableObjects}% of direct text objects, ${s.percentEditableChars}% of detected characters (Form XObject text counted as blocked). Safe True Edit exists: ${s.safeEditExists ? 'YES' : 'NO'}. (Diagnostic only.)`,
      `Document gates: ${r.documentReasons.length ? r.documentReasons.map((x) => `${x.code} (${x.detail})`).join('; ') : 'none'}`,
      `Unsupported page/document features: ${s.unsupportedFeatures.join(', ') || 'none'}`,
      `Text in Form XObjects: ${r.formText.shows} show(s), ${r.formText.pdfiumChars} character(s) - blocked (text-in-form-xobject)`,
      `Most common block reasons: ${s.topBlockReasons.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`,
      `Fonts: ${s.uniqueFonts} unique (${kv(s.fontKinds)})`,
      '',
      `TEXT STATE over ${r.objects.length} direct text objects: sizes ${kv(r.textState.sizes)} (min ${r.textState.sizeMin}, max ${r.textState.sizeMax}); Tc!=0 ${r.textState.tcNonZero}; Tw!=0 ${r.textState.twNonZero}; Tz!=100 ${r.textState.tzNot100}; rise!=0 ${r.textState.tsNonZero}`,
      `  render modes ${kv(r.textState.renderModes)}; operators ${kv(r.textState.ops)}; TJ with adjustments ${r.textState.tjWithAdjustments}; rotated ${r.textState.rotated}; skewed/mirrored ${r.textState.skewed}; non-uniform scale ${r.textState.nonUniformScale}; clipped ${r.textState.clipped}; marked content ${r.textState.marked}; unmapped ${r.textState.unmapped}`,
    );
  }
  if (d.edits.length) {
    out.push('', `EDIT TESTS (${d.edits.length}):`);
    for (const e of d.edits) out.push(`  page ${e.page + 1} object ${e.objIndex}: ${e.status}${e.codes.length ? ` [${e.codes.join(', ')}]` : ''}; ${e.checks} checks${e.failedChecks.length ? `, failed ${e.failedChecks.join(', ')}` : ''}; SetPositions ${e.discriminating === null ? 'n/a' : e.discriminating ? `needed (${e.naturalDelta} pt)` : 'not needed'}`);
  }
  return out.join('\n');
}

async function showDocument(id) {
  const d = S.session.doc(id);
  if (!d) return;
  S.session.setActive(id);
  clearSelectionUi();
  renderSession();
  const r = d.report;
  $('docTitle').textContent = `${d.name} - ${r.status}`;
  $('docReport').textContent = documentText(d);
  const fb = $('fontsBody');
  fb.textContent = '';
  for (const f of r.fonts) {
    const tr = document.createElement('tr');
    tr.append(cell(`${f.name || '(unnamed)'}`, 'mono'), cell(f.kind), cell(f.subtype === 'Type3' ? 'n/a (Type3)' : f.embedded ? 'yes' : 'no'), cell(f.subset ? 'yes' : 'no'), cell(f.encoding), cell(f.toUnicode ? 'yes' : 'no'), cell(f.vertical ? 'YES' : 'no'),
      cell(f.fontFile || '-'), cell(f.fontClass || '-'), cell(f.blockCode ? f.blockCode : 'validated class', f.blockCode ? 'blk' : 'sup'), cell(`${f.shows}${f.formShows ? ` (${f.formShows} in forms)` : ''}`), cell(f.pages.map((p) => p + 1).join(',')));
    fb.append(tr);
  }
  const pb = $('pagesBody');
  pb.textContent = '';
  for (const p of r.pages) {
    const tr = document.createElement('tr');
    const c = p.census || {};
    const k = p.independent || {};
    tr.append(cell(p.index + 1), cell(p.size ? `${p.size.width} x ${p.size.height}` : '-'), cell(p.rotation === null ? '-' : `${p.rotation * 90} deg${p.rotateIndependent ? ` (/Rotate ${p.rotateIndependent})` : ''}`),
      cell(p.census ? `${c.total}: ${c.text}/${c.path}/${c.image}/${c.form}/${c.shading}${k.inlineImages ? ` +${k.inlineImages} inline img` : ''}` : p.status), cell(`${p.annots}${Object.keys(p.annotSubtypes || {}).length ? ` (${Object.entries(p.annotSubtypes).map(([t, n]) => `${t} ${n}`).join(', ')})` : ''}`),
      cell(p.markedTextObjects), cell(p.optionalContentShows), cell(p.formTextShows), cell(`${p.supported} / ${p.blocked} / ${p.unknown}`), cell([...p.pageReasons.map((x) => x.code), ...(p.error ? [p.error] : [])].join(', ') || '-'));
    pb.append(tr);
  }
  const sel = $('pageSel');
  sel.textContent = '';
  if (r.doc && r.status !== 'failed') {
    for (const p of r.pages) { const o = document.createElement('option'); o.value = String(p.index); o.textContent = `Page ${p.index + 1} (${p.supported} supported)`; sel.append(o); }
    sel.disabled = false;
    const first = r.pages.find((p) => p.supported > 0) || r.pages[0];
    sel.value = String(first.index);
    await showPage(first.index);
  } else {
    sel.disabled = true;
    S.view = null;
    $('objBody').textContent = '';
    $('pageStatus').textContent = 'This file failed closed at intake: nothing to inspect.';
    const cv = $('page'); cv.width = 0; cv.height = 0;
    refreshButtons();
  }
}

// ------------------------------------------------------------------ page view and inspector
async function showPage(pageIndex) {
  const d = S.session.doc(S.session.active);
  if (!d) return;
  setBusy(true);
  clearSelectionUi();
  $('pageStatus').textContent = `Page ${pageIndex + 1}: rendering and classifying the working copy...`;
  const view = { docId: d.id, revision: d.revision, pageIndex, records: [], viewport: null, error: null };
  try {
    const rv = await renderToCanvas(pdfjsLib(), d.working.bytes, pageIndex, { fitWidth: Math.max(320, $('pageWrap').clientWidth - 4), max: DISPLAY_SCALE }, $('page'));
    view.viewport = rv.viewport;
  } catch (e) { view.error = `PDF.js could not render this page: ${e && e.message ? e.message : e}`; }
  try {
    const c = await classifyPage(S.E, d.working.bytes, pageIndex, { pdfjs: S.pdfjs, probe: !$('quick').checked });
    view.records = c.records;
    view.gates = c.gates;
  } catch (e) { view.error = `${view.error ? `${view.error}; ` : ''}analysis failed: ${e && e.message ? e.message : e}`; }
  if (S.session.active !== d.id || d.revision !== view.revision) { setBusy(false); return; }
  S.view = view;
  drawOverlays();
  renderObjectList();
  const n = (st) => view.records.filter((x) => x.status === st).length;
  $('pageStatus').textContent = view.error || `Page ${pageIndex + 1} of ${d.name} (working copy ${d.working.sha.slice(0, 12)}..., revision ${d.revision}${d.working.verified ? ', verified edit' : ', original bytes'}): ${view.records.length} text objects, ${n(STATUS.SUPPORTED)} supported, ${n(STATUS.BLOCKED)} blocked, ${n(STATUS.UNKNOWN)} unknown.${view.gates && view.gates.length ? ` Page/document gates: ${[...new Set(view.gates.map((g) => g.code))].join(', ')}.` : ''}`;
  setBusy(false);
}

function rectFor(b) {
  const q = S.view.viewport.convertToViewportRectangle([b.left, b.bottom, b.right, b.top]);
  const canvas = $('page');
  return { left: canvas.offsetLeft + Math.min(q[0], q[2]), top: canvas.offsetTop + Math.min(q[1], q[3]), width: Math.abs(q[2] - q[0]), height: Math.abs(q[3] - q[1]) };
}
function drawOverlays() {
  document.querySelectorAll('.ov, .hl').forEach((n) => n.remove());
  if (!S.view || !S.view.viewport) return;
  for (const r of S.view.records) {
    if (!r.bounds) continue;
    const q = rectFor(r.bounds);
    const el = document.createElement('div');
    el.className = `ov ${statusCls(r.status)}`;
    el.style.left = `${q.left - 1}px`; el.style.top = `${q.top - 1}px`; el.style.width = `${q.width + 2}px`; el.style.height = `${q.height + 2}px`;
    $('pageWrap').append(el);
  }
}
function highlight(r) {
  document.querySelectorAll('.hl').forEach((n) => n.remove());
  if (!r || !r.bounds || !S.view.viewport) return;
  const q = rectFor(r.bounds);
  const el = document.createElement('div');
  el.className = `hl${r.status === STATUS.SUPPORTED ? '' : ' blocked'}`;
  el.style.left = `${q.left - 3}px`; el.style.top = `${q.top - 3}px`; el.style.width = `${q.width + 6}px`; el.style.height = `${q.height + 6}px`;
  $('pageWrap').append(el);
}
function renderObjectList() {
  const body = $('objBody');
  body.textContent = '';
  if (!S.view) return;
  const f = $('objFilter').value;
  for (const r of S.view.records) {
    if (f !== 'all' && r.status !== f) continue;
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.append(cell(r.objIndex), cell(r.status.toUpperCase(), statusCls(r.status)), cell(r.text.length > 60 ? `${r.text.slice(0, 60)}...` : r.text), cell(r.fontName || '-'), cell(r.size), cell(r.codes.join(', ')));
    tr.addEventListener('click', () => selectObject(r.objIndex));
    body.append(tr);
  }
}

function selectAt(clientX, clientY) {
  if (!S.view || !S.view.viewport || S.busy) return;
  const rc = $('page').getBoundingClientRect();
  const [x, y] = S.view.viewport.convertToPdfPoint(clientX - rc.left, clientY - rc.top);
  const inside = (b, pad) => b && x >= b.left - pad && x <= b.right + pad && y >= b.bottom - pad && y <= b.top + pad;
  const hits = S.view.records.filter((r) => inside(r.bounds, 1));
  if (!hits.length) { clearSelectionUi('No direct text object there. Text drawn inside Form XObjects is listed in the document report (blocked: text-in-form-xobject).'); return; }
  const area = (b) => (b.right - b.left) * (b.top - b.bottom);
  hits.sort((p, q) => area(p.bounds) - area(q.bounds));
  selectObject(hits[0].objIndex);
}

function selectObject(objIndex) {
  const d = S.session.doc(S.session.active);
  if (!S.view || !d || S.view.docId !== d.id || S.view.revision !== d.revision) { clearSelectionUi('The page view is stale; reopen the page.'); return; }
  const r = S.view.records.find((x) => x.objIndex === objIndex);
  if (!r) return;
  S.session.select(d.id, S.view.pageIndex, objIndex, r.text);
  highlight(r);
  const f = r.font || {};
  $('inspector').textContent = [
    `Status: ${r.status.toUpperCase()}${r.codes.length ? ` (${r.codes.length} code(s))` : ''}`,
    `Exact extracted text: ${esc(r.text)}`,
    `Page ${r.page + 1}, object index ${r.objIndex}; ${r.glyphs} glyph(s) / code points; PDFium chars ${r.pdfiumChars} (generated ${r.generatedChars})`,
    `Font: ${f.name || r.fontName || '?'}${f.subset ? ' (subset)' : ''}; subtype ${f.kind || '?'}; encoding ${f.encoding || '?'}; embedded ${f.subtype === 'Type3' ? 'n/a' : f.embedded ? 'yes' : 'no'}; ToUnicode ${f.toUnicode ? 'yes' : 'no'}; vertical ${f.vertical ? 'YES' : 'no'}; class ${r.fontClass || '-'}`,
    `Font size ${r.size}; text matrix [${r.matrix.join(', ')}]; angle ${r.angle} deg${r.skewed ? '; skewed/mirrored' : ''}; scale ${r.scaleX} x ${r.scaleY}`,
    `Bounding box ${r.bounds ? `[${r.bounds.left}, ${r.bounds.bottom}, ${r.bounds.right}, ${r.bounds.top}]` : '-'}; baseline start ${r.baseline ? `(${r.baseline.x}, ${r.baseline.y})` : '-'}; baseline residual ${r.baselineResidual}`,
    `Tc ${r.tc ?? '?'}; Tw ${r.tw ?? '?'}; Tz ${r.tz ?? '?'}; rise ${r.ts ?? '?'}; render mode ${r.renderMode}; operator ${r.op || '?'}${r.tjAdjustments ? ` with ${r.tjAdjustments} TJ adjustment(s)` : ''}`,
    `Clipping: ${r.clipPaths > 0 ? `${r.clipPaths} PDFium clip path(s)` : 'no PDFium clip path'}, in-stream clip ${r.clipInStream === null ? '?' : r.clipInStream ? 'yes' : 'no'}; marked content ${r.marks.length ? r.marks.map((m) => `/${m.name}${m.keys.length ? `(${m.keys.join(',')})` : ''}`).join(' ') : 'none'}`,
    ...(r.status === STATUS.SUPPORTED ? ['', 'Why it is currently considered safe:', ...r.why.map((w) => `  - ${w}`)] : []),
  ].join('\n');
  const ul = $('reasons');
  ul.textContent = '';
  for (const x of r.reasons) { const li = document.createElement('li'); li.textContent = `[${x.stage}] ${x.code}: ${x.detail}`; ul.append(li); }
  $('text').value = r.text;
  const ok = r.status === STATUS.SUPPORTED && S.ready;
  $('text').disabled = !ok;
  $('fit').disabled = !ok;
  $('hint').textContent = ok ? `Object ${objIndex} is SUPPORTED. Change the text and run the verified edit test.` : `Object ${objIndex} is ${r.status.toUpperCase()}: it cannot be edit-tested. Every reason is listed below.`;
  refreshButtons();
}

function clearSelectionUi(hint) {
  S.session.clearSelection();
  document.querySelectorAll('.hl').forEach((n) => n.remove());
  $('inspector').textContent = '-';
  $('reasons').textContent = '';
  $('text').value = '';
  $('text').disabled = true;
  $('fit').disabled = true;
  if (hint) $('hint').textContent = hint;
  refreshButtons();
}

// ------------------------------------------------------------------ verified edit test
async function renderChecks(before, out, plan) {
  const lib = pdfjsLib();
  const checks = [];
  const box = grow(union(plan.oldBox, plan.newBox), 2);
  const rc = await compareRenders(lib, before, out, { pageIndex: plan.pageIndex, scale: 4, exclude: box });
  checks.push({ id: 'X01', name: 'outside the edit the page renders identically at 288 dpi (PDF.js)', pass: rc.ok, evidence: rc.detail });
  const pages = plan.analysis.doc.pageCount;
  if (pages > 1) {
    let worst = null;
    let compared = 0;
    for (let i = 0; i < pages; i++) {
      if (i === plan.pageIndex) continue;
      const r = await compareRenders(lib, before, out, { pageIndex: i, scale: 2 });
      compared++;
      if (!r.ok && !worst) worst = `page ${i + 1}: ${r.detail}`;
    }
    checks.push({ id: 'D02', name: 'every other page renders identically at 144 dpi (PDF.js)', pass: !worst, evidence: worst || `${compared} other page(s) identical` });
  } else checks.push({ id: 'D02', name: 'every other page renders identically at 144 dpi (PDF.js)', pass: true, evidence: 'single-page document: no other page' });
  return checks;
}

// Runs one verified edit for a selection (the UI passes the current one; the test hook can
// pass an old one to prove stale selections are refused).
async function applyWith(sel, newText, fit) {
  const c = S.session.checkSelection(sel);
  if (!c.ok) { line($('result'), `Refused: ${c.code} - ${c.detail}. The working document was NOT replaced.`, false); return { status: 'refused', code: c.code }; }
  if (!S.ready) { line($('result'), 'Refused: corpus processing is disabled.', false); return { status: 'refused', code: 'not-ready' }; }
  const q = quickCheck();
  if (!q.pass) { disableProcessing(q.fail.join('; ')); await audit(); return { status: 'refused', code: 'privacy' }; }
  const d = c.doc;
  setBusy(true);
  line($('result'), 'Analyse -> classify -> encode -> plan -> candidate -> mutate -> GenerateContent -> save -> reopen -> verify...');
  $('checks').textContent = '';
  $('stages').textContent = '';
  const workingBefore = d.working.sha;
  let result;
  try {
    result = await runVerifiedEdit(S.E, d.working.bytes, { pageIndex: sel.pageIndex, objIndex: sel.objIndex, expectedOldText: sel.oldText, newText, fit, pdfjs: S.pdfjs, extraChecks: renderChecks });
  } catch (e) {
    result = { status: 'failed', stages: [], checks: [], reasons: [{ stage: 'phase10', code: 'exception', detail: e && e.message ? e.message : String(e) }], plan: null };
  }
  S.lastResult = result;
  showStages(result.stages);
  showChecks(result.checks);
  if (result.status !== 'unchanged') d.edits.push(editRecord(sel, result));
  let outcome = result.status;
  if (result.status === 'committed') {
    const cm = await S.session.commit(sel, result);
    if (cm.ok) line($('result'), `Committed: ${esc(result.oldText)} -> ${esc(result.newText)} (${result.checks.length} checks passed${result.plan && result.plan.discriminating ? '; layout needed SetPositions' : ''}). Working copy ${result.outputSha.slice(0, 12)}...`, true);
    else { outcome = 'refused'; line($('result'), `Verified but NOT committed: ${cm.code} - ${cm.detail}. The working document was NOT replaced.`, false); }
  } else if (result.status === 'rejected') {
    line($('result'), 'Rejected by verification. The working document was NOT replaced.', false);
  } else if (result.status === 'blocked') {
    line($('result'), `Blocked before mutation (${result.reasons.length} reason(s): ${[...new Set(result.reasons.map((x) => x.code))].join(', ')}). The working document was NOT replaced.`, false);
  } else if (result.status === 'stale') {
    line($('result'), `Refused: ${result.reasons[0].detail}. The working document was NOT replaced.`, false);
  } else if (result.status === 'unchanged') {
    line($('result'), 'Nothing changed.');
  } else {
    line($('result'), `Failed closed: ${result.reasons.map((x) => `${x.code} ${x.detail}`).join('; ')}. The working document was NOT replaced.`, false);
  }
  if (outcome !== 'committed' && d.working.sha !== workingBefore) { outcome = 'failed'; disableProcessing('internal error: the working copy changed without a verified commit'); }
  const ul = $('reasons');
  if (outcome !== 'committed') {
    ul.textContent = '';
    for (const x of result.reasons || []) { const li = document.createElement('li'); li.textContent = `[${x.stage}] ${x.code}: ${x.detail}`; ul.append(li); }
    if (result.status === 'rejected' && result.reasons.some((x) => x.code === 'V11') && result.plan && result.plan.analysis.doc.pageCount > 1) {
      const li = document.createElement('li');
      li.textContent = '[note] V11 in multi-page documents: the Phase 9 verifier builds its set of referenced streams from the edited page only, so text streams of the other pages count as unreferenced and V11 fails. This is a known verifier limitation; the rejection stands (nothing is relaxed).';
      ul.append(li);
    }
  }
  S.log.push({ doc: d.id, page: sel.pageIndex, obj: sel.objIndex, status: outcome });
  renderSession();
  $('docReport').textContent = documentText(d);
  setBusy(false);
  if (outcome === 'committed') { const keep = $('result').textContent; const cls = $('result').className; await showPage(sel.pageIndex); $('result').textContent = keep; $('result').className = cls; }
  refreshButtons();
  return { status: outcome, checks: result.checks.map((x) => ({ id: x.id, pass: x.pass })), codes: (result.reasons || []).map((x) => x.code) };
}

function showStages(stages) {
  const ol = $('stages');
  ol.textContent = '';
  for (const s of stages || []) { const li = document.createElement('li'); li.className = s.ok ? '' : 'stop'; li.textContent = `${s.ok ? 'ok' : 'STOP'} ${s.name}: ${s.detail}`; ol.append(li); }
}
function showChecks(checks) {
  const tb = $('checks');
  tb.textContent = '';
  for (const c of checks || []) {
    const tr = document.createElement('tr');
    const b = cell(`${c.name} - ${c.evidence}`, 'small');
    tr.append(cell(c.id), b, cell(c.pass ? 'PASS' : 'FAIL', c.pass ? 'pass' : 'fail'));
    tb.append(tr);
  }
}

async function undo() {
  const d = S.session.doc(S.session.active);
  if (!d || S.busy || !S.session.undo(d.id)) return;
  await showPage(Number($('pageSel').value) || 0);
  line($('result'), 'Undone: restored the previous state.', true);
}
async function reset() {
  const d = S.session.doc(S.session.active);
  if (!d || S.busy) return;
  try { await S.session.reset(d.id); } catch (e) { line($('result'), String(e.message || e), false); return; }
  await showPage(Number($('pageSel').value) || 0);
  line($('result'), 'Reset: the working copy is the original file again.', true);
}
async function download() {
  const d = S.session.doc(S.session.active);
  if (!d) return;
  const bytes = await S.session.verifiedBytes(d.id);
  if (!bytes) { line($('result'), 'Download refused: the working copy is not a verified edit.', false); return; }
  saveBlob(new Blob([bytes], { type: 'application/pdf' }), `${d.name.replace(/\.pdf$/i, '')}-noblepdf-verified.pdf`);
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function setBusy(b) {
  S.busy = b;
  $('files').disabled = b || !S.ready;
  $('pageSel').disabled = b || !S.view;
  $('start').disabled = b;
  refreshButtons();
}
function refreshButtons() {
  const d = S.session.doc(S.session.active);
  const sel = S.session.selection;
  const selOk = !!sel && S.session.checkSelection(sel).ok;
  const rec = selOk && S.view ? S.view.records.find((x) => x.objIndex === sel.objIndex) : null;
  $('apply').disabled = S.busy || !S.ready || !rec || rec.status !== STATUS.SUPPORTED;
  $('undo').disabled = S.busy || !d || !d.history.length;
  $('reset').disabled = S.busy || !d || !d.report || d.report.status === 'failed' || (!d.history.length && !d.working.verified);
  $('download').disabled = S.busy || !d || !d.working.verified;
}

// ------------------------------------------------------------------ export
function exportOptions() { return { includeFileNames: $('optNames').checked, samples: $('optSamples').value, includeGeneratorStrings: $('optGen').checked }; }
function environmentSummary() {
  const env = S.audit || {};
  return { page: PAGE_VERSION, module: TE_CORPUS_VERSION, userAgent: navigator.userAgent, engine: S.engine ? { wasmSha256: S.engine.wasmSha256, indexJsSha256: S.engine.indexSha256, run10: S.engine.ok } : null, pdfjs: S.pdfjs ? S.pdfjs.version : null,
    privacyAudit: env.pass === undefined ? null : env.pass, serviceWorker: env.serviceWorker ?? null, hostMonitoringBlocked: env.hostBlocked ?? null, ledger: env.ledger || null, lastProcessing: S.lastProcessing ? { files: S.lastProcessing.files, calls: S.lastProcessing.calls, entries: S.lastProcessing.entries, withBody: S.lastProcessing.withBody, nonGet: S.lastProcessing.nonGet, problems: S.lastProcessing.bad.length } : null };
}
async function exportReport() {
  await audit();
  const rep = buildExport(S.session, { ...exportOptions(), environment: environmentSummary(), page: PAGE_VERSION });
  const text = JSON.stringify(rep, null, 1);
  saveBlob(new Blob([text], { type: 'application/json' }), `noblepdf-phase10-corpus-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  line($('exportStatus'), `Exported ${rep.documents.length} document report(s), ${text.length} characters, built in this browser (file names ${rep.privacy.fileNames ? 'included' : 'withheld'}; samples ${rep.privacy.samples}).`, true);
  return rep;
}
function summaryText() {
  const s = sessionSummary(S.session);
  const opt = exportOptions();
  return [`NoblePDF True Edit Phase 10 corpus summary - ${new Date().toISOString()} - ${PAGE_VERSION}`, `Privacy audit ${S.audit && S.audit.pass ? 'PASS' : 'FAIL'}; engine Run #10 ${S.engine && S.engine.ok ? 'MATCH' : '?'}; PDF.js ${S.pdfjs ? S.pdfjs.version : '?'}`,
    $('sessionReport').textContent, '', ...S.session.docs.filter((d) => d.report).map((d, i) => `${opt.includeFileNames ? d.name : `document-${i + 1}`} ${d.report.sha256.slice(0, 16)} ${d.report.status} pages ${d.report.summary.pages} objects ${d.report.summary.textObjects} supported ${d.report.summary.supported} blocked ${d.report.summary.blocked} unknown ${d.report.summary.unknown} generator ${d.report.generator || '-'} edits ${d.edits.map((e) => e.status).join(',') || '-'}`)].join('\n');
}

// ------------------------------------------------------------------ test hook (automated browser harness)
window.__phase10Corpus = Object.freeze({
  version: PAGE_VERSION,
  state: () => ({ ready: S.ready, busy: S.busy, active: S.session.active, generation: S.session.generation, selection: S.session.selection, lastProcessing: S.lastProcessing, log: S.log.slice(),
    docs: S.session.docs.map((d) => ({ id: d.id, name: d.name, sha256: d.sha256, workingSha: d.working.sha, verified: d.working.verified, revision: d.revision, history: d.history.length, edits: d.edits.map((e) => ({ status: e.status, codes: e.codes, failedChecks: e.failedChecks })),
      status: d.report ? d.report.status : null, intake: d.report ? d.report.intake.map((x) => x.code) : [], summary: d.report ? d.report.summary : null, documentReasons: d.report ? d.report.documentReasons.map((x) => x.code) : [] })) }),
  objects: (id) => { const d = S.session.doc(id); return d && d.report ? d.report.objects.map((o) => ({ page: o.page, objIndex: o.objIndex, status: o.status, codes: o.codes, text: o.text })) : null; },
  view: () => (S.view ? { docId: S.view.docId, revision: S.view.revision, pageIndex: S.view.pageIndex, records: S.view.records.map((r) => ({ objIndex: r.objIndex, status: r.status, codes: r.codes, text: r.text })) } : null),
  pointFor(text) {
    if (!S.view || !S.view.viewport) return null;
    const r = S.view.records.find((x) => x.text === text && x.bounds);
    if (!r) return null;
    const [vx, vy] = S.view.viewport.convertToViewportPoint((r.bounds.left + r.bounds.right) / 2, (r.bounds.bottom + r.bounds.top) / 2);
    const rc = $('page').getBoundingClientRect();
    return { x: rc.left + vx, y: rc.top + vy };
  },
  showDocument: (id) => showDocument(id),
  showPage: (i) => showPage(i),
  selection: () => S.session.selection,
  applyWith: (sel, text, fit = false) => applyWith(sel, text, fit),
  workingSha: async (id) => { const d = S.session.doc(id); return d ? sha256Hex(d.working.bytes) : ''; },
  originalSha: async (id) => { const d = S.session.doc(id); return d ? sha256Hex(d.original) : ''; },
  exportReport: (opts) => buildExport(S.session, { ...exportOptions(), ...(opts || {}), environment: environmentSummary(), page: PAGE_VERSION }),
  // Runs in a fresh task: Chromium exempts code called directly from a DevTools/automation
  // evaluate from the CSP eval restriction, which would make the eval probe report NOT blocked.
  audit: async () => { await new Promise((r) => setTimeout(r, 0)); const a = await audit(); return { pass: a.pass, fail: a.fail, warn: a.warn, ledger: a.ledger, hostBlocked: a.hostBlocked, serviceWorker: a.serviceWorker, registrations: a.registrations }; },
});

function boot() {
  if (document.documentElement.dataset.phase10 !== 'corpus-1') { $('privacyStatus').textContent = 'FAIL - page/module version mismatch (stale cache?)'; return; }
  $('start').addEventListener('click', preflight);
  $('files').addEventListener('change', (e) => processFiles(e.target.files));
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); if (S.ready && !S.busy) drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (S.ready && !S.busy) processFiles(e.dataTransfer.files); });
  // A PDF dropped anywhere else must not make the browser navigate to it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('page').addEventListener('click', (e) => selectAt(e.clientX, e.clientY));
  $('pageSel').addEventListener('change', (e) => { if (!S.busy && e.target.value !== '') showPage(Number(e.target.value)); });
  $('objFilter').addEventListener('change', renderObjectList);
  $('apply').addEventListener('click', () => { if (!S.busy) applyWith(S.session.selection, $('text').value, $('fit').checked); });
  $('undo').addEventListener('click', undo);
  $('reset').addEventListener('click', reset);
  $('download').addEventListener('click', download);
  $('export').addEventListener('click', exportReport);
  $('copySummary').addEventListener('click', () => navigator.clipboard.writeText(summaryText()).then(() => line($('exportStatus'), 'Text summary copied.', true)).catch(() => line($('exportStatus'), 'Clipboard unavailable.', false)));
  audit();
}
boot();

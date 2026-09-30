// NoblePDF True Edit (Phase 9 lab): fixture runner shared by the browser suite and Node CI.
// A fixture passes only when the observed outcome matches its manifest expectation:
// committed edits must also match the independently generated reference PDF, and
// blocked or rejected cases must fail closed for the expected reason. ASCII only.
import { sha256Hex } from './phase8-verify.mjs?v=1';
import { analyze, planEdit, applyEdit, verifyEdit, findTextObject, findInObject, documentGates, POS_TOL_PT } from './te-pipeline.mjs?v=1';
import { OBJ } from './te-engine.mjs?v=1';

export const TE_SUITE_VERSION = 'te-suite-1';
const reason = (stage, code, detail) => ({ stage, code, detail });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Options (tests only): applyEngine replaces the engine used for the mutation step,
// planMutator rewrites the plan before mutation; both exist to prove the gates fail.
export async function runFixture(E, fx, load, { pdfjs = null, applyEngine = null, planMutator = null } = {}) {
  const res = { id: fx.id, title: fx.title, expect: fx.expect, status: null, reasons: [], checks: [], ref: [], notes: [], plan: null, out: null, ok: false };
  const bytes = await load(fx.before);
  const sha = await sha256Hex(bytes);
  if (fx.sha256 && fx.sha256.before && sha !== fx.sha256.before) { res.status = 'error'; res.notes.push(`fixture hash ${sha} does not match the manifest`); return finish(res); }
  res.before = bytes;
  const e = fx.edit || {};
  const pageIndex = e.page || 0;
  let a;
  try { a = await analyze(E, bytes, pageIndex, { pdfjs }); } catch (err) { res.status = 'error'; res.notes.push(`analysis failed: ${err.message}`); return finish(res); }
  const oi = e.object ? findTextObject(a, e.object) : -1;
  if (oi < 0) {
    const reasons = documentGates(a);
    const nonDirect = a.pdfium.chars.filter((c) => c.objIndex === -2 && c.cp).map((c) => String.fromCodePoint(c.cp)).join('');
    if (e.object && nonDirect.includes(e.object)) reasons.push(reason('target', 'text-in-form-xobject', 'the text is drawn by a Form XObject, not directly by the page'));
    if (!reasons.length) reasons.push(reason('target', 'target-not-found', JSON.stringify(e.object)));
    res.status = 'blocked';
    res.reasons = reasons;
    return finish(res);
  }
  const sel = findInObject(a, oi, e.find, e.occurrence || 0);
  if (!sel) { res.status = 'error'; res.notes.push(`"${e.find}" not found in "${e.object}"`); return finish(res); }
  let plan = await planEdit(E, bytes, { pageIndex, objIndex: oi, start: sel.start, end: sel.end, replacement: e.replace, fit: !!e.fit, analysis: a, pdfjs });
  res.plan = plan;
  if (!plan.ok) { res.status = 'blocked'; res.reasons = plan.reasons; return finish(res); }
  if (planMutator) plan = planMutator(plan);
  let out;
  try { out = applyEdit(applyEngine || E, bytes, plan); } catch (err) { res.status = 'failed'; res.reasons = [reason('mutation', 'engine-refused', err.message)]; return finish(res); }
  res.out = out;
  const v = await verifyEdit(E, bytes, out, plan, { pdfjs });
  res.checks = v.checks;
  if (!v.ok) { res.status = 'rejected'; res.reasons = v.checks.filter((c) => !c.pass).map((c) => reason('verification', c.id, c.name)); return finish(res); }
  res.status = 'committed';
  if (fx.reference) res.ref = await compareWithReference(E, out, await load(fx.reference), fx, plan, { pdfjs });
  return finish(res);
}

export async function compareWithReference(E, out, ref, fx, plan, { pdfjs = null } = {}) {
  const checks = [];
  const add = (id, name, pass, evidence) => checks.push({ id, name, pass: !!pass, evidence: String(evidence) });
  if (fx.sha256 && fx.sha256.reference) {
    const sha = await sha256Hex(ref);
    add('R00', 'reference fixture hash', sha === fx.sha256.reference, sha);
  }
  const ao = await analyze(E, out, plan.pageIndex, { pdfjs });
  const ar = await analyze(E, ref, plan.pageIndex, { pdfjs });
  add('R01', 'PDFium page text equals the independent reference', ao.pdfium.pageText === ar.pdfium.pageText, `${JSON.stringify(ao.pdfium.pageText.slice(0, 120))} / ${JSON.stringify(ar.pdfium.pageText.slice(0, 120))}`);
  const to = ao.objects.filter((o) => o.type === OBJ.TEXT);
  const tr = ar.objects.filter((o) => o.type === OBJ.TEXT);
  let worst = 0;
  let bad = '';
  if (to.length !== tr.length) bad = `text objects ${to.length} vs ${tr.length}`;
  else to.forEach((o, k) => {
    const r = tr[k];
    if (o.realText !== r.realText || o.origins.length !== r.origins.length) { bad = bad || `object ${k}: ${JSON.stringify(o.realText)} vs ${JSON.stringify(r.realText)}`; return; }
    o.origins.forEach((q, j) => { worst = Math.max(worst, dist(q, r.origins[j])); });
  });
  add('R02', `every glyph origin on the page equals the independent reference within ${POS_TOL_PT} pt`, !bad && worst <= POS_TOL_PT, bad || `max ${worst.toExponential(2)} pt`);
  const ts = ar.objects[plan.objIndex] && ar.objects[plan.objIndex].show;
  const refCodes = ts ? ts.glyphs.map((g) => g.code) : [];
  add('R03', 'reference (Python encoder) uses the same character codes as the lab plan', JSON.stringify(refCodes) === JSON.stringify(plan.newCodes), `${JSON.stringify(refCodes.slice(0, 24))} vs ${JSON.stringify(plan.newCodes.slice(0, 24))}`);
  if (pdfjs) add('R04', 'PDF.js page text equals the independent reference', ao.pdfjs.page.str === ar.pdfjs.page.str, `${JSON.stringify(ao.pdfjs.page.str.slice(0, 120))} / ${JSON.stringify(ar.pdfjs.page.str.slice(0, 120))}`);
  if (fx.edit && fx.edit.expectedText) add('R05', 'target text equals the manifest expectation', plan.newText === fx.edit.expectedText, JSON.stringify(plan.newText));
  if (fx.expect && typeof fx.expect.naturalDelta === 'number') {
    const agree = Math.abs(plan.naturalDelta - fx.expect.naturalDelta) <= 0.02 && plan.discriminating === fx.expect.discriminating;
    add('R06', 'SetPositions discrimination agrees with the independent generator', agree, `lab ${plan.naturalDelta.toFixed(3)} (${plan.discriminating}) vs generator ${fx.expect.naturalDelta} (${fx.expect.discriminating})`);
  }
  return checks;
}

function finish(res) {
  const ex = res.expect || {};
  const codes = res.reasons.map((r) => r.code);
  const why = [];
  if (res.status !== ex.status) why.push(`status ${res.status}, expected ${ex.status}`);
  if (ex.status !== 'committed') for (const c of ex.reasons || []) if (!codes.includes(c)) why.push(`missing reason ${c}`);
  if (res.status === 'committed') for (const c of res.ref) if (!c.pass) why.push(`${c.id} ${c.name}`);
  res.mismatch = why;
  res.ok = why.length === 0;
  return res;
}

export function discriminationLabel(res) {
  // Only meaningful when a mutation happened (committed, or rejected by verification).
  if (!res.plan || res.plan.discriminating === undefined || !['committed', 'rejected'].includes(res.status)) return 'n/a';
  return res.plan.discriminating ? `yes (${res.plan.naturalDelta.toFixed(2)} pt)` : 'no';
}

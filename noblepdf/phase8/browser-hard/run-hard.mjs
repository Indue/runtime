#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const ENGINE = resolve(args.engine ?? 'engine');
const OUT = resolve(args.out ?? 'out-browser-hard');
const BRIDGE = resolve(args.bridge ?? new URL('./true-edit-phase8.js', import.meta.url).pathname);
const REQUIRE_EXTERNAL = process.env.NOBLEPDF_REQUIRE_EXTERNAL === '1';
mkdirSync(OUT, { recursive: true });

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function die(msg) { throw new Error(msg); }
function approx(a,b,tol=0.02){ return Math.abs(a-b)<=tol; }
function countSub(hay, needle){
  if(!needle) return 0;
  let n=0,p=0;
  while((p=hay.indexOf(needle,p))!==-1){n++;p+=needle.length;}
  return n;
}
function norm(s){return String(s??'').replace(/\s+/g,' ').trim();}
function charBag(s){return [...String(s??'').replace(/[^A-Za-z0-9]/g,'')].sort().join('');}
function pdfHex(text){
  return [...Buffer.from(text,'latin1')].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
}
function showOp(show){
  if (typeof show === 'string') return `<${pdfHex(show)}> Tj`;
  const parts = show.map(x => typeof x === 'number' ? String(x) : `<${pdfHex(x)}>`);
  return `[${parts.join(' ')}] TJ`;
}
function runContent(r){
  const parts=['q','BT',`/F1 ${r.size??18} Tf`];
  if(r.tc!==undefined) parts.push(`${r.tc} Tc`);
  if(r.tw!==undefined) parts.push(`${r.tw} Tw`);
  if(r.tz!==undefined) parts.push(`${r.tz} Tz`);
  const tm=r.tm??[1,0,0,1,72,700];
  parts.push(`${tm.join(' ')} Tm`);
  parts.push(showOp(r.show??r.text));
  parts.push('ET','Q');
  return parts.join(' ');
}

function buildPdf(runs){
  const content = runs.map(runContent).join('\n')+'\n';
  const objs=[];
  objs[1]='<< /Type /Catalog /Pages 2 0 R >>';
  objs[2]='<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
  objs[4]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[5]=`<< /Length ${Buffer.byteLength(content,'latin1')} >>\nstream\n${content}endstream`;

  let out='%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets=[0];
  for(let i=1;i<=5;i++){
    offsets[i]=Buffer.byteLength(out,'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref=Buffer.byteLength(out,'latin1');
  out += 'xref\n0 6\n0000000000 65535 f \n';
  for(let i=1;i<=5;i++) out += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out,'latin1'));
}

function encodeUtf16z(str){
  const out=new Uint8Array((str.length+1)*2);
  for(let i=0;i<str.length;i++){
    const c=str.charCodeAt(i); out[i*2]=c&255; out[i*2+1]=c>>>8;
  }
  return out;
}
function decodeUtf16(heap,ptr,len){
  let s='';
  for(let i=0;i+1<len;i+=2){const c=heap[ptr+i]|(heap[ptr+i+1]<<8);if(!c)break;s+=String.fromCharCode(c);}
  return s;
}

async function loadEngine(){
  const wasm=readFileSync(resolve(ENGINE,'pdfium.wasm'));
  const mod=await import(pathToFileURL(resolve(ENGINE,'index.js')).href+`?hard=${Date.now()}`);
  const init=mod.init||mod.default;
  const m=await init({wasmBinary:wasm});
  m.PDFiumExt_Init?.();
  const p=m.pdfium;
  const malloc=n=>{const q=p.wasmExports.malloc(Math.max(1,n));if(!q)die('malloc failed');return q;};
  const free=q=>q&&p.wasmExports.free(q);
  const withAlloc=(n,fn)=>{const q=malloc(n);try{return fn(q);}finally{free(q);}};
  function open(bytes){
    const ptr=malloc(bytes.length);p.HEAPU8.set(bytes,ptr);const doc=m.FPDF_LoadMemDocument(ptr,bytes.length,'');
    if(!doc){free(ptr);die(`FPDF_LoadMemDocument failed ${m.FPDF_GetLastError()}`);} return {doc,ptr};
  }
  function close(h){m.FPDF_CloseDocument(h.doc);free(h.ptr);}
  function objText(obj,tp){
    const len=m.FPDFTextObj_GetText(obj,tp,0,0);if(len<=0)return '';
    return withAlloc(len,ptr=>{m.FPDFTextObj_GetText(obj,tp,ptr,len);return decodeUtf16(p.HEAPU8,ptr,len);});
  }
  function matrix(obj){return withAlloc(24,ptr=>{if(!m.FPDFPageObj_GetMatrix(obj,ptr))die('GetMatrix failed');const f=p.HEAPF32,q=ptr>>2;return {a:f[q],b:f[q+1],c:f[q+2],d:f[q+3],e:f[q+4],f:f[q+5]};});}
  function fontSize(obj){return withAlloc(4,ptr=>{if(!m.FPDFTextObj_GetFontSize(obj,ptr))die('GetFontSize failed');return p.HEAPF32[ptr>>2];});}
  function glyphWidth(font,unicode){return withAlloc(4,ptr=>{if(!m.FPDFFont_GetGlyphWidth(font,unicode,1000,ptr))die('GetGlyphWidth failed');return p.HEAPF32[ptr>>2];});}
  function inspect(bytes){
    const h=open(bytes), page=m.FPDF_LoadPage(h.doc,0); if(!page){close(h);die('load page failed');}
    const tp=m.FPDFText_LoadPage(page); if(!tp){m.FPDF_ClosePage(page);close(h);die('load text page failed');}
    const glyphMap=new Map();
    withAlloc(16,ptr=>{
      const n=m.FPDFText_CountChars(tp);
      for(let i=0;i<n;i++){
        if(m.FPDFText_IsGenerated(tp,i)===1) continue;
        const obj=m.FPDFText_GetTextObject(tp,i); if(!obj) continue;
        m.FPDFText_GetCharOrigin(tp,i,ptr,ptr+8);const d=p.HEAPF64;
        const g={unicode:m.FPDFText_GetUnicode(tp,i),x:d[ptr>>3],y:d[(ptr>>3)+1]};
        if(!glyphMap.has(obj))glyphMap.set(obj,[]);glyphMap.get(obj).push(g);
      }
    });
    const objects=[];const census={text:0,image:0,total:0};
    const n=m.FPDFPage_CountObjects(page);
    for(let i=0;i<n;i++){
      const obj=m.FPDFPage_GetObject(page,i),type=m.FPDFPageObj_GetType(obj);census.total++;
      if(type===1)census.text++; if(type===3)census.image++;
      if(type!==1) { objects.push({index:i,type,obj}); continue; }
      const font=m.FPDFTextObj_GetFont(obj);
      objects.push({index:i,type,obj,text:objText(obj,tp),matrix:matrix(obj),fontSize:fontSize(obj),font,glyphs:glyphMap.get(obj)||[]});
    }
    const pageText=(()=>{const n=m.FPDFText_CountChars(tp);return withAlloc((n+1)*2,ptr=>{m.FPDFText_GetText(tp,0,n,ptr);return decodeUtf16(p.HEAPU8,ptr,n*2);});})();
    const find=(needle)=>{
      const b=encodeUtf16z(needle);return withAlloc(b.length,ptr=>{p.HEAPU8.set(b,ptr);const fh=m.FPDFText_FindStart(tp,ptr,0,0);const found=!!m.FPDFText_FindNext(fh);m.FPDFText_FindClose(fh);return found;});
    };
    const result={objects,census,pageText,find,glyphWidth};
    result.close=()=>{m.FPDFText_ClosePage(tp);m.FPDF_ClosePage(page);close(h);};
    return result;
  }
  return {m,p,inspect,info:{wasmSha256:sha256(wasm)}};
}

async function loadBridge(){
  const source=readFileSync(BRIDGE,'utf8');
  const base=pathToFileURL(resolve(ENGINE)+'/').href;
  const needle="const ENGINE_BASE = '/vendor/pdfium-2.15.1-setpositions/';";
  if(!source.includes(needle)) die('bridge ENGINE_BASE anchor missing');
  const patched=source.replace(needle,`const ENGINE_BASE = '${base}';`);
  const temp=resolve(OUT,'bridge-under-test.mjs');
  writeFileSync(temp,patched);
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async (input,init)=>{
    const u=new URL(String(input));
    if(u.protocol==='file:'){
      u.search='';u.hash='';const data=readFileSync(fileURLToPath(u));
      return {ok:true,status:200,arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)};
    }
    return nativeFetch(input,init);
  };
  return import(pathToFileURL(temp).href+`?v=${Date.now()}`);
}

function descriptor(E,ins,objectIndex,newText,overrides={}){
  const o=ins.objects.find(x=>x.index===objectIndex);
  if(!o||o.type!==1) die(`text object ${objectIndex} not found`);
  const plan=o.glyphs.map(g=>({type:'glyph',unicode:String.fromCodePoint(g.unicode),width:Math.round(ins.glyphWidth(o.font,g.unicode)),isSpace:g.unicode===32}));
  return {
    pageIndex:1,
    originalText:o.text,
    newText,
    sourceTextTransform:[o.matrix.a,o.matrix.b,o.matrix.c,o.matrix.d,o.glyphs[0]?.x??o.matrix.e,o.glyphs[0]?.y??o.matrix.f],
    pdfDeclaredFontSize:o.fontSize,
    sourceGlyphCount:o.glyphs.length,
    sourceGlyphPlan:plan,
    charSpacing:0,wordSpacing:0,verticalText:false,matchOriginal:true,autoFit:false,
    ...overrides,
  };
}

const deg=d=>d*Math.PI/180;
const rot=(d,x,y)=>[Math.cos(deg(d)),Math.sin(deg(d)),-Math.sin(deg(d)),Math.cos(deg(d)),x,y].map(v=>+v.toFixed(8));

const CASES=[
  {id:'P1',title:'same-length real text',runs:[{text:'HELLO',size:28,tm:[1,0,0,1,160,620]}],edits:[{obj:0,newText:'HALLO'}],expect:'pass'},
  {id:'P2',title:'longer replacement',runs:[{text:'ALPHA',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'BETAGAMMA'}],expect:'pass'},
  {id:'P3',title:'shorter replacement',runs:[{text:'SATURDAY',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'SAT'}],expect:'pass'},
  {id:'P4',title:'real space with zero Tw',runs:[{text:'RED BLUE',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'RED GREEN'}],expect:'pass'},
  {id:'P5',title:'rotated object',runs:[{text:'ROTATE',size:20,tm:rot(27,180,460)}],edits:[{obj:0,newText:'REROUTE'}],expect:'pass',popplerBag:true},
  {id:'P6',title:'repeated text, distinct baselines',runs:[{text:'TOTAL',size:16,tm:[1,0,0,1,72,700]},{text:'TOTAL',size:16,tm:[1,0,0,1,72,500]}],edits:[{obj:1,newText:'TALLY'}],expect:'pass',oldCountAfter:{TOTAL:1}},
  {id:'P7',title:'two edits on one page',runs:[{text:'ALPHA',size:16,tm:[1,0,0,1,72,700]},{text:'BETA',size:16,tm:[1,0,0,1,72,650]}],edits:[{obj:0,newText:'OMEGA'},{obj:1,newText:'DELTA'}],expect:'pass'},
  {id:'P8',title:'character spacing',runs:[{text:'TRACK',size:18,tc:0.6,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'TRACE',overrides:{charSpacing:0.6}}],expect:'pass'},
  {id:'P9',title:'horizontal text scale',runs:[{text:'SCALE',size:18,tz:73,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'WIDTH'}],expect:'pass'},
  {id:'P10',title:'existing TJ segmentation',runs:[{show:['TO',-120,'KEN'],size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'TAKEN'}],expect:'pass'},

  {id:'R1',title:'ambiguous overlapping duplicates',runs:[{text:'DUP',size:18,tm:[1,0,0,1,72,700]},{text:'DUP',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'DUN'}],expect:'reject',reason:/more than one|uniquely locate|matched|overlapping text objects/i},
  {id:'R2',title:'custom formatting blocked',runs:[{text:'STYLE',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'STYLED',overrides:{matchOriginal:false}}],expect:'reject',reason:/custom formatting/i},
  {id:'R3',title:'auto-fit blocked',runs:[{text:'AUTOFIT',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'AUTO FIT',overrides:{autoFit:true}}],expect:'reject',reason:/auto-fit/i},
  {id:'R4',title:'vertical-text metadata blocked',runs:[{text:'VERTICAL',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'VERT',overrides:{verticalText:true}}],expect:'reject',reason:/vertical text/i},
  {id:'R5',title:'single-glyph target blocked',runs:[{text:'X',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'Y'}],expect:'reject',reason:/single-glyph/i},
  {id:'R6',title:'supplementary Unicode blocked',runs:[{text:'AB',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'A😀'}],expect:'reject',reason:/supplementary Unicode/i},
  {id:'R7',title:'non-zero Tw with spaces blocked',runs:[{text:'RED BLUE',size:18,tw:2,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'RED GREEN',overrides:{wordSpacing:2}}],expect:'reject',reason:/word spacing/i},
  {id:'R8',title:'fractional source metrics blocked',runs:[{text:'FRACTION',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'FRACTIONS',fractionalPlan:true}],expect:'reject',reason:/fractional source font widths/i},
  {id:'R9',title:'missing source object blocked',runs:[{text:'FOUND',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:'NEW',overrides:{originalText:'MISSING'}}],expect:'reject',reason:/locate|matched/i},
  {id:'R10',title:'degenerate matrix blocked',runs:[{text:'DEGENERATE',size:18,tm:[1,0,2,0,72,500]}],edits:[{obj:0,newText:'BLOCKED'}],expect:'reject',reason:/geometry|degenerate|baseline|locate/i},
  {id:'R11',title:'multi-edit fail closed when later edit is ambiguous',runs:[{text:'ALPHA',size:18,tm:[1,0,0,1,72,740]},{text:'DUP',size:18,tm:[1,0,0,1,72,650]},{text:'DUP',size:18,tm:[1,0,0,1,72,650]}],edits:[{obj:0,newText:'OMEGA'},{obj:1,newText:'DUN'}],expect:'reject',reason:/more than one|uniquely locate|matched|overlapping text objects/i},
  {id:'R12',title:'empty replacement blocked',runs:[{text:'DELETE',size:18,tm:[1,0,0,1,72,700]}],edits:[{obj:0,newText:''}],expect:'reject',reason:/empty/i},
];

function externalTool(name,args,file){
  const r=spawnSync(name,args,{encoding:'utf8'});
  if(r.error){
    if(REQUIRE_EXTERNAL) return {ok:false,detail:`${name} unavailable: ${r.error.message}`};
    return {ok:true,detail:`${name} not installed locally (CI requires it)`,skipped:true};
  }
  return {ok:r.status===0,detail:(String(r.stdout??'')+String(r.stderr??'')).trim().slice(0,1200)};
}

const E=await loadEngine();
const bridge=await loadBridge();
const results=[];

for(const tc of CASES){
  const checks=[];
  const add=(name,pass,detail='')=>checks.push({name,pass:!!pass,detail});
  try{
    const source=buildPdf(tc.runs);
    const sourceHash=sha256(source);
    const before=E.inspect(source);
    add('source opens in PDFium',true,`${before.census.text} text objects`);
    add('source has no image objects',before.census.image===0,JSON.stringify(before.census));
    const descriptors=[];
    for(const e of tc.edits){
      const d=descriptor(E,before,e.obj,e.newText,e.overrides||{});
      if(e.fractionalPlan && d.sourceGlyphPlan.length) d.sourceGlyphPlan[0]={...d.sourceGlyphPlan[0],width:500.5};
      descriptors.push(d);
    }

    const out=await bridge.tryTrueEditPdf(source,descriptors);
    add('input bytes not mutated',sha256(source)===sourceHash);

    if(tc.expect==='reject'){
      add('bridge rejects unsafe case',out?.ok===false,`reason=${out?.reason||''}`);
      add('rejection returns no output bytes',!out?.bytes);
      add('expected rejection reason',tc.reason?.test(String(out?.reason||''))??true,String(out?.reason||''));
      before.close();
    }else{
      add('bridge accepts supported case',out?.ok===true,`reason=${out?.reason||''}`);
      if(!out?.ok||!(out.bytes instanceof Uint8Array)) throw new Error(`expected output bytes, got ${out?.reason||'none'}`);
      add('reported edit count',out?.stats?.trueEdited===tc.edits.length,JSON.stringify(out?.stats||{}));
      const file=resolve(OUT,`${tc.id}-${tc.title.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.pdf`);
      writeFileSync(file,out.bytes);
      const after=E.inspect(out.bytes);
      add('output reopens in PDFium',true,`${after.census.text} text objects`);
      add('object census unchanged',JSON.stringify(after.census)===JSON.stringify(before.census),`before=${JSON.stringify(before.census)} after=${JSON.stringify(after.census)}`);
      add('output has no raster image objects',after.census.image===0,JSON.stringify(after.census));
      add('single EOF rewrite',countSub(dec.decode(out.bytes),'%%EOF')===1);

      const changed=new Set(tc.edits.map(e=>e.obj));
      for(const e of tc.edits){
        const b=before.objects.find(o=>o.index===e.obj), a=after.objects.find(o=>o.index===e.obj);
        add(`object ${e.obj} text is exact replacement`,a?.text===e.newText,`actual=${JSON.stringify(a?.text)}`);
        add(`search finds ${JSON.stringify(e.newText)}`,after.find(e.newText));
        if(b?.glyphs?.length&&a?.glyphs?.length){
          const drift=Math.hypot(a.glyphs[0].x-b.glyphs[0].x,a.glyphs[0].y-b.glyphs[0].y);
          add(`object ${e.obj} start origin anchored`,drift<=0.02,`${drift.toExponential(3)} pt`);
        }
      }
      for(const b of before.objects.filter(o=>o.type===1&&!changed.has(o.index))){
        const a=after.objects.find(o=>o.index===b.index);
        const matrixSame=a&&['a','b','c','d','e','f'].every(k=>approx(a.matrix[k],b.matrix[k],0.001));
        add(`untouched object ${b.index} text unchanged`,a?.text===b.text,`${JSON.stringify(b.text)} -> ${JSON.stringify(a?.text)}`);
        add(`untouched object ${b.index} matrix unchanged`,matrixSame);
      }

      const allAfter=norm(after.pageText);
      for(const e of tc.edits) add(`extracted text contains ${JSON.stringify(e.newText)}`,allAfter.includes(e.newText),allAfter);
      if(tc.oldCountAfter){
        for(const [old,n] of Object.entries(tc.oldCountAfter)) add(`old text ${JSON.stringify(old)} remains exactly ${n} time(s)`,countSub(allAfter,old)===n,allAfter);
      }else{
        for(const e of tc.edits){
          const old=before.objects.find(o=>o.index===e.obj)?.text||'';
          if(old && !tc.edits.some(x=>x.newText===old)) add(`old text ${JSON.stringify(old)} absent`,!allAfter.includes(old),allAfter);
        }
      }

      const q=externalTool('qpdf',['--check',file],file); add('qpdf structural check',q.ok,q.detail);
      const pop=spawnSync('pdftotext',[file,'-'],{encoding:'utf8'});
      if(pop.error?.code==='ENOENT') add('Poppler extraction',!REQUIRE_EXTERNAL,'pdftotext missing');
      else{
        const pt=norm(pop.stdout);
        add('Poppler extraction succeeds',pop.status===0,(pop.stderr||'').trim());
        for(const e of tc.edits){
          const ok=tc.popplerBag ? charBag(pt)===charBag(e.newText) : pt.includes(e.newText);
          add(`Poppler contains ${JSON.stringify(e.newText)}${tc.popplerBag?' (rotated glyph multiset)':''}`,ok,pt);
        }
        if(!tc.oldCountAfter){
          for(const e of tc.edits){
            const old=before.objects.find(o=>o.index===e.obj)?.text||'';
            const oldAbsent=tc.popplerBag ? charBag(pt)!==charBag(old) : !pt.includes(old);
            if(old && !tc.edits.some(x=>x.newText===old)) add(`Poppler old text ${JSON.stringify(old)} absent`,oldAbsent,pt);
          }
        }
      }
      before.close();after.close();
    }
  }catch(err){
    add('case completed',false,err?.stack||String(err));
  }
  const failed=checks.filter(c=>!c.pass);
  results.push({id:tc.id,title:tc.title,expect:tc.expect,result:failed.length?'FAIL':'PASS',checks});
  console.log(`[${failed.length?'FAIL':'PASS'}] ${tc.id} ${tc.title}`);
  for(const c of checks) console.log(`  ${c.pass?'pass':'FAIL'} ${c.name}${c.detail?` — ${c.detail}`:''}`);
}

const failed=results.filter(r=>r.result==='FAIL');
const report={
  suite:'NoblePDF True Edit browser hard gate',
  engine:{dir:ENGINE,wasmSha256:E.info.wasmSha256},
  bridge:{path:BRIDGE,sha256:sha256(readFileSync(BRIDGE))},
  totals:{cases:results.length,passed:results.length-failed.length,failed:failed.length},
  gate:failed.length?'FAIL':'PASS',
  results,
};
writeFileSync(resolve(OUT,'report.json'),JSON.stringify(report,null,2));
const md=[
  '# NoblePDF True Edit — browser hard gate','',
  `Gate: **${report.gate}**`,
  `Cases: ${report.totals.passed}/${report.totals.cases} passed`,
  `Engine wasm: \`${report.engine.wasmSha256}\``,
  `Bridge: \`${report.bridge.sha256}\``, '',
  '| Case | Expected | Result | Failed checks |','|---|---|---|---|',
  ...results.map(r=>`| ${r.id} — ${r.title} | ${r.expect} | **${r.result}** | ${r.checks.filter(c=>!c.pass).map(c=>`${c.name}: ${String(c.detail||'').replace(/\|/g,'\\|').slice(0,180)}`).join('; ')||'—'} |`),
  '', '## Coverage', '',
  '- same-length, longer, shorter, spaces, rotation, tracking, horizontal scale and TJ-segmented text',
  '- repeated identical text at different positions and multiple edits on one page',
  '- ambiguity, custom formatting, auto-fit, vertical metadata, single glyphs, supplementary Unicode, Tw, fractional metrics, missing targets, degenerate matrices and fail-closed multi-edit rejection',
  '- PDFium reopen/search/copy semantics, exact text-object replacement, unchanged object census, no raster images, anchored start origin and untouched-object invariants',
  '- qpdf structural validation and independent Poppler text extraction in CI',
];
writeFileSync(resolve(OUT,'report.md'),md.join('\n')+'\n');
console.log(`\nHARD GATE: ${report.gate} (${report.totals.passed}/${report.totals.cases})`);
process.exit(failed.length?1:0);

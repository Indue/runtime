// NoblePDF True Edit Phase 8 — browser production bridge V1
// Built from the Phase 8 production-readiness model.
// This module is intentionally standalone. It does not change NoblePDF UI or export
// behaviour until editor-desktop.js / editor-touch.js explicitly call it.

const ENGINE_BASE = '/vendor/pdfium-2.15.1-setpositions/';
const ENGINE_TAG = 'noblepdf-true-edit-phase8-v1.2';

const GAP_MAX_EM = 0.08;
const PDFJS_MAX_EM = 0.095;
const GAP_MIN_EM = -0.15;
const FPDF_PAGEOBJ_TEXT = 1;

let enginePromise = null;

function finite(v){ return Number.isFinite(Number(v)); }
function normText(v){ return String(v ?? '').replace(/\s+/g,' ').trim(); }
function codepoints(s){ return Array.from(String(s ?? '')).map(ch=>ch.codePointAt(0)); }

function encodeUtf16z(str){
  const out = new Uint8Array((str.length + 1) * 2);
  for(let i=0;i<str.length;i++){
    const c=str.charCodeAt(i);
    out[i*2]=c & 255;
    out[i*2+1]=c >>> 8;
  }
  return out;
}

function decodeUtf16(heap, ptr, byteLen){
  let s='';
  for(let i=0;i+1<byteLen;i+=2){
    const c=heap[ptr+i] | (heap[ptr+i+1]<<8);
    if(c===0) break;
    s+=String.fromCharCode(c);
  }
  return s;
}

function invert(M){
  const det=M.a*M.d-M.b*M.c;
  return {
    det,
    a:M.d/det, b:-M.b/det, c:-M.c/det, d:M.a/det,
    e:(M.c*M.f-M.d*M.e)/det,
    f:(M.b*M.e-M.a*M.f)/det
  };
}

function apply(M,x,y){
  return {x:M.a*x+M.c*y+M.e,y:M.b*x+M.d*y+M.f};
}

function matrixGate(M){
  const vals=[M.a,M.b,M.c,M.d,M.e,M.f];
  if(!vals.every(Number.isFinite)) return {ok:false,reason:'non-finite matrix'};
  const n1=Math.hypot(M.a,M.b), n2=Math.hypot(M.c,M.d);
  if(n1<1e-9||n2<1e-9||n1>1e9||n2>1e9)
    return {ok:false,reason:`axis norm out of range (${n1}, ${n2})`};
  const sin=Math.abs(M.a*M.d-M.b*M.c)/(n1*n2);
  if(sin<1e-6) return {ok:false,reason:`degenerate matrix (sin=${sin})`};
  return {ok:true,sin};
}

function pageToObjectPositions(M,origins,{maxBaselineResidual=0.01}={}){
  const g=matrixGate(M);
  if(!g.ok) return {ok:false,reason:g.reason};
  const inv=invert(M), xs=[];
  let worstY=0;
  for(const o of origins){
    const p=apply(inv,o.x,o.y);
    worstY=Math.max(worstY,Math.abs(p.y));
    xs.push(p.x);
  }
  if(worstY>maxBaselineResidual)
    return {ok:false,reason:`origin off baseline by ${worstY}`};
  let worstFwd=0;
  xs.forEach((x,i)=>{
    const q=apply(M,x,0);
    worstFwd=Math.max(worstFwd,Math.hypot(q.x-origins[i].x,q.y-origins[i].y));
  });
  if(worstFwd>0.01) return {ok:false,reason:`forward check ${worstFwd}pt`};
  return {ok:true,xs,worstY,worstFwd};
}

function advance(code,isSpaceChar,run,widthOf){
  return (
    (widthOf(code)*run.size)/1000 +
    (run.tc ?? 0) +
    (isSpaceChar && run.fontIsSimple && code===32 ? (run.tw ?? 0) : 0)
  );
}

function layoutReplacement({oldCodes,oldXs,newCodes,newText,run,widthOf,fit=false}){
  const oldN=oldCodes.length,newN=newCodes.length;
  let p=0;
  while(p<oldN&&p<newN&&oldCodes[p]===newCodes[p]) p++;
  let s=0;
  while(s<oldN-p&&s<newN-p&&oldCodes[oldN-1-s]===newCodes[newN-1-s]) s++;

  const isSpace=i=>newText[i]===' ';
  const xs=new Array(newN);
  for(let i=0;i<p;i++) xs[i]=oldXs[i];

  let x=p>0
    ? xs[p-1]+advance(newCodes[p-1],isSpace(p-1),run,widthOf)
    : oldXs[0];

  for(let i=p;i<newN-s;i++){
    xs[i]=x;
    x+=advance(newCodes[i],isSpace(i),run,widthOf);
  }

  if(s>0){
    const shift=x-oldXs[oldN-s];
    for(let j=0;j<s;j++) xs[newN-s+j]=oldXs[oldN-s+j]+shift;
  }

  let fitInfo=null;
  if(fit){
    const oldEnd=oldXs[oldN-1]+advance(oldCodes[oldN-1],false,run,widthOf);
    const newEnd=xs[newN-1]+advance(newCodes[newN-1],isSpace(newN-1),run,widthOf);
    const slack=oldEnd-newEnd;
    const spaces=Array.from(newText).map((c,i)=>(c===' '&&i>0&&i<newN-1?i:-1)).filter(i=>i>=0);
    if(spaces.length&&Math.abs(slack)>1e-6){
      const per=slack/spaces.length;
      const spaceAdv=advance(newCodes[spaces[0]],true,run,widthOf);
      if(per>=-0.75*spaceAdv){
        let acc=0;
        for(let i=0;i<newN;i++){
          xs[i]+=acc;
          if(spaces.includes(i)) acc+=per;
        }
        fitInfo={slack,perSpace:per,spaces:spaces.length};
      }else{
        fitInfo={slack,perSpace:per,spaces:spaces.length,skipped:'would collapse spaces'};
      }
    }else{
      fitInfo={slack,spaces:spaces.length,skipped:spaces.length?'no slack':'no real spaces'};
    }
  }
  return {xs,prefix:p,suffix:s,fit:fitInfo};
}

function semanticGapLint({xs,newCodes,newText,run,widthOf}){
  const tcEm=(run.tc??0)/run.size;
  let worst=null;
  const bad=[];
  for(let i=0;i+1<xs.length;i++){
    if(newText[i]===' '||newText[i+1]===' ') continue;
    const extra=xs[i+1]-xs[i]-advance(newCodes[i],false,run,widthOf);
    const em=extra/run.size;
    const pdfiumBad=em>GAP_MAX_EM||em<GAP_MIN_EM;
    const pdfjsBad=em+tcEm>Math.max(PDFJS_MAX_EM,tcEm);
    if(!worst||Math.abs(em)>Math.abs(worst.em)) worst={i,em:+em.toFixed(4)};
    if(pdfiumBad||pdfjsBad) bad.push({i,pair:newText.slice(i,i+2),em:+em.toFixed(4)});
  }
  return {ok:bad.length===0,bad,worst};
}

class BrowserPdfium {
  constructor(m){
    this.m=m;
    this.p=m.pdfium;
  }
  malloc(n){
    const ptr=this.p.wasmExports.malloc(Math.max(1,n));
    if(!ptr) throw new Error('PDFium malloc failed');
    return ptr;
  }
  free(ptr){ if(ptr) this.p.wasmExports.free(ptr); }
  withAlloc(n,fn){
    const ptr=this.malloc(n);
    try{return fn(ptr);}finally{this.free(ptr);}
  }
  openDocument(bytes){
    const src=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
    const ptr=this.malloc(src.length);
    this.p.HEAPU8.set(src,ptr);
    const doc=this.m.FPDF_LoadMemDocument(ptr,src.length,'');
    if(!doc){
      this.free(ptr);
      throw new Error(`FPDF_LoadMemDocument failed (${this.m.FPDF_GetLastError()})`);
    }
    return {doc,ptr};
  }
  closeDocument(h){
    if(!h) return;
    try{this.m.FPDF_CloseDocument(h.doc);}finally{this.free(h.ptr);}
  }
  loadPage(doc,index0){
    const page=this.m.FPDF_LoadPage(doc,index0);
    if(!page) throw new Error(`Could not load PDF page ${index0+1}`);
    return page;
  }
  matrix(obj){
    return this.withAlloc(24,ptr=>{
      if(!this.m.FPDFPageObj_GetMatrix(obj,ptr)) throw new Error('FPDFPageObj_GetMatrix failed');
      const f=this.p.HEAPF32, q=ptr>>2;
      return {a:f[q],b:f[q+1],c:f[q+2],d:f[q+3],e:f[q+4],f:f[q+5]};
    });
  }
  bounds(obj){
    return this.withAlloc(16,ptr=>{
      if(!this.m.FPDFPageObj_GetBounds(obj,ptr,ptr+4,ptr+8,ptr+12)) throw new Error('FPDFPageObj_GetBounds failed');
      const f=this.p.HEAPF32, q=ptr>>2;
      return {left:f[q],bottom:f[q+1],right:f[q+2],top:f[q+3]};
    });
  }
  fontSize(obj){
    return this.withAlloc(4,ptr=>{
      if(!this.m.FPDFTextObj_GetFontSize(obj,ptr)) throw new Error('FPDFTextObj_GetFontSize failed');
      return this.p.HEAPF32[ptr>>2];
    });
  }
  textObjText(obj,textPage){
    const len=this.m.FPDFTextObj_GetText(obj,textPage,0,0);
    if(len<=0) return '';
    return this.withAlloc(len,ptr=>{
      this.m.FPDFTextObj_GetText(obj,textPage,ptr,len);
      return decodeUtf16(this.p.HEAPU8,ptr,len);
    });
  }
  glyphsForObject(textPage,obj){
    const n=this.m.FPDFText_CountChars(textPage);
    const out=[];
    this.withAlloc(16,ptr=>{
      for(let i=0;i<n;i++){
        if(this.m.FPDFText_IsGenerated(textPage,i)===1) continue;
        if(this.m.FPDFText_GetTextObject(textPage,i)!==obj) continue;
        this.m.FPDFText_GetCharOrigin(textPage,i,ptr,ptr+8);
        const d=this.p.HEAPF64;
        out.push({
          unicode:this.m.FPDFText_GetUnicode(textPage,i),
          x:d[ptr>>3],
          y:d[(ptr>>3)+1]
        });
      }
    });
    return out;
  }
  glyphWidth1000(font,unicode){
    return this.withAlloc(4,ptr=>{
      if(!this.m.FPDFFont_GetGlyphWidth(font,unicode,1000,ptr))
        throw new Error(`No glyph width for U+${unicode.toString(16).toUpperCase()}`);
      return this.p.HEAPF32[ptr>>2];
    });
  }
  setText(obj,text){
    const bytes=encodeUtf16z(text);
    return this.withAlloc(bytes.length,ptr=>{
      this.p.HEAPU8.set(bytes,ptr);
      return !!this.m.FPDFText_SetText(obj,ptr);
    });
  }
  setPositions(obj,positions){
    return this.withAlloc(Math.max(4,positions.length*4),ptr=>{
      this.p.HEAPF32.set(positions,ptr>>2);
      return !!this.m.FPDFText_SetPositions(obj,ptr,positions.length);
    });
  }
  save(doc){
    const w=this.m.PDFiumExt_OpenFileWriter();
    if(!w) throw new Error('Could not create PDFium writer');
    try{
      if(!this.m.PDFiumExt_SaveAsCopy(doc,w)) throw new Error('PDFium save failed');
      const size=this.m.PDFiumExt_GetFileWriterSize(w);
      return this.withAlloc(size,buf=>{
        this.m.PDFiumExt_GetFileWriterData(w,buf,size);
        return this.p.HEAPU8.slice(buf,buf+size);
      });
    }finally{
      this.m.PDFiumExt_CloseFileWriter(w);
    }
  }
}

async function loadEngine(){
  if(enginePromise) return enginePromise;
  enginePromise=(async()=>{
    const wasmUrl=`${ENGINE_BASE}pdfium.wasm?trueedit=${ENGINE_TAG}`;
    const jsUrl=`${ENGINE_BASE}index.js?trueedit=${ENGINE_TAG}`;
    const wr=await fetch(wasmUrl,{cache:'no-store',credentials:'same-origin'});
    if(!wr.ok) throw new Error(`Patched PDFium WASM returned HTTP ${wr.status}`);
    const wasmBinary=await wr.arrayBuffer();
    const mod=await import(jsUrl);
    const init=mod.init||mod.default;
    if(typeof init!=='function') throw new Error('Patched PDFium module does not export init()');
    const m=await init({wasmBinary});
    m.PDFiumExt_Init?.();

    const required=[
      'FPDF_LoadMemDocument','FPDF_CloseDocument','FPDF_LoadPage','FPDF_ClosePage',
      'FPDFText_LoadPage','FPDFText_ClosePage','FPDFText_CountChars',
      'FPDFText_GetUnicode','FPDFText_GetCharOrigin','FPDFText_GetTextObject',
      'FPDFPage_CountObjects','FPDFPage_GetObject','FPDFPageObj_GetType',
      'FPDFPageObj_GetMatrix','FPDFPageObj_GetBounds','FPDFTextObj_GetText','FPDFTextObj_GetFont',
      'FPDFTextObj_GetFontSize','FPDFFont_GetGlyphWidth','FPDFText_SetText',
      'FPDFText_SetPositions','FPDFPage_GenerateContent','PDFiumExt_OpenFileWriter',
      'PDFiumExt_SaveAsCopy','PDFiumExt_GetFileWriterSize',
      'PDFiumExt_GetFileWriterData','PDFiumExt_CloseFileWriter'
    ];
    const missing=required.filter(k=>typeof m[k]!=='function');
    if(missing.length) throw new Error(`Patched PDFium missing: ${missing.join(', ')}`);
    return new BrowserPdfium(m);
  })();
  return enginePromise;
}

function candidateScore(candidate,edit){
  if(normText(candidate.text)!==normText(edit.originalText)) return null;

  let score=100;
  const expected=Array.isArray(edit.sourceTextTransform)&&edit.sourceTextTransform.length>=6
    ? {x:Number(edit.sourceTextTransform[4]),y:Number(edit.sourceTextTransform[5])}
    : null;

  if(expected&&finite(expected.x)&&finite(expected.y)&&candidate.glyphs.length){
    const first=candidate.glyphs[0];
    const dist=Math.hypot(first.x-expected.x,first.y-expected.y);
    if(dist>2.0) return null;
    score+=Math.max(0,25-dist*10);
    candidate.originDistance=dist;
  }

  const declared=Number(edit.pdfDeclaredFontSize);
  if(Number.isFinite(declared)&&declared>0){
    const delta=Math.abs(candidate.fontSize-declared);
    if(delta>Math.max(0.75,declared*0.08)) return null;
    score+=Math.max(0,10-delta*5);
  }

  const sourceCount=Number(edit.sourceGlyphCount||0);
  if(sourceCount>0){
    if(candidate.glyphs.length!==sourceCount) return null;
    score+=8;
  }

  return score;
}

function collectTextObjects(E,page,textPage){
  const out=[];
  const n=E.m.FPDFPage_CountObjects(page);
  for(let i=0;i<n;i++){
    const obj=E.m.FPDFPage_GetObject(page,i);
    if(!obj||E.m.FPDFPageObj_GetType(obj)!==FPDF_PAGEOBJ_TEXT) continue;
    const text=E.textObjText(obj,textPage);
    const glyphs=E.glyphsForObject(textPage,obj);
    let matrix,fontSize,font,bounds;
    try{
      matrix=E.matrix(obj);
      bounds=E.bounds(obj);
      fontSize=E.fontSize(obj);
      font=E.m.FPDFTextObj_GetFont(obj);
    }catch{continue;}
    if(!font) continue;
    out.push({obj,index:i,text,glyphs,matrix,bounds,fontSize,font});
  }
  return out;
}

function sameSourceGeometry(a,b){
  if(!a?.matrix||!b?.matrix) return false;
  const mKeys=['a','b','c','d','e','f'];
  if(!mKeys.every(k=>Math.abs(Number(a.matrix[k])-Number(b.matrix[k]))<=0.002)) return false;
  if(Math.abs(Number(a.fontSize)-Number(b.fontSize))>0.02) return false;
  const A=a.bounds,B=b.bounds;
  if(!A||!B) return true;
  return ['left','bottom','right','top'].every(k=>Math.abs(Number(A[k])-Number(B[k]))<=0.02);
}

function validateEditInput(edit){
  if(!edit||typeof edit!=='object') return 'missing edit metadata';
  if(!Number.isInteger(Number(edit.pageIndex))||Number(edit.pageIndex)<1) return 'invalid source page index';
  if(!normText(edit.originalText)) return 'missing original text';
  if(typeof edit.newText!=='string'||!edit.newText.length) return 'replacement text is empty';
  if(edit.newText.includes('\n')||edit.newText.includes('\r')) return 'multi-line replacement is not enabled in True Edit V1';
  if(edit.verticalText) return 'vertical text is not enabled in True Edit V1';
  if(edit.matchOriginal===false) return 'custom formatting uses the existing flatten fallback';
  if(edit.autoFit) return 'font-size auto-fit uses the existing flatten fallback';

  const cps=codepoints(edit.newText);
  if(cps.length<2) return 'single-glyph text objects stay on the existing fallback in V1';
  if(cps.some(cp=>cp>0xFFFF)) return 'supplementary Unicode characters stay on the existing fallback in V1';

  // Phase 8 validated fractional-width PDFs as a BLOCK condition. PDF.js stores
  // source glyph widths in the glyph plan, so reject obviously fractional source
  // metrics here before touching the object.
  const plan=Array.isArray(edit.sourceGlyphPlan)?edit.sourceGlyphPlan:[];
  const widths=plan.filter(x=>x?.type==='glyph'&&finite(x.width)).map(x=>Number(x.width));
  if(widths.some(w=>Math.abs(w-Math.round(w))>1e-5))
    return 'fractional source font widths are blocked by the Phase 8 production gate';

  return '';
}

async function mutatePage(E,doc,edit,usedObjects){
  const inputError=validateEditInput(edit);
  if(inputError) return {ok:false,reason:inputError};

  const pageIndex=Number(edit.pageIndex)-1;
  const page=E.loadPage(doc,pageIndex);
  const textPage=E.m.FPDFText_LoadPage(page);
  if(!textPage){
    E.m.FPDF_ClosePage(page);
    return {ok:false,reason:'PDFium could not load the text layer'};
  }

  try{
    const objects=collectTextObjects(E,page,textPage);
    const scored=[];
    for(const c of objects){
      const objectKey=`${pageIndex}:${c.index}`;
      if(usedObjects.has(objectKey)) continue;
      const score=candidateScore(c,edit);
      if(score!=null) scored.push({c,score});
    }
    scored.sort((a,b)=>b.score-a.score);

    if(!scored.length) return {ok:false,reason:'could not uniquely locate the original PDF text object'};
    if(scored.length>1 && Math.abs(scored[0].score-scored[1].score)<0.01)
      return {ok:false,reason:'more than one original PDF text object matched; refusing to guess'};

    const target=scored[0].c;

    // PDFium's text-page extraction may deduplicate perfectly overlapping text.
    // A second page text object can therefore exist at the exact same geometry
    // while exposing no text/glyphs through FPDFTextObj_GetText/GetTextObject.
    // Fail closed instead of silently editing only one visible duplicate.
    const geometryTwins=objects.filter(c=>c.obj!==target.obj&&sameSourceGeometry(c,target));
    if(geometryTwins.length)
      return {ok:false,reason:'overlapping text objects share the same source geometry; refusing ambiguous True Edit'};

    usedObjects.add(`${pageIndex}:${target.index}`);

    const oldOrigins=target.glyphs.map(g=>({x:g.x,y:g.y}));
    const conv=pageToObjectPositions(target.matrix,oldOrigins);
    if(!conv.ok) return {ok:false,reason:`geometry gate blocked edit: ${conv.reason}`};

    const oldCodes=target.glyphs.map(g=>g.unicode);
    const newCodes=codepoints(edit.newText);
    const font=target.font;

    const widthCache=new Map();
    const widthOf=unicode=>{
      if(widthCache.has(unicode)) return widthCache.get(unicode);
      const w=E.glyphWidth1000(font,unicode);
      if(!Number.isFinite(w)||w<=0) throw new Error(`invalid glyph width for U+${unicode.toString(16).toUpperCase()}`);
      // K1/K2 production gate: fractional /Widths or W values remain blocked.
      if(Math.abs(w-Math.round(w))>1e-4)
        throw new Error(`fractional glyph width blocked for U+${unicode.toString(16).toUpperCase()}`);
      widthCache.set(unicode,w);
      return w;
    };

    // Prime widths before mutating anything.
    [...new Set([...oldCodes,...newCodes])].forEach(widthOf);

    const tc=Number(edit.charSpacing||0);
    const tw=Number(edit.wordSpacing||0);
    if(tw!==0 && edit.newText.includes(' '))
      return {ok:false,reason:'non-zero word spacing with spaces stays on the fallback until simple/CID font classification is wired'};

    const run={
      size:target.fontSize,
      tc:Number.isFinite(tc)?tc:0,
      tw:Number.isFinite(tw)?tw:0,
      fontIsSimple:true
    };

    const layout=layoutReplacement({
      oldCodes,oldXs:conv.xs,newCodes,newText:edit.newText,run,widthOf,fit:false
    });

    const lint=semanticGapLint({
      xs:layout.xs,newCodes,newText:edit.newText,run,widthOf
    });
    if(!lint.ok)
      return {ok:false,reason:`semantic gap gate blocked edit (${JSON.stringify(lint.bad.slice(0,4))})`};

    if(!E.setText(target.obj,edit.newText))
      return {ok:false,reason:'FPDFText_SetText rejected the replacement'};

    if(!E.setPositions(target.obj,layout.xs.slice(1)))
      return {ok:false,reason:'FPDFText_SetPositions rejected the replacement'};

    if(!E.m.FPDFPage_GenerateContent(page))
      return {ok:false,reason:'FPDFPage_GenerateContent failed'};

    return {
      ok:true,
      objectIndex:target.index,
      prefix:layout.prefix,
      suffix:layout.suffix,
      worstGapEm:lint.worst?.em ?? 0,
      originDistance:target.originDistance ?? null
    };
  }finally{
    E.m.FPDFText_ClosePage(textPage);
    E.m.FPDF_ClosePage(page);
  }
}

export async function preflight(){
  try{
    const E=await loadEngine();
    return {
      ok:true,
      setPositions:typeof E.m.FPDFText_SetPositions==='function',
      engineBase:ENGINE_BASE,
      version:'phase8-browser-bridge-v1.2'
    };
  }catch(err){
    return {ok:false,reason:String(err?.message||err)};
  }
}

// edits[] fields expected from NoblePDF:
// {
//   pageIndex: 1-based original PDF page,
//   originalText, newText,
//   sourceTextTransform, pdfDeclaredFontSize,
//   sourceGlyphCount, sourceGlyphPlan,
//   charSpacing, wordSpacing, verticalText,
//   matchOriginal, autoFit
// }
//
// Safety contract:
// - Any unsupported/ambiguous edit returns ok:false.
// - Caller should then use NoblePDF's existing flatten fallback.
// - This module never silently chooses an ambiguous source object.
export async function tryTrueEditPdf(sourceBytes,edits){
  if(!(sourceBytes instanceof Uint8Array)) sourceBytes=new Uint8Array(sourceBytes);
  if(!Array.isArray(edits)||!edits.length)
    return {ok:false,reason:'no True Edit replacements supplied'};

  const E=await loadEngine();
  const h=E.openDocument(sourceBytes);
  const usedObjects=new Set();
  const results=[];

  try{
    if(typeof E.m.FPDF_GetSignatureCount==='function'){
      const signatures=E.m.FPDF_GetSignatureCount(h.doc);
      if(signatures>0)
        return {ok:false,reason:'digitally signed PDFs stay on the safe fallback',results};
    }

    for(const edit of edits){
      const r=await mutatePage(E,h.doc,edit,usedObjects);
      results.push(r);
      if(!r.ok) return {ok:false,reason:r.reason,results};
    }

    const bytes=E.save(h.doc);
    return {
      ok:true,
      bytes,
      results,
      stats:{trueEdited:results.length,fallback:0},
      version:'phase8-browser-bridge-v1.2'
    };
  }catch(err){
    return {ok:false,reason:String(err?.message||err),results};
  }finally{
    E.closeDocument(h);
  }
}

export const TrueEditPhase8 = Object.freeze({
  preflight,
  tryTrueEditPdf,
  version:'phase8-browser-bridge-v1.2'
});

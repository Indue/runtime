// Minimal single-page PDF writer for Node tests (independent of the lab code).
export function mkpdf(content, fonts = { F1: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' }) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', null, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  const refs = [];
  for (const [k, v] of Object.entries(fonts)) { objs.push(v); refs.push(`/${k} ${objs.length} 0 R`); }
  objs[2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${refs.join(' ')} >> >> /Contents 4 0 R >>`;
  let out = '%PDF-1.7\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.codePointAt(0) & 0xff);
}

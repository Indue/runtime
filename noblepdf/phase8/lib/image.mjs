// Pixel comparison. `exclude` rectangles are in page points (PDF user space,
// origin bottom-left) and are converted to pixel space with `scale`.
export function diff(a, b, { scale, pageHeight, exclude = [], include = null } = {}) {
  if (a.w !== b.w || a.h !== b.h) {
    return { comparable: false, changed: Infinity, maxDelta: 255, total: 0 };
  }
  const toPx = (r) => ({
    x0: Math.floor(r.left * scale) - 2,
    x1: Math.ceil(r.right * scale) + 2,
    y0: Math.floor((pageHeight - r.top) * scale) - 2,
    y1: Math.ceil((pageHeight - r.bottom) * scale) + 2,
  });
  const ex = exclude.map(toPx);
  const inc = include ? include.map(toPx) : null;
  let changed = 0;
  let maxDelta = 0;
  let total = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const inEx = ex.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
      if (inEx) continue;
      if (inc && !inc.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) continue;
      total++;
      const i = (y * a.w + x) * 4;
      const d = Math.max(
        Math.abs(a.rgba[i] - b.rgba[i]),
        Math.abs(a.rgba[i + 1] - b.rgba[i + 1]),
        Math.abs(a.rgba[i + 2] - b.rgba[i + 2]),
      );
      if (d > 0) {
        changed++;
        if (d > maxDelta) maxDelta = d;
      }
    }
  }
  return { comparable: true, changed, maxDelta, total };
}

export function inked(img) {
  let n = 0;
  for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i] < 250) n++;
  return n;
}

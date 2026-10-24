/* The EEES field: streamlines of a point sink with circulation and a weak uniform flow.
   Shared by the static build (Fig. 1 as SVG), the application server (same figure on the
   account pages) and, through the parameters it exports, the live version in field-live.js. */

export const FIELD = { w: 600, h: 480, sink: [402, 226], k: 6200, u0: 7, gamma: 2600 };

export function velocity(x, y, p = FIELD) {
  const dx = x - p.sink[0], dy = y - p.sink[1], r2 = dx * dx + dy * dy + 1e-6;
  return { x: p.u0 - p.k * dx / r2 - p.gamma * dy / r2, y: -p.k * dy / r2 + p.gamma * dx / r2 };
}

function trace(x0, y0, p) {
  const pts = [[x0, y0]]; let x = x0, y = y0; const h = 0.9;
  for (let i = 0; i < 4000; i++) {
    const v1 = velocity(x, y, p), n1 = Math.hypot(v1.x, v1.y) || 1;
    const mx = x + h * v1.x / n1 / 2, my = y + h * v1.y / n1 / 2;
    const v2 = velocity(mx, my, p), n2 = Math.hypot(v2.x, v2.y) || 1;
    x += h * v2.x / n2; y += h * v2.y / n2;
    if (x < -2 || x > p.w + 2 || y < -2 || y > p.h + 2) break;
    pts.push([x, y]);
    if (Math.hypot(x - p.sink[0], y - p.sink[1]) < 7) break;
  }
  return pts;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let maxD = 0, idx = 0;
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) { const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps); return l.slice(0, -1).concat(r); }
  return [a, b];
}

export function streamlineSvg(p = FIELD) {
  const { w: W, h: H } = p;
  const seeds = [];
  for (let y = 16; y <= H - 16; y += 36) seeds.push([0, y]);
  for (let x = 52; x <= W; x += 66) { seeds.push([x, 0]); seeds.push([x, H]); }
  for (let y = 36; y <= H - 36; y += 66) seeds.push([W, y]);
  const paths = seeds.map((s) => rdp(trace(s[0], s[1], p), 0.45)).filter((q) => q.length > 4)
    .map((q) => 'M' + q.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L'));
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
${paths.map((d, i) => `<path d="${d}" pathLength="1"${i % 4 === 1 ? ' class="lum"' : ''}/>`).join('\n')}
<circle cx="${p.sink[0]}" cy="${p.sink[1]}" r="3"/>
</svg>`;
}

export const fieldAttrs = (p = FIELD) => ` data-live data-field='${JSON.stringify(p)}'`;

// The page's sample piece (web/src/loaders.js sampleModel) without three.js: a base, a tower and
// an arm whose underside needs support. Returns x,y,z per corner, centred on 0,0, bottom at 0.
function box(out, x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]]) {
    out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  }
}

export function sampleModel() {
  const t = [];
  box(t, -20, -12, 0, 20, 12, 5);
  box(t, -20, -8, 5, -6, 8, 40);
  box(t, -6, -8, 30, 22, 8, 38);
  const minX = -20, maxX = 22; // centre on X like the page does
  for (let i = 0; i < t.length; i += 3) t[i] -= (minX + maxX) / 2;
  return t;
}

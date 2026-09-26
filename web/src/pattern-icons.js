// Little pictures of each infill pattern, drawn as SVG, so students can see what they pick.
// Each one is what a single layer looks like from above (cubic is shown as stacked cubes, which
// is easier to understand than its tilted slice).

const S = 40; // viewBox size

function lines(angleDeg, spacing, offset = 0) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  const nx = -dy, ny = dx;
  const out = [];
  for (let d = -S * 1.5 + offset; d <= S * 1.5; d += spacing) {
    const cx = S / 2 + nx * d, cy = S / 2 + ny * d;
    out.push(`M${(cx - dx * S).toFixed(1)} ${(cy - dy * S).toFixed(1)}L${(cx + dx * S).toFixed(1)} ${(cy + dy * S).toFixed(1)}`);
  }
  return out.join('');
}

function gyroid() {
  const out = [];
  for (let row = -1; row < 6; row++) {
    let d = '';
    for (let x = 0; x <= S; x += 2) {
      const y = row * 8 + 4 + Math.sin((x / S) * Math.PI * 3 + row * 1.2) * 3.2;
      d += `${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(1)}`;
    }
    out.push(d);
  }
  return out.join('');
}

function cubes() {
  // "Tumbling blocks": hexagons split into three faces, which reads as a stack of cubes.
  const r = 7.5;
  const w = r * Math.sqrt(3);
  const out = [];
  for (let row = -1; row < 5; row++) {
    for (let col = -1; col < 4; col++) {
      const cx = col * w + (row % 2 ? w / 2 : 0) + 4;
      const cy = row * r * 1.5 + 4;
      const v = [];
      for (let k = 0; k < 6; k++) {
        const a = ((60 * k - 90) * Math.PI) / 180;
        v.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      out.push(`M${v.map((p) => p.map((n) => n.toFixed(1)).join(' ')).join('L')}Z`);
      for (const k of [1, 3, 5]) out.push(`M${cx.toFixed(1)} ${cy.toFixed(1)}L${v[k][0].toFixed(1)} ${v[k][1].toFixed(1)}`);
    }
  }
  return out.join('');
}

function lightning() {
  return [
    'M20 40L20 26L12 16L8 4', 'M20 26L29 17L33 5', 'M12 16L17 5', 'M29 17L24 6',
    'M20 26L6 28', 'M20 32L34 30', 'M6 28L2 22', 'M34 30L38 22',
  ].join('');
}

const PATHS = {
  grid: () => lines(45, 8) + lines(-45, 8),
  lines: () => lines(45, 6),
  triangles: () => lines(0, 8) + lines(60, 8) + lines(120, 8),
  trihexagon: () => lines(0, 10, 2.5) + lines(60, 10) + lines(120, 10, 5),
  cubic: cubes,
  gyroid,
  lightning,
};

export function patternIcon(id) {
  const d = (PATHS[id] ?? PATHS.grid)();
  return `<svg class="pattern-svg" viewBox="0 0 ${S} ${S}" width="40" height="40" aria-hidden="true">
    <defs><clipPath id="pc-${id}"><rect x="1" y="1" width="${S - 2}" height="${S - 2}" rx="5"/></clipPath></defs>
    <rect x="1" y="1" width="${S - 2}" height="${S - 2}" rx="5" class="pattern-bg"/>
    <path d="${d}" clip-path="url(#pc-${id})" class="pattern-line"/>
    <rect x="1" y="1" width="${S - 2}" height="${S - 2}" rx="5" class="pattern-wall"/>
  </svg>`;
}

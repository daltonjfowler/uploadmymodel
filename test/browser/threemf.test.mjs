// 3MF files carry a unit; a 1-unit cube in inches must open 25.4 mm wide, in mm 1 mm wide.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { BASE, CHROME, OUT } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';

function cube3mf(unit, size) {
  const v = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0], [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]];
  const t = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="1" type="model"><mesh>
  <vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>
  <triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles>
 </mesh></object></resources>
 <build><item objectid="1"/></build>
</model>`;
  const rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const file = `${OUT}cube-${unit}.3mf`;
  writeFileSync(file, zipSync({ '[Content_Types].xml': strToU8(types), '_rels/.rels': strToU8(rels), '3D/3dmodel.model': strToU8(model) }));
  return file;
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
await page.goto(base);
await page.waitForTimeout(400);
const size = (i) => page.evaluate((k) => { const s = window.umm.viewer.models[k].size; return [s.x, s.y, s.z].map((n) => Math.round(n * 100) / 100); }, i);
await page.setInputFiles('#fileInput', cube3mf('inch', 1));
await page.waitForFunction(() => window.umm.viewer.models.length === 1);
check('inch 3MF opens at 25.4 mm', await size(0), [25.4, 25.4, 25.4]);
await page.setInputFiles('#fileInput', cube3mf('millimeter', 20));
await page.waitForFunction(() => window.umm.viewer.models.length === 2);
check('mm 3MF opens at its size', await size(1), [20, 20, 20]);
await page.setInputFiles('#fileInput', cube3mf('centimeter', 2));
await page.waitForFunction(() => window.umm.viewer.models.length === 3);
check('cm 3MF opens at 20 mm', await size(2), [20, 20, 20]);
console.log(errors.join('\n') || 'no errors');
await browser.close();

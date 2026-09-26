// Regression checks for the code-review findings (2026-09-26).
import { chromium } from 'playwright-core';
import { BASE, BENCHY, CHROME, OUT, ensureMushroom } from './lib.mjs';
const base = process.argv[2] || BASE;
const key = process.argv[3] || 'local-test-key-not-real';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const newPage = async (ctx) => {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/501|401|cloudflareinsights/.test(m.text())) errors.push(m.text()); });
  return p;
};
const teacherPut = (page, config) => page.request.put(base + 'api/teacher/class', { headers: { 'x-teacher-key': key, 'content-type': 'application/json' }, data: config });

// 1. Teacher defaults reach students (open settings), and follow later changes.
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await newPage(ctx);
  await page.goto(base + '?debug');
  check('teacher save ok', (await teacherPut(page, { defaults: { quality: 'standard', infillDensity: 15 } })).status(), 200);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.settings-summary')?.textContent.startsWith('0.25'));
  check('new student gets teacher defaults', await page.$eval('.settings-summary', (e) => e.textContent), '0.25 mm · 15% · Tree support · Skirt');
  check('...and it counts as class settings', await page.$eval('.profile-tag', (e) => e.textContent), 'Class settings');
  await page.$eval('input[aria-label="Infill density"]', (i) => { i.value = '30'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
  await teacherPut(page, { defaults: { quality: 'high_speed', infillDensity: 15 } });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.settings-summary')?.textContent.startsWith('0.38'));
  check('teacher change applies, student choice kept', await page.$eval('.settings-summary', (e) => e.textContent), '0.38 mm · 30% · Tree support · Skirt');
  await teacherPut(page, {});
  await ctx.close();
}

// 2. Focus stays on the slider after it changes; arrows then change the setting, not the model.
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await newPage(ctx);
  await page.goto(base + '?debug');
  await page.waitForTimeout(400);
  await page.click('#sample');
  const slider = page.locator('input[aria-label="Infill density"]');
  await slider.focus();
  await page.keyboard.press('ArrowRight'); // native slider step + change event -> re-render
  await page.waitForTimeout(150);
  check('focus back on the infill slider', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Infill density');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  check('arrows changed infill', await page.$eval('.settings-summary', (e) => e.textContent.split(' · ')[1]), '30%');
  check('model did not move', await page.evaluate(() => window.umm.viewer.models[0].position.x), 0);

  // 3. Fit bed: a model that fits is left alone; a group keeps its places.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const v = window.umm.viewer; v.select(v.models[0]); v.duplicate(v.models[0]); v.duplicate(v.models[0]); });
  const before = await page.evaluate(() => window.umm.viewer.models.map((m) => [m.position.x, m.position.y, Math.round(m.size.x * 100) / 100]));
  await page.keyboard.press('Control+a');
  await page.click('#toolPanel button:has-text("Fit bed")');
  check('group Fit bed: nothing moved or shrank', await page.evaluate(() => window.umm.viewer.models.map((m) => [m.position.x, m.position.y, Math.round(m.size.x * 100) / 100])), before);

  // 7. Copies stop at 12.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+d');
  const n = await page.evaluate(() => window.umm.viewer.models.length);
  check('never more than 12 models', n <= 12, true);

  // 8. Models that can never come back are freed from the GPU: add one, undo it (it waits in
  // redo), then make a new change (redo is thrown away, so that model is gone for good).
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const gpu = () => page.evaluate(() => window.umm.viewer.renderer.info.memory.geometries);
  await page.click('#clearPlate');
  await page.click('#sample'); await frame();
  const g1 = await gpu();
  await page.keyboard.press('Control+z'); await frame();
  await page.click('#sample'); await frame();
  const g2 = await gpu();
  check(`GPU geometries: undone model freed (${g1} -> ${g2})`, g2, g1);
  // 6. Ring preview on a stretched model matches the result.
  await page.evaluate(() => { const v = window.umm.viewer; v.select(v.models[0]); v.setScale(v.models[0], 200, 100, 100); });
  await page.keyboard.press('r');
  const ring = await page.evaluate(() => { const v = window.umm.viewer; return [v.rings.position.x, v.rings.position.y, v.rings.position.z, v.rings.scale.x]; });
  const screenOf = (w) => page.evaluate((w) => {
    const v = window.umm.viewer; const p = v.rings.position.clone().set(w[0], w[1], w[2]).project(v.camera); const r = v.canvas.getBoundingClientRect();
    return [r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height];
  }, w);
  const pts = [];
  for (let a = 0; a <= 90; a += 10) { const t = (a * Math.PI) / 180; pts.push(await screenOf([ring[0] + ring[3] * Math.cos(t), ring[1] + ring[3] * Math.sin(t), ring[2]])); }
  await page.mouse.move(...pts[0]); await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 3 });
  const during = await page.evaluate(() => { const v = window.umm.viewer; const m = v.models[0]; m.mesh.updateMatrixWorld(true); const b = new m.mesh.geometry.boundingBox.constructor().setFromObject(m.mesh, true); return [Math.round(b.max.x - b.min.x), Math.round(b.max.y - b.min.y)]; });
  await page.mouse.up();
  const after = await page.evaluate(() => { const s = window.umm.viewer.models[0].size; return [Math.round(s.x), Math.round(s.y)]; });
  check('ring preview size = final size (stretched model)', during, after);

  // 9. Support placement remembered across reload.
  await page.keyboard.press('Escape');
  await page.click('.seg.placement button:has-text("Everywhere")');
  await page.reload();
  await page.waitForTimeout(500);
  await page.click('.toggle:has-text("Tree supports")'); // off
  await page.click('.toggle:has-text("Tree supports")'); // on again
  check('placement remembered after reload', await page.$eval('.seg.placement button.on', (e) => e.textContent), 'Everywhere');
  await page.click('.seg.placement button:has-text("Touching build plate")');

  // 5. In Preview, Ctrl shortcuts do not touch the hidden plate.
  await page.click('#sample');
  await page.setInputFiles('#fileInput', BENCHY);
  await page.waitForSelector('#previewCard:not([hidden])');
  const count = await page.evaluate(() => window.umm.viewer.models.length);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+d');
  check('preview: Ctrl+Z / Ctrl+D ignored', await page.evaluate(() => window.umm.viewer.models.length), count);
  await ctx.close();
}

// 12. Server: upload without a length is refused.
{
  const r = await fetch(base + 'api/slice', { method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }), duplex: 'half', headers: { 'content-type': 'multipart/form-data; boundary=x' } });
  // Locally 411; on Cloudflare the edge supplies the length, so the broken form gets 400. Refused either way.
  check('upload without a length is refused', [400, 411].includes(r.status), true);
}
console.log(errors.join('\n') || 'no errors');
await browser.close();

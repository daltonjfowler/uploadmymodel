// axe-core accessibility scan of the main screens, light and dark. Any problem fails the test.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BASE, BENCHY, CHROME } from './lib.mjs';
const axe = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const base = process.argv[2] || BASE;
const key = process.argv[3] || 'local-test-key-not-real';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const scan = async (page, label) => {
  await page.addScriptTag({ content: axe });
  const r = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  console.log(`${r.violations.length ? 'FAIL' : 'PASS'} ${label}: ${r.violations.length} kinds of problem`);
  if (r.violations.length) process.exitCode = 1;
  for (const v of r.violations) {
    console.log(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}x)`);
    for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target.join(' ')} ${n.any?.[0]?.message ? '- ' + n.any[0].message.slice(0, 140) : ''}`);
  }
};
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, colorScheme: scheme, bypassCSP: true });
  await page.goto(base);
  await page.waitForTimeout(500);
  await scan(page, `${scheme}: empty student page`);
  await page.click('#sample');
  await page.click('.seg.tabs button:nth-child(2)');
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  await scan(page, `${scheme}: model + custom settings + rotate`);
  await page.setInputFiles('#fileInput', BENCHY);
  await page.waitForSelector('#previewCard:not([hidden])');
  await scan(page, `${scheme}: preview`);
  await page.goto(base + 'teacher/');
  await page.fill('#key', key);
  await page.click('#load');
  await page.waitForSelector('#setup:not([hidden])');
  await scan(page, `${scheme}: teacher page`);
  await page.close();
}
await browser.close();

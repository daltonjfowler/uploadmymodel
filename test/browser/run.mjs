// Run the browser tests against a running site and print a summary.
//   npm run test:browser                          # local wrangler dev on :8787 (npm run dev first)
//   UMM_TEACHER_KEY=<teacher key> npm run test:browser -- https://uploadmymodel.com/
// Needs Chrome (CHROME_PATH to override). teacher/fixes need the teacher key: locally the
// TEACHER_KEY from .dev.vars (default below), live the real one. e2e needs the slicer container
// (SLICER_URL in .dev.vars) and is skipped against the live site. perf is run on its own:
//   node test/browser/perf.test.mjs <base> [triangles]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://127.0.0.1:8787/';
// Prefer UMM_TEACHER_KEY: a key on the command line gets echoed by npm into logs.
const key = process.env.UMM_TEACHER_KEY || process.argv[3] || 'local-test-key-not-real';
const live = !/127\.0\.0\.1|localhost/.test(base);
const tests = ['undo', 'angle', 'multi', 'preview', 'autosave', 'health', 'threemf', 'units', 'split', 'supports', 'a11y', 'usb', 'usbcopy', 'arm', 'material', 'teacher', 'fixes', ...(live ? [] : ['e2e', 'limit', 'filename', 'gate'])];
// (e2e, limit, filename and gate slice real models; run them against local dev with the Docker slicer.)
let failed = 0;
// Open slicing for the run with a fresh random phrase (the tests get it through the environment),
// and always close it again at the end, also on the live site.
const phrase = `test-${randomBytes(6).toString('hex')}`;
process.env.UMM_TEST_PHRASE = phrase;
const slicingUrl = `${base}api/teacher/slicing`;
const opened = await fetch(slicingUrl, {
  method: 'PUT', headers: { 'x-teacher-key': key, 'content-type': 'application/json' },
  body: JSON.stringify({ phrase, minutes: 50 }),
}).catch(() => null);
console.log(`slicing opened for the run: ${opened?.status ?? 'no answer'}`);
async function closeForGood() {
  const r = await fetch(slicingUrl, { method: 'DELETE', headers: { 'x-teacher-key': key } }).catch(() => null);
  console.log(`slicing closed after the run: ${r?.status ?? 'no answer'}`);
}
for (const t of tests) {
  const file = fileURLToPath(new URL(`./${t}.test.mjs`, import.meta.url));
  const args = [file, base, ...(['teacher', 'fixes', 'limit', 'a11y', 'gate'].includes(t) ? [key] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600_000, env: process.env });
  const out = `${r.stdout}${r.stderr}`;
  const pass = (out.match(/^PASS/gm) || []).length;
  const fail = (out.match(/^FAIL/gm) || []).length + (r.status !== 0 && !/^FAIL/m.test(out) ? 1 : 0);
  failed += fail;
  console.log(`${t.padEnd(8)} ${pass} pass, ${fail} fail`);
  for (const line of out.split('\n')) if (/^FAIL|pageerror|Error:/.test(line)) console.log(`   ${line}`);
}
await closeForGood();
process.exitCode = failed ? 1 : 0; // (process.exit right after a fetch trips a libuv assert on Windows)

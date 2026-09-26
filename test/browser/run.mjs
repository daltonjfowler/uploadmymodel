// Run the browser tests against a running site and print a summary.
//   npm run test:browser                          # local wrangler dev on :8787 (npm run dev first)
//   npm run test:browser -- https://uploadmymodel.com/ <teacher key>
// Needs Chrome (CHROME_PATH to override). teacher/fixes need the teacher key: locally the
// TEACHER_KEY from .dev.vars (default below), live the real one. e2e needs the slicer container
// (SLICER_URL in .dev.vars) and is skipped against the live site. perf is run on its own:
//   node test/browser/perf.test.mjs <base> [triangles]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://127.0.0.1:8787/';
const key = process.argv[3] || 'local-test-key-not-real';
const live = !/127\.0\.0\.1|localhost/.test(base);
const tests = ['undo', 'angle', 'multi', 'preview', 'autosave', 'health', 'threemf', 'a11y', 'teacher', 'fixes', ...(live ? [] : ['e2e', 'limit', 'filename'])];
let failed = 0;
for (const t of tests) {
  const file = fileURLToPath(new URL(`./${t}.test.mjs`, import.meta.url));
  const args = [file, base, ...(['teacher', 'fixes', 'limit', 'a11y'].includes(t) ? [key] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout}${r.stderr}`;
  const pass = (out.match(/^PASS/gm) || []).length;
  const fail = (out.match(/^FAIL/gm) || []).length + (r.status !== 0 && !/^FAIL/m.test(out) ? 1 : 0);
  failed += fail;
  console.log(`${t.padEnd(8)} ${pass} pass, ${fail} fail`);
  for (const line of out.split('\n')) if (/^FAIL|pageerror|Error:/.test(line)) console.log(`   ${line}`);
}
process.exit(failed ? 1 : 0);

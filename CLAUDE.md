# CLAUDE.md

Kid-safe web slicer for the classroom LulzBot Workhorse. Read PLAN.md first. The student page (an
"online Cura") is built; the slicing engine is not. The engine will reuse uploadmylaser's Worker +
Container skeleton (`Desktop\uploadmylaser\uploadmylaser`).

## Layout
- `shared/settings.js`: **the one list of what students may change** (layer height, infill,
  pattern, walls, tree supports, adhesion) plus the class defaults and the greyed-out locked rows.
  Imported by the page and by the Worker, which refuses anything not on the lists.
- `web/`: the student page, built by Vite into `public/` (gitignored). No framework; three.js for 3D.
  - `src/viewer.js`: the bed, models, camera, drag, rotate / lay flat / mirror / scale, rotate
    rings (15° snap), multi-select (Ctrl + click, Ctrl + A), undo history, overhang shading, and
    `exportPlateSTL()` (printer coordinates, front-left corner = 0,0). With `?debug` in the address,
    `window.umm = { viewer, panel }` for browser tests.
  - `src/settings-panel.js`: Recommended / Custom settings card and hover help.
  - `src/main.js`: tools, object list, Slice / result card, keyboard, drag and drop.
  - `teacher/index.html` + `src/teacher.js`: the teacher page (key, slicing window + class phrase,
    which settings are locked, class defaults, print-time limit, note, slicer warm-up).
  - `usb-test/index.html` + `src/usb-test.js`: read-only printer USB test (Web Serial; only M115,
    M105, M27, M20 can be sent). Plan for print-from-USB: docs/USB_PRINTING.md.
  - `src/loaders.js`: STL / OBJ / 3MF → triangle soup, and the sample model.
  - `src/plate-store.js`: keeps the plate in IndexedDB so a reloaded tab gets it back.
  - `src/mesh-health.js`: open / over-shared edge check ("holes" flag), run once per model in idle.
  - `src/gcode.js`: reads Cura G-code (`;LAYER:`, `;TYPE:`) into printed lines per type and layer
    for the Preview tab. Tested against the school Benchy (`test/gcode.test.mjs`). Opening a
    `.gcode` file previews it; a real slice result will preview the same way.
  - `public/`: icons, manifest, `theme-boot.js` (copied as-is into the build).
- `src/worker.js`: http → https, www → apex, security headers + CSP, `/api/health`,
  `/api/class` (public class setup), `/api/teacher/class` (GET/PUT, needs `x-teacher-key`), and
  `/api/slice` (checks settings, the teacher's locks, the STL and limits, then answers 501 until
  the engine exists). Class setup lives in KV `uploadmymodel-CLASS_KV` under the key `class`.
  `TEACHER_KEY` is a Worker secret; for local dev put a throwaway one in `.dev.vars`.
- `scripts/make-icons.mjs`: draws the icon. Edit the icon there, never `web/public/icon.svg` by hand.
- `docs/HARDWARE.md`: printer and slicer facts, each with its source.
- `docs/ENGINE_OPTIONS.md` + `engine/`: the CuraEngine spike. `engine/resolve.py` does Cura's
  setting formulas from the school version's files (`engine/res4132/`, never edit them);
  `engine/run.py` slices with CuraEngine. `engine/test_resolve.py` checks against the reference.
- `container/`: the slicer service (CuraEngine 4.13.2 from the official AppImage + resolver +
  `server.py`). LIVE since 2026-09-26 as a Cloudflare Container (`src/index.js` SlicerContainer,
  `wrangler.jsonc`: 1 vCPU / 3 GiB, max 2, sleepAfter 2m). `npm run deploy` rebuilds and pushes
  the image when it changes. Locally the Worker uses `SLICER_URL` (`.dev.vars`) instead, and
  `npm run dev` runs with `--enable-containers=false` (Windows cannot run containers in wrangler).
  Container time costs money: never loosen the class gate or the rate limits.
  After deploying slicer changes: (1) read the END of the deploy output and check
  `npx wrangler containers info a03c4da0-c29e-48ea-a202-269781865e5e` shows a NEW image digest
  (a Docker hiccup can skip the push silently; just run `npx wrangler deploy` again); (2) a running
  slicer keeps its old image until it sleeps (2 min without requests), so wait before testing, and
  change the Worker and slicer in a compatible order (slicer first when it must accept new values).
- `profiles/current_lulzbot_9_18.json`: the class profile, decoded from the school G-code footer.
- `test/golden/*.gcode`: real G-code sliced by school Cura. Stored byte for byte (`-text`).
- `test/*.test.mjs`: settings, server and G-code reader checks (`npm test`).
- `test/browser/`: ~100 browser checks with playwright-core + installed Chrome (`npm run dev`, then
  `npm run test:browser`; live: `UMM_TEACHER_KEY=<key> npm run test:browser -- https://uploadmymodel.com/`,
  never the key as an argument: npm echoes it).
  `node test/browser/perf.test.mjs <base> 500000` times a big model with the CPU slowed 4x.

## Rules
- Printer facts are guesses until docs/HARDWARE.md says where they came from.
- School slices with Cura LE engine 4.13.2; the home PC has 4.13.17 with different start G-code.
  Our output must match the school version's start/end G-code byte for byte.
- Students must never be able to set temperatures, speeds, retraction, or start/end G-code. New
  student settings go in `shared/settings.js` only, as a list or a stepped range, with a test.
- Tree supports are always 0% support infill (Dalton's rule, confirmed 2026-09-26 knowing that
  school's 4.13.2 engine makes 0% branches hollow, about half of school's 15% support plastic).
  Not a student setting.
- Slicing is gated by the teacher (shared/slicing.js): an open window + class phrase in KV
  ("slicing"), checked before the upload is read, and only when a slicer is connected. Everything
  else on the site works without it. Never let a request reach the slicer outside the window.
- Locked-row temperatures follow the layer height's 4.13.2 quality file (`lockedRows()`).
- Every plate change goes through a `Viewer` method that calls `record()` (or `transaction()` for
  several steps), so Undo works. Never move, scale or turn a model's mesh directly from `main.js`.
- Overhang red uses the student's support overhang angle (`supportAngle`, class default 60°, LulzBot's
  Cura value), so red always means "will get support". The slider repaints live via 'preview' events.
- Use this app's own KV namespace when one is added. Never reuse uploadmycode's or uploadmylaser's.

## Commands
`npm run build`, `npm run dev` (build + wrangler dev), `npm run dev:web` (Vite, proxies /api to
:8787), `npm test`, `npm run test:browser`, `npm run deploy`, `npm run icons`.

Windows: run wrangler dev with `--ip 127.0.0.1 --local-upstream localhost`, or the Worker sees the
real domain and redirects. Local wrangler dev (4.127) also exits with "Network connection lost"
when a browser drops a request mid-flight (fast reload, test closing a page); just restart it. The
live site is not affected. After each `npm run build`, restart wrangler dev: it keeps serving the
old asset list and the new hashed JS file 404s.

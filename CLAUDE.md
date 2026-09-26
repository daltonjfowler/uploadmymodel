# CLAUDE.md

Kid-safe web slicer for the classroom LulzBot Workhorse. Read PLAN.md first. The student page (an
"online Cura") is built; the slicing engine is not. The engine will reuse uploadmylaser's Worker +
Container skeleton (`Desktop\uploadmylaser\uploadmylaser`).

## Layout
- `shared/settings.js`: **the one list of what students may change** (layer height, infill,
  pattern, walls, tree supports, adhesion) plus the class defaults and the greyed-out locked rows.
  Imported by the page and by the Worker, which refuses anything not on the lists.
- `web/`: the student page, built by Vite into `public/` (gitignored). No framework; three.js for 3D.
  - `src/viewer.js`: the bed, models, camera, drag, rotate / lay flat / mirror / scale, overhang
    shading, and `exportPlateSTL()` (printer coordinates, front-left corner = 0,0).
  - `src/settings-panel.js`: Recommended / Custom settings card and hover help.
  - `src/main.js`: tools, object list, Slice / result card, keyboard, drag and drop.
  - `src/loaders.js`: STL / OBJ / 3MF → triangle soup, and the sample model.
  - `public/`: icons, manifest, `theme-boot.js` (copied as-is into the build).
- `src/worker.js`: http → https, www → apex, security headers + CSP, `/api/health`, and
  `/api/slice` (checks settings + STL + limits, then answers 501 until the engine exists).
- `scripts/make-icons.mjs`: draws the icon. Edit the icon there, never `web/public/icon.svg` by hand.
- `docs/HARDWARE.md`: printer and slicer facts, each with its source.
- `profiles/current_lulzbot_9_18.json`: the class profile, decoded from the school G-code footer.
- `test/golden/*.gcode`: real G-code sliced by school Cura. Stored byte for byte (`-text`).
- `test/*.test.mjs`: settings and server checks (`npm test`).

## Rules
- Printer facts are guesses until docs/HARDWARE.md says where they came from.
- School slices with Cura LE engine 4.13.2; the home PC has 4.13.17 with different start G-code.
  Our output must match the school version's start/end G-code byte for byte.
- Students must never be able to set temperatures, speeds, retraction, or start/end G-code. New
  student settings go in `shared/settings.js` only, as a list or a stepped range, with a test.
- Tree supports are always 0% support infill (Dalton's rule). Not a student setting.
- Every plate change goes through a `Viewer` method that calls `record()` (or `transaction()` for
  several steps), so Undo works. Never move, scale or turn a model's mesh directly from `main.js`.
- Overhang red uses LulzBot's support angle, 60° (`PRINTER.supportAngleDeg`), to match Cura LE.
- Use this app's own KV namespace when one is added. Never reuse uploadmycode's or uploadmylaser's.

## Commands
`npm run build`, `npm run dev` (build + wrangler dev), `npm run dev:web` (Vite, proxies /api to
:8787), `npm test`, `npm run deploy`, `npm run icons`.

Windows: run wrangler dev with `--ip 127.0.0.1 --local-upstream localhost`, or the Worker sees the
real domain and redirects. After each `npm run build`, restart wrangler dev: it keeps serving the
old asset list and the new hashed JS file 404s.

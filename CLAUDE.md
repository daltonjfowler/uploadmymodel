# CLAUDE.md

Kid-safe web slicer for the classroom LulzBot Workhorse. Read PLAN.md first. Right now this repo is
only the holding page; the real app will reuse uploadmylaser's Worker + Container skeleton
(`Desktop\uploadmylaser\uploadmylaser`).

## Layout
- `src/worker.js`: http → https, www → apex, security headers, then serves `public/`.
- `public/`: the holding page. No scripts, so the CSP is `script-src 'none'`.
- `scripts/make-icons.mjs`: draws the cube-head icon as real 3D shapes and writes `icon.svg` plus the
  PNGs. Edit the icon there, never `public/icon.svg` by hand.
- `docs/HARDWARE.md`: printer and slicer facts, each with its source.
- `profiles/current_lulzbot_9_18.json`: the class profile, decoded from the school G-code footer.
- `test/golden/*.gcode`: real G-code sliced by school Cura. Stored byte for byte (`-text`).

## Rules
- Printer facts are guesses until docs/HARDWARE.md says where they came from.
- School slices with Cura LE engine 4.13.2; the home PC has 4.13.17 with different start G-code.
  Our output must match the school version's start/end G-code byte for byte.
- Students must never be able to set temperatures, speeds, retraction, or start/end G-code.
- Use this app's own KV namespace when one is added. Never reuse uploadmycode's or uploadmylaser's.

## Commands
`npm run dev`, `npm run deploy`, `node scripts/make-icons.mjs public`.

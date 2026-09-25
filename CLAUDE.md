# CLAUDE.md

Kid-safe web slicer for the classroom LulzBot Workhorse. Read PLAN.md first. Right now this repo is
only the holding page; the real app will reuse uploadmylaser's Worker + Container skeleton
(`Desktop\uploadmylaser\uploadmylaser`).

## Layout
- `src/worker.js`: http → https, www → apex, security headers, then serves `public/`.
- `public/`: the holding page. No scripts, so the CSP is `script-src 'none'`.
- `scripts/make-icons.mjs`: draws the cube-head icon as real 3D shapes and writes `icon.svg` plus the
  PNGs. Edit the icon there, never `public/icon.svg` by hand.

## Rules
- Printer facts are guesses until PLAN.md §2 marks them verified.
- Students must never be able to set temperatures, speeds, retraction, or start/end G-code.
- Use this app's own KV namespace when one is added. Never reuse uploadmycode's or uploadmylaser's.

## Commands
`npm run dev`, `npm run deploy`, `node scripts/make-icons.mjs public`.

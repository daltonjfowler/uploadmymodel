# uploadmymodel

Kid-safe web slicer for the classroom LulzBot Workhorse, built for Chromebook classrooms. Students
open a 3D model, set it on the printer bed, pick print settings from safe lists (layer height,
infill, infill pattern, walls, tree supports, brim), and download G-code to carry to the printer on
an SD card. Temperatures, speeds and start/end G-code come only from the teacher's class profile.
Internal district tool, sibling of [uploadmycode](https://uploadmycode.com) and
[uploadmylaser](https://uploadmylaser.com). Made by [Dalton Fowler](https://daltonjfowler.com).

**Status (2026-09-26):** live at https://uploadmymodel.com with real slicing: school's CuraEngine
4.13.2 in a Cloudflare Container (1 vCPU / 3 GiB; a supported Benchy slices in about 15 s). The
teacher page ([/teacher/](https://uploadmymodel.com/teacher/)) opens slicing for a class with a
phrase, locks settings and sets class defaults; the rest of the site works without it. See
[PLAN.md](PLAN.md) and [docs/GO_LIVE.md](docs/GO_LIVE.md).

Guides: [students](docs/STUDENT_GUIDE.md) · [teachers](docs/TEACHER_GUIDE.md).

## Teacher key

The teacher page needs the `TEACHER_KEY` Worker secret. Set or change it with
`npx wrangler secret put TEACHER_KEY` (use a long random key; there is no lockout, because a school
shares one IP). For local dev, put a throwaway key in `.dev.vars` (gitignored).

## Commands

```sh
npm install
npm run build       # web/ → public/ (Vite)
npm run dev         # build, then wrangler dev
npm run dev:web     # Vite dev server; proxies /api to wrangler dev on :8787
npm test            # settings, server and G-code reader checks
npm run test:browser  # ~100 browser checks against npm run dev (needs Chrome)
npm run deploy      # build and deploy to uploadmymodel.com
npm run icons       # redraw icon.svg and the PNG icons into web/public
```

## Credits

3D view and model loading by [three.js](https://threejs.org) (MIT). Print profile values come from
Cura LulzBot Edition's quality files, read, not copied as code.

## License

MIT, see [LICENSE](LICENSE).

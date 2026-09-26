# uploadmymodel

Kid-safe web slicer for the classroom LulzBot Workhorse, built for Chromebook classrooms. Students
open a 3D model, set it on the printer bed, pick print settings from safe lists (layer height,
infill, infill pattern, walls, tree supports, brim), and download G-code to carry to the printer on
an SD card. Temperatures, speeds and start/end G-code come only from the teacher's class profile.
Internal district tool, sibling of [uploadmycode](https://uploadmycode.com) and
[uploadmylaser](https://uploadmylaser.com). Made by [Dalton Fowler](https://daltonjfowler.com).

**Status:** the student page is live at https://uploadmymodel.com. The slicing engine is not
connected yet, so Slice checks everything and then says so. See [PLAN.md](PLAN.md).

## Commands

```sh
npm install
npm run build       # web/ → public/ (Vite)
npm run dev         # build, then wrangler dev
npm run dev:web     # Vite dev server; proxies /api to wrangler dev on :8787
npm test            # settings and server checks
npm run deploy      # build and deploy to uploadmymodel.com
npm run icons       # redraw icon.svg and the PNG icons into web/public
```

## Credits

3D view and model loading by [three.js](https://threejs.org) (MIT). Print profile values come from
Cura LulzBot Edition's quality files, read, not copied as code.

## License

MIT, see [LICENSE](LICENSE).

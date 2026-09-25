# uploadmymodel

Kid-safe web slicer for the classroom LulzBot Workhorse, built for Chromebook classrooms. Students
upload a 3D model, pick one of the teacher's print settings, and download G-code to carry to the
printer on an SD card. Internal district tool, sibling of [uploadmycode](https://uploadmycode.com)
and [uploadmylaser](https://uploadmylaser.com). Made by [Dalton Fowler](https://daltonjfowler.com).

**Status:** holding page only, live at https://uploadmymodel.com. See [PLAN.md](PLAN.md).

## Commands

```sh
npm install
npm run dev                          # local preview (wrangler dev)
npm run deploy                       # deploy to uploadmymodel.com
node scripts/make-icons.mjs public   # redraw icon.svg and the PNG icons
```

## License

MIT, see [LICENSE](LICENSE).

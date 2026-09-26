# Slicer container

CuraEngine **4.13.2** taken from the official Cura LulzBot Edition 4.13.2 AppImage (the version
the school uses, checked by SHA-256 at build time), Cura's own 4.13.2 resource files from the same
AppImage, the resolver from `engine/`, and a small HTTP service (`server.py`). Image: about 200 MB.

**Status (2026-09-26): works locally, not deployed.** The live site still answers 501 for Slice.
The go-live wiring (Cloudflare Container binding, fair-use limits, teacher warm-up button) is ready
on the **`slicer-live`** branch; its `docs/GO_LIVE.md` has the checklist and the undo steps.
Deploying it as a Cloudflare Container costs container time from the allowance shared with
uploadmycode and uploadmylaser, so that is Dalton's call (see "Before going live").

## Build and run (from the repo root)

```sh
docker build -f container/Dockerfile -t uploadmymodel-slicer .
docker run --rm -p 8090:8080 uploadmymodel-slicer
curl http://127.0.0.1:8090/health      # {"ok": true, "engine": "Cura_SteamEngine version 4.13.2"}
```

The build stops if the engine is not 4.13.2, or if the AppImage's resource files do not resolve to
exactly `engine/reference/resolved_hd_4132.json` (`engine/test_resolve.py`).

To use it from the site locally, put `SLICER_URL="http://127.0.0.1:8090"` in `.dev.vars` (next to
`TEACHER_KEY`) and run `npm run dev`. The Worker then sends every checked slice to the container
and the page gets real G-code, a Preview and a Save button. Without `SLICER_URL` the Worker keeps
answering 501.

## API

`POST /slice`
- body: binary STL of the whole plate in printer coordinates (front-left corner 0,0), as the Worker
  checked it. The service moves it to be centred on 0,0; CuraEngine adds the machine centre back.
- header `x-cura-settings`: `toCuraOverrides(settings)` from `shared/settings.js`. Checked again
  here: exactly those keys, each on its allowed list.
- answer: G-code (`text/plain`), plus `x-print-time-s`, `x-filament-m`, `x-filament-g`, `x-layers`,
  `x-engine-seconds`, `x-attempts`.

One slice at a time. A failed engine run is retried up to 3 times (tree supports crash CuraEngine
now and then, see `docs/ENGINE_OPTIONS.md`).

## What was checked (Benchy, class settings)

- Start block byte for byte the same as the school G-code except the `;Filament weight` line; end
  block the same; temperatures and fans the same; 266 layers.
- Walls, top/bottom and infill paths the same length as school's (36.3 / 32.8 / 39.3 / 18.1 m).
- **Supports depend on the support infill setting:**
  - at 15% (what school's quality file uses): 74.7 m of support path against school's 69.6 m,
    total filament +2.7%, time +1.7%.
  - at **0%** (the uploadmymodel rule for tree supports): 37.9 m, about half. The branches come out
    as hollow shells. Total 2.32 m / 17.3 g against school's 2.76 m / 20.6 g. Print one before
    students rely on it: hollow branches are lighter and snap off easily, but may be weaker.
- Sample model from the page, end to end through the Worker: 0.8 s in the container, 1.6 s from
  click to Preview on this PC.
- Every student choice (`node container/test-matrix.mjs`): all 3 layer heights, all 7 infill
  patterns, 0% and 100% infill, 2-4 walls, supports off / plate / everywhere, angles 40° and 80°,
  brim: 20 slices, all first try. Fast and Standard start at 210 °C then print at 215 °C, High
  Detail 205 / 210 °C, exactly as in the 4.13.2 quality files.

## Before going live

- Container size and cost. Measured on this PC with Docker CPU limits (an estimate of Cloudflare's
  instances, not a measurement there):

  | Docker limit | Sample piece | Benchy, tree supports | Benchy, no supports |
  |---|---|---|---|
  | 1/4 CPU, 1 GiB (like `basic`) | 5.7 s | 79 s | 18 s |
  | 1/2 CPU | 2.6 s | 33 s | 7.5 s |
  | **1 CPU, 3 GiB (the planned custom size)** | **1.4 s** | **15.6 s** | |
  | 2 CPU | 1.0 s | 13.3 s | |
  | no limit (12-core desktop) | 0.8 s | 12 s | about 2 s |

  Tree supports run on one core, so more than 1 CPU barely helps. Almost all the time is the
  engine: the setting work is cached (one resolve per settings combination) and a new container
  pre-warms itself with the class settings.

  Memory stayed far under 1 GiB. Tree supports are most of the time. With `basic`, a class of
  students slicing supported models one at a time would queue (one slice at a time per
  container); allowing 2-3 instances, or a bigger instance, trades cost for waiting. The page
  shows a progress bar the whole time; a minute-long wait may need a friendlier message.
- Decide the 0% vs 15% tree support infill (above).
- Teacher limits (longest print time) and whether to write the student's name into the file.
- Wire it as a Cloudflare Container binding (like uploadmylaser's `LaserContainer`) instead of
  `SLICER_URL`, with a warm-up button on the teacher page.

License: CuraEngine is AGPLv3 and is shipped unmodified (source:
https://gitlab.com/lulzbot3d/cura-le/cura-engine-le); the Cura resource files are LGPLv3.

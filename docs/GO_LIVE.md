# Turning on slicing (branch `slicer-live`)

Everything needed to put the slicer online is on the `slicer-live` branch. `main` (the live site)
stays at "engine not connected" until this is merged and deployed. **Deploying this starts paying
for container time** from the allowance shared with uploadmycode and uploadmylaser.

## What the branch adds

On top of `main` (which already has the class gate, the fair-use limits and the warm-up button,
all inactive without a slicer), only the container itself:

- `src/index.js`: the Worker entry, with `SlicerContainer` (CuraEngine 4.13.2 from
  `container/Dockerfile`, sleeps after 2 minutes without work).
- `wrangler.jsonc`: the container at **1 vCPU / 3 GiB** (the smallest custom size), at most 2
  running, its Durable Object binding and migration, and two rate limits (6 slices a minute per
  browser, 60 a minute for everyone).

## What it costs (Cloudflare prices, 2026-09-26)

- CPU is billed **only while slicing** ($0.00002 per vCPU-second; 375 vCPU-minutes a month are
  included in the Workers plan). Memory ($0.0000025 per GiB-second) and disk are billed while the
  container is awake. The 25 GiB-hours of included memory are shared with uploadmycode and
  uploadmylaser and are usually used up already, so assume memory is paid.
- It is only awake when someone slices during an open window, plus 2 minutes. Opening slicing
  wakes it once (a few seconds of work, then it sleeps again if nobody slices).
- One busy class period (awake 55 minutes, 90 slices of Benchy size): memory 3 GiB × 3,300 s ≈
  $0.025, CPU 90 × 16 s ≈ $0.03 (free while the included minutes last), disk ≈ $0.001. **About
  $0.03 to $0.06 per busy period**, double if both instances wake. 100 busy periods a month is
  roughly **$3 to $6**. Outside open windows it costs nothing: the gate refuses before anything
  reaches the container.
- `basic` (1/4 vCPU, 1 GiB) would cost about a third of the memory but make students wait five
  times longer (79 s against 16 s for a Benchy).

Checked: unit tests, the browser suite against local dev with the Docker slicer, and
`npx wrangler deploy --dry-run` (builds the image, lists all bindings, uploads nothing).

## Before merging

1. Print one Benchy sliced by the container next to one from school Cura (tree supports are
   0% infill, decided 2026-09-26, so the branches are hollow).
2. Happy with 1 vCPU / 3 GiB? (Change `instance_type` in `wrangler.jsonc` to trade speed for cost.)

## Go live

```sh
git checkout main && git merge slicer-live
npm test
npm run deploy          # builds and pushes the container image the first time (a few minutes)
```

Then on the teacher page **Open slicing** (it wakes the slicer), slice the sample piece with the
phrase, and check the Preview and the saved file.

## Undo

Revert the merge commit and `npm run deploy`. The site goes back to "engine not connected". To
also stop container billing entirely, delete the container application in the Cloudflare
dashboard (Workers & Pages → Containers).

# Turning on slicing (branch `slicer-live`)

Everything needed to put the slicer online is on the `slicer-live` branch. `main` (the live site)
stays at "engine not connected" until this is merged and deployed. **Deploying this starts paying
for container time** from the allowance shared with uploadmycode and uploadmylaser.

## What the branch adds

- `src/index.js`: the Worker entry, with `SlicerContainer` (CuraEngine 4.13.2 from
  `container/Dockerfile`, sleeps after 5 minutes).
- `wrangler.jsonc`: the container (`basic`: 1/4 vCPU, 1 GiB; at most 2 running), its Durable
  Object binding and migration, and two rate limits: 6 slices a minute per browser, 60 a minute
  for everyone.
- Worker: slices go to the container; per-browser key is a random id the page keeps (a school
  shares one public IP, so the IP is only the fallback).
- Teacher page: **Warm up the slicer** button (wakes the container before class).

Checked: unit tests (28), browser suite (121 checks) against local dev with the Docker slicer, and
`npx wrangler deploy --dry-run` (builds the image, lists all bindings, uploads nothing).

## Before merging

1. Decide the tree-support infill (0% hollow vs school's 15%), `docs/TEACHER_GUIDE.md`.
2. Print one Benchy sliced by the container next to one from school Cura.
3. Decide instance size: measured with Docker limits, a supported Benchy takes about 80 s on
   `basic` and 33 s on half a CPU (`container/README.md`). Change `instance_type` if needed.

## Go live

```sh
git checkout main && git merge slicer-live
npm test
npm run deploy          # builds and pushes the container image the first time (a few minutes)
```

Then on the teacher page press **Warm up the slicer**, slice the sample piece, and check the
Preview and the downloaded file.

## Undo

Revert the merge commit and `npm run deploy`. The site goes back to "engine not connected". To
also stop container billing entirely, delete the container application in the Cloudflare
dashboard (Workers & Pages → Containers).

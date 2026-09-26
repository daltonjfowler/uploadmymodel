# Where these files come from

Unmodified copies of 14 resource files from **Cura LulzBot Edition 4.13.2**, the version the
school uses. 13 were downloaded 2026-09-26 from LulzBot's GitLab, commit
`5fdb404913d12abb249e64ee24e8cf8485fcbe95` ("Updated everything to be ready for 4.13.2",
2023-12-14):

`https://gitlab.com/lulzbot3d/cura-le/cura-lulzbot/-/raw/5fdb404913d12abb249e64ee24e8cf8485fcbe95/resources/<path>`

`<path>` is the same as the path inside this folder (for example `definitions/lulzbot.def.json`).

All 13 were then checked identical (apart from line endings) to the files inside the official
Linux release, `Cura_LulzBot_Edition-4.13.2.AppImage` (sha256
`5bd642079462d8ef5b8e23c4e769da0a92b99288ed19b554e94fd05305a4856b`, the same file the slicer
container uses). The 14th, `gcodes/taz_workhorse/taz_workhorse_wipe.gcode`, was taken from that
AppImage: without it the resolver fell back to home Cura 4.13.17's wipe G-code, which lacks the
`G26` line. (That setting does not reach the printed file; the start G-code does not use it.)

Why these and not home Cura's (4.13.17): the 4.13.17 files give a different first-layer
temperature (215 °C, school 205 °C), bed temperature, bridge settings, combing and skirt gap. See
`docs/ENGINE_OPTIONS.md`.

License: Cura and Cura LulzBot Edition are released under the LGPLv3 (see the LICENSE file in the
source repository above). These files are redistributed unchanged under that license. Do not edit
them here; if a value must differ, set it in the resolver's user layer instead.

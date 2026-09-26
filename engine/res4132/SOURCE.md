# Where these files come from

Unmodified copies of 13 resource files from **Cura LulzBot Edition 4.13.2**, the version the
school uses. Downloaded 2026-09-26 from LulzBot's GitLab, commit
`5fdb404913d12abb249e64ee24e8cf8485fcbe95` ("Updated everything to be ready for 4.13.2",
2023-12-14):

`https://gitlab.com/lulzbot3d/cura-le/cura-lulzbot/-/raw/5fdb404913d12abb249e64ee24e8cf8485fcbe95/resources/<path>`

`<path>` is the same as the path inside this folder (for example `definitions/lulzbot.def.json`).

Why these and not home Cura's (4.13.17): the 4.13.17 files give a different first-layer
temperature (215 °C, school 205 °C), bed temperature, bridge settings, combing and skirt gap. See
`docs/ENGINE_OPTIONS.md`.

License: Cura and Cura LulzBot Edition are released under the LGPLv3 (see the LICENSE file in the
source repository above). These files are redistributed unchanged under that license. Do not edit
them here; if a value must differ, set it in the resolver's user layer instead.

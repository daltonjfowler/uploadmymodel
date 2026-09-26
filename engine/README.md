# Slicing engine spike

Proof that CuraEngine can slice exactly like school Cura LE, outside Cura. Findings, numbers and
the plan are in [../docs/ENGINE_OPTIONS.md](../docs/ENGINE_OPTIONS.md). Not wired into the site yet:
the Worker still answers 501. This is the starting point for the slicing container.

## The problem it solves

CuraEngine on its own only reads each setting's `default_value`. Cura's app works out hundreds of
settings from formulas first (temperatures, speeds, infill line distance...), fills the `{tokens}`
in the start and end G-code, and fixes the file header after slicing. Without that, the engine
prints with wrong settings and generic start G-code.

## Files

- `resolve.py`: does Cura's setting work. Reads the machine, extruder, quality and material files,
  stacks them like Cura (user > quality_changes > intent > quality > material > variant >
  definition_changes > definition), evaluates the formulas, and writes every final value to JSON
  (about 590 global + 470 extruder values). Standard library only.
- `run.py`: writes those values as two flat definition files in `flat/` (gitignored), fills the
  start/end G-code tokens, runs CuraEngine, then puts in the real header and filament weight like
  Cura's frontend does.
- `res4132/`: the school version's resource files (see `res4132/SOURCE.md`). Used by default.
- `reference/resolved_hd_4132.json`: what `resolve.py high_detail` produces. If a change to the
  resolver alters this, check why before committing.
- `compare.py`: compares two G-code files line type by line type (filament and retracts).
- `make-cube.mjs`, `center-stl.mjs`: test models (a 20 mm cube; centre any STL on 0,0 like Cura).

## Run it (Windows, Git Bash, with Cura LE 4.13 installed)

```sh
cd engine
python resolve.py high_detail /tmp/resolved              # -> /tmp/resolved.json
node make-cube.mjs /tmp/cube.stl && node center-stl.mjs /tmp/cube.stl /tmp/cube_c.stl
python run.py /tmp/resolved.json /tmp/cube_c.stl /tmp/cube.gcode \
  material_bed_temp_prepend=False material_print_temp_prepend=False
```

Environment variables (defaults are the home PC's paths):
- `CURA_ENGINE`: the engine binary. Default `C:\Program Files\CuraLE 4.13\CuraEngine.exe`.
- `CURA_RESOURCES`: an installed Cura LE `resources` folder, for any file not in `res4132/`.
- `RES_OVERLAY`: folder whose files win over the installed ones. Default `res4132/`; set it to an
  empty value to use the installed files only.

Student choices go in as extra arguments to `resolve.py` (`key=value` for global,
`--e key=value` for the extruder), so dependent values are worked out again, the same way Cura
does it. See the usage line at the top of `resolve.py`.

## Known issues

- Tree supports crash the Windows engine about 1 run in 10-20 (access violation). Retry.
- Tree supports come out about 5% heavier than school's (probably a different engine build).
  Everything else matches: start/end G-code byte for byte, temperatures, walls, skin, infill.
- The resolver still falls back to the installed Cura for files not in `res4132/` (other
  qualities, for example). A container needs the complete set.

License: the scripts are MIT like the rest of the repo. CuraEngine itself is AGPLv3 and is not in
this repo.

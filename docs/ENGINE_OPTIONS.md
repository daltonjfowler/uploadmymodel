# Slicing engine options

Research and a local spike, 2026-09-26. Question: how do we put a real slicer behind the Slice
button and still print exactly like school Cura LE (engine 4.13.2)?

Every claim is marked:
- **[ran]**: I ran it on Dalton's PC and saw the result.
- **[read]**: I read it in source code or online. Not tested.

## Summary

- **CuraEngine slices fine from the command line on this PC. [ran]** The engine inside Cura LE
  4.13.17 reports `Cura_SteamEngine version 4.13.17`. A 20 mm cube takes 0.6 s. A 3DBenchy with
  tree supports takes 13-15 s.
- **The engine alone gives wrong prints. [ran]** It skips Cura's setting formulas. It also skips
  `{placeholders}` in the start G-code and LulzBot's start G-code files. With the stock files you
  get layer height 0.1, the generic Ultimaker start code, 0.4 mm extruder lines and more.
- **I wrote a small Python resolver that does Cura's formula work. [ran]** It reads the same
  definition, quality and material files that Cura reads, and writes one flat file of about 1,060
  final values. CuraEngine then slices from that file.
- **With the school version's resource files (4.13.2, from LulzBot's GitLab), the benchy nearly
  matches the school G-code. [ran]**
  - The start G-code is byte for byte the same, except the filament weight line.
  - The end G-code is byte for byte the same.
  - Temperatures, fan steps, layer count (266), walls, skin and infill all match. The filament
    used by walls, skin and infill is equal to 0.1 mm.
  - Only the tree supports differ. They use about 5% more plastic. Our estimate is +1.7% time and
    +1.9% filament. My best guess is that our engine build (4.13.17) is not school's (4.13.2).
- **Warning: tree supports crash this Windows engine now and then. [ran]** About 1 run in 10-20
  dies with an access violation. Normal supports and no supports never crashed. The Debian Linux
  4.13.0 engine did not crash in 40 runs. A server must retry a failed slice.
- **Linux works. [ran]** Debian's `cura-engine` package (upstream 4.13.0, 3.4 MB) installed in a
  throwaway Docker container. It sliced the same benchy from the same flat files in about 17 s.
  Walls, skin and infill were the same. Supports differed a bit more (+8.6% support plastic).
- **Browser (WebAssembly): not ready. [read]** The only packaged build, `cura-wasm`, is archived. It
  wraps a 2020-21 CuraEngine (about 4.8/4.9, not 4.13) and has no LulzBot changes. We would have to
  compile LulzBot's engine to WASM ourselves.
- **Recommendation:** a Linux container running LulzBot's own CuraEngine build, fed by the resolver.
  First find out which engine build school really has (see Recommendation).

---

## 1. Local spike: CuraEngine on this PC

### What is installed [ran]

- Engine: `C:\Program Files\CuraLE 4.13\CuraEngine.exe`, 3.3 MB, dated 2025-07-15.
- `CuraEngine.exe help` prints `Cura_SteamEngine version 4.13.17` and the usage
  (`slice -v -p -j -s -l -g -e<n> -o -m<threads>`).
- Definitions are in `resources\definitions`. The SE extruder is in
  `resources\extruders\taz_workhorse\taz_workhorse_se_extruder.def.json`.
- The Workhorse start and end G-code are separate files in
  `resources\gcodes\taz_workhorse\`, pulled in by a LulzBot-only key, `default_value_from_file`.

### Test files [ran]

All output went to a temporary scratch folder. The scripts and the 4.13.2 resource files were
then copied into this repo's [`engine/`](../engine/README.md) folder, which is where to run them now.

- `make-cube.mjs` writes `cube20.stl`, a 20 mm binary STL cube.
- `3DBenchy.stl` is the public benchy, from `github.com/CreativeTools/3DBenchy`.
  `center-stl.mjs` centres it at X=Y=0 with its bottom at Z=0, which is what Cura does on load.
  The first-layer outlines then landed on exactly the same coordinates as the school file.

### Step 1: stock definition only [ran]

```
set CURA_ENGINE_SEARCH_PATH=C:\Program Files\CuraLE 4.13\resources\definitions;C:\Program Files\CuraLE 4.13\resources\extruders;C:\Program Files\CuraLE 4.13\resources\extruders\taz_workhorse
"C:\Program Files\CuraLE 4.13\CuraEngine.exe" slice -v -j "C:\Program Files\CuraLE 4.13\resources\definitions\taz_workhorse_se.def.json" -l cube20.stl -o try2.gcode
```

- You pass only the machine definition with `-j`. The engine follows `inherits` and loads the
  extruder named in `machine_extruder_trains` by itself. `-e0` is not needed.
- Without `CURA_ENGINE_SEARCH_PATH`, the engine could not find the extruder file (it sits in a
  subfolder). It printed `Couldn't find definition file with ID: taz_workhorse_se_extruder` and
  used a 0.4 mm nozzle for the extruder. Separate the folders with `;` on Windows.
- It sliced (exit 0, 0.6 s), but the result was wrong:
  - `;Layer height: 0.1`: fdmprinter's default. Cura's quality profile is never read.
  - Start G-code was Ultimaker's generic `G28 ;Home ...`. `default_value_from_file` is ignored.
  - 31 warnings like `JSON setting material_print_temperature has no default_value!`. The engine
    reads only `default_value`. Every `value` formula (temperatures, speeds, infill line
    distance, support distances...) is skipped.
  - The header in the file is a placeholder (`;TIME:6666`, `;Filament used: 0m`, silly MIN/MAX
    numbers). The real header is printed to stderr as `Gcode header after slicing:`. Cura's
    frontend swaps it in. We must do the same.
  - With `-v` the engine prints every setting it used as ` -s key="value"`. That is handy for
    checking.

### Step 2: resolve the settings first (the fix) [ran]

`resolve.py` copies how Cura's setting stacks work:
- Layers, top first: user, quality_changes, intent, quality, material, variant,
  definition_changes, definition. The extruder stack falls back to the global stack.
- It evaluates the Python `value` and `resolve` formulas with Cura's helper functions
  (`extruderValue`, `extruderValues`, `resolveOrValue`, `defaultExtruderPosition`, ...).
- The class profile `current_lulzbot_9_18` goes in as quality_changes (support on, tree, touching
  the build plate; infill 20%). Student choices go in the user layer of the extruder, so dependent
  values are worked out again. Example: infill 35% gives `infill_line_distance` 2.857.
- It takes about 0.3 s. Output: `resolved_*.json` with about 590 global and 470 extruder values.

`run.py` writes those values as two flat definition files (`flat\flat_machine.def.json` and
`flat\flat_extruder.def.json`; every value is a `default_value`, nothing inherits). It fills the
start and end G-code `{tokens}` the same way Cura's `GcodeStartEndFormatter` does. It runs the
engine, then does what Cura's frontend does after a slice: it puts in the real header and replaces
`{filament_weight}` (`~` + grams rounded to 2 places + `g`).

### The exact working command [ran]

The pipeline, from the repo's `engine` folder (Git Bash). `res4132/` is now the default overlay:

```
python resolve.py high_detail resolved_hd_4132
python run.py resolved_hd_4132.json benchy_centered.stl benchy.gcode material_bed_temp_prepend=False material_print_temp_prepend=False
```

What `run.py` actually runs:

```
set CURA_ENGINE_SEARCH_PATH=<scratchpad>\engine\flat
"C:\Program Files\CuraLE 4.13\CuraEngine.exe" slice -v -j <scratchpad>\engine\flat\flat_machine.def.json -l benchy_centered.stl -o benchy.gcode
```

`material_bed_temp_prepend=False` and `material_print_temp_prepend=False` stop the engine from
adding its own `M140/M190/M104/M109` lines before the start G-code. Cura normally sets them to
false itself, because the start G-code already has temperature tokens. Home Cura 4.13.17 hard-codes
them in `lulzbot.def.json`, but the 4.13.2 files do not. The resolver should set them. [ran]

### Home 4.13.17 files vs school 4.13.2 files [ran]

The first full try used home Cura's resource files. The G-code was close but not school's:
- First layer 215 °C, not 205 °C. First-layer bed 60 °C, not 65 °C.
- Bridge settings on (extra `M106 S255` fan bursts). School has them off.
- Combing "infill" gave 4,598 retract moves. School has 7,484, which matches combing **off**.
- Skirt 2 mm too close to the model. Time 10,849 s against school's 11,371 s.

So I downloaded the resource files for 4.13.2 from LulzBot's GitLab, at commit
`5fdb404913d12abb249e64ee24e8cf8485fcbe95` ("Updated everything to be ready for 4.13.2",
2023-12-14). They are in `res4132\` in the scratchpad. Source:
`https://gitlab.com/lulzbot3d/cura-le/cura-lulzbot/-/raw/5fdb4049.../resources/...` [ran]

Differences in those files that explain the gaps [ran]:
- The 4.13.2 PolyLite PLA High Detail quality sets `material_print_temperature_layer_0 = 205`,
  `material_bed_temperature_layer_0 = 65`, `skirt_gap = 5` and `support_join_distance = 3`.
- `taz.def.json` sets accelerations to 500 (home: 1000). That changes the time estimate.
- The 4.13.2 `lulzbot.def.json` sets `retraction_combing` to the formula `infill`. That is not a
  setting name, so it evaluates to nothing, and Cura's resolve step turns that into **off**. So
  school really prints with combing off. The resolver reproduces this quirk by itself.
- The 4.13.2 start G-code template (`G26`, `M109 R{material_soften_temperature}`,
  `M204 S100` ...), with its tokens filled in, is byte for byte the school start block.

### Result with the 4.13.2 files [ran]

| | School G-code | Ours (4.13.17 engine, 4.13.2 files) | Debian 4.13.0 in Docker |
|---|---|---|---|
| Layers | 266 | 266 | 266 |
| Estimated time | 11,371 s | 11,567 s (+1.7%) | (not printed) |
| Filament | 2.76414 m, ~20.63 g | 2.8167 m, ~21.02 g (+1.9%) | 2.851 m of extrusion |
| Start block, lines 12-72 | | identical except `;Filament weight` | |
| End block | | identical | |
| Temps and fan commands | | identical | |
| Filament in inner wall / outer wall / skin / infill (mm) | 465.9 / 516.4 / 502.0 / 255.8 | same | same (skin 501.9) |
| Support filament (mm) | 982.4 | 1034.0 (+5.3%) | 1066.7 (+8.6%) |
| Retracts in inner wall / outer wall / skin / infill | 212 / 657 / 943 / 166 | 214 / 657 / 943 / 165 | 213 / 658 / 946 / 162 |

- Everything except the supports matches. The support difference is almost surely inside the
  engine's tree support code. Our engine is LulzBot's 4.13.17 build. School's is 4.13.2. Debian's
  is plain Ultimaker 4.13.0. Each gives slightly different trees. I did not prove this.
- Two runs of the same slice gave byte-identical G-code. The engine is deterministic. [ran]
- Line endings: the Windows engine writes CRLF, like the school file. Linux writes LF. To match
  byte for byte on Linux, convert to CRLF. The printer does not care.
- Cura adds a `;SETTING_3` footer. We do not need it, but we can copy one in if we want the
  file to reopen in Cura with the profile.
- Side finding: `support_infill_rate` 0 and 15 gave identical G-code with tree supports. Tree
  support in 4.13 ignores it. So "tree supports are always 0%" costs nothing. School's quality file
  says 15 anyway.
- Side finding for PLAN.md §7: the 4.13.2 `fdmprinter.def.json` has Lightning infill. [ran]

### Speed and memory [ran]

- Cube: 0.6 s.
- Benchy with tree supports: 12.6-15.4 s on this PC. About 11-14 s of that is the support step.
  Without supports a benchy would be about 1.5 s (worked out from the engine's step times).
- `-m1` (one thread) took 14.1 s against 13.6 s for 12 threads. Tree support uses about one core.
- Peak memory about 75 MB.
- A Cloudflare `basic` container has a quarter of a vCPU. Expect several times slower, maybe a
  minute for a benchy with supports. Not measured.

### The crash [ran]

- Stock definition + `support_enable=true support_structure=tree`, cube, 60 runs: **6 crashes**
  (exit code 3221225477 = access violation, during "Processing platform adhesion").
- Same with `support_structure=normal`: 0 crashes in 60. No supports: 0 in 40.
- With our flat files: about 1 in 20 runs crashed, also with `-m1`. I bisected the settings. It
  needs `support_enable` and `support_structure=tree` together.
- Debian's Linux 4.13.0 engine, same flat files, tree support, cube: 0 crashes in 40.
- Cura's GUI probably hides this by restarting the engine and slicing again. A server should do
  the same: retry up to 2-3 times.

---

## 2. Getting the resolved settings out of Cura LE without the GUI

Short answer: Cura cannot export them from the command line. But there are two easy ways, and the
resolver above may make them unnecessary.

**What Cura sends the engine [read]** (`plugins\CuraEngineBackend\Cura.proto` and `StartSliceJob.py`
in the install):
- A `Slice` message over a local socket (Arcus protocol). It holds `global_settings` (a
  `SettingList` of name/value pairs), one `Extruder` message per extruder with its settings, the
  meshes (vertices already placed on the bed), and `limit_to_extruder` hints.
- Every value is `str(value)` of the fully worked-out setting. `machine_start_gcode` and
  `machine_end_gcode` are already filled in, except `{filament_weight}`, `{print_time}`,
  `{filament_amount}` and `{print_job_name}`. Cura replaces those four after the slice
  (`CuraEngineBackend.py` line 760 onward).

**`--external-backend` exists [read]:** `UM/Application.pyc` in `lib\library.zip` has the option
with the help text "Use an externally started backend instead of starting it automatically. This is
a debug feature...". The engine command Cura normally runs is
`CuraEngine.exe connect 127.0.0.1:<port>` (`CuraEngineBackend.py` line 218).

**Easiest capture (not tried):**
1. Start Cura LE with `--external-backend`.
2. In a terminal, run the real engine yourself:
   `CuraEngine.exe connect 127.0.0.1:49674 -v 2> capture.txt`
   (49674 is Cura's usual port; check the log if it does not connect.)
3. Slice in Cura as normal.
4. `capture.txt` then holds the whole settings dump as ` -s key="value"` lines. The research found
   that `Slice::compute()` in CuraEngine 4.13 logs this in socket mode too, not just on the
   command line. [read] I saw the dump on the command line here. [ran]

No "pretend engine" is needed. Watch out: values like the start G-code contain `"` quotes and
newlines, so parse carefully.

Also worth a look: Uranium may copy engine stderr into
`%APPDATA%\CuraLE\4.13\CuraLE.log` as `[Backend]` lines. The home log has no slices in it yet, so I
could not check. [ran: no slices found]

**Why it still matters:** a capture from **school's** Cura is the ground truth. It would show
whether my resolver matches school value for value. It must come from the school machine, because
the home install is 4.13.17.

---

## 3. Linux container route

**Verified [ran]:** `docker run debian:bookworm-slim` + `apt-get install cura-engine` gives
`cura-engine 1:4.13.0-1+b1`, `Cura_SteamEngine version 4.13.0`, a 3.4 MB binary. It read our flat
definition files unchanged and sliced the benchy in about 17 s (12 CPUs). Model features matched
school. Supports were 8.6% heavier. No crashes in 40 tree-support runs. I removed the image after.

**Where the real LulzBot engine lives [read]:**
- Frontend: `https://gitlab.com/lulzbot3d/cura-le/cura-lulzbot`. There is no `4.13.2` tag. The
  4.13.2 release is commit `5fdb4049` (2023-12-14). 4.13.17 is `main`, commit `987394a9`
  (2025-07-15).
- Engine fork: `https://gitlab.com/lulzbot3d/cura-le/cura-engine-le`. No 4.x tags. It is
  LulzBot's old 3.6 fork with upstream 4.13 merged in (2022), plus LulzBot commits (2023-11 and
  2024, mostly dual-extruder G-code). Which engine commit went into 4.13.2 is not known. Probably
  near 2023-11-30.
- Ultimaker upstream: `github.com/Ultimaker/CuraEngine`, tags `4.13.0`, `4.13.1`, `4.13.2`
  (4.13.1 and 4.13.2 are the same commit, `ebb53015`).
- LulzBot Linux AppImages: `https://software.lulzbot.com/Cura_LulzBot_Edition/Linux/` has
  `4.13.2/Cura_LulzBot_Edition-4.13.2.AppImage` (184 MB) and 4.13.17 (195 MB). It almost surely
  contains the `CuraEngine` binary (`--appimage-extract`). It may need the bundled libArcus and
  protobuf libraries. Not downloaded.

**Options, easiest first:**
1. **Extract CuraEngine from the 4.13.2 AppImage.** This is most likely the exact engine school
   has. Copy the binary and its few `.so` files into a slim Debian image. Small effort. Check the
   license: AGPLv3, and we would ship it unmodified, with a link to the source.
2. **Build `cura-engine-le` from source** in a Dockerfile: CMake, C++17, protobuf, libArcus (built
   with `-DBUILD_PYTHON=OFF`), or `-DENABLE_ARCUS=OFF` for a command-line-only build. Clipper and
   rapidjson are bundled. Roughly 3 CMake builds, 10-20 minutes. A multi-stage image could be
   under 100 MB. Medium effort, and we still would not know the exact 4.13.2 commit.
3. **Debian's `cura-engine` 4.13.0.** One `apt-get` line. Works today. Supports will not match
   school exactly.

The container also needs Python 3 for the resolver (or a port of it to JavaScript). The resolver is
small and uses only the standard library.

---

## 4. In-browser WebAssembly route [read]

- **`cura-wasm`** (Cloud-CNC, `github.com/Cloud-CNC/cura-wasm`, npm `cura-wasm` 1.5.2): last change
  January 2021. Repo archived June 2023; the author says all Cloud CNC projects are deprecated.
  - Engine: an Emscripten build of Ultimaker's master from late 2020 / early 2021 (about 4.8/4.9).
    Not 4.13, no LulzBot changes.
  - License: AGPL-3.0 for the engine, LGPL for definitions, MIT for the wrapper.
  - Settings: takes overrides as `{scope, key, value}` or a raw command string. The string is split
    on spaces, so values with spaces (like start G-code) are risky. Custom definition objects are
    written to `/definitions/printer.def.json` inside the WASM file system.
  - Input: STL (and 3MF/AMF/PLY/OBJ converted to STL).
  - Speed: their own benchmark, about 6.6 s in Chrome 86 against 2.3 s native, one thread.
  - Helper package `cura-wasm-definitions` 1.5.1 is also deprecated. A fork,
    `@toybox-labs/cura-wasm` 1.5.4, stopped in September 2021.
- **Ultimaker's own Emscripten target** exists only in CuraEngine 5.x. No published npm build.
- **Kiri:Moto** is a different slicer (MIT, pure JavaScript). Its G-code will never match Cura.

Would it match school? No, not as packaged. To match, we would compile LulzBot's `cura-engine-le`
with Emscripten ourselves (no Arcus, no OpenMP). Probably doable, not tried. It would still need the
resolver, in JavaScript or through Pyodide.

Speed guess, not measured: our benchy spends about 12 s in tree support on this desktop. WASM runs
about 2-3 times slower. A Chromebook CPU is several times slower again. So one to three minutes for
a supported model, with the tab busy. Fine for small parts, painful for big ones. The crash above
would also happen in the browser.

---

## 5. Recommendation

- **Build the Linux container now, with the resolver.** The spike shows the hard part (setting
  formulas) is solved by about 300 lines of Python that read Cura's own files. Use the 4.13.2
  resource files from GitLab commit `5fdb4049` as the frozen profile source, not home Cura. Keep
  retry-on-crash from day one.
- **Get the engine closest to school's: extract CuraEngine from the 4.13.2 AppImage.** Then
  re-run the benchy test. If the supports then match exactly, we are done matching. If not, the
  difference is somewhere else and we try building `cura-engine-le`. I do not know which engine
  build school has. This step is the test.
- **At school, confirm the Cura LE version (Help, About) and, if possible, do one
  `--external-backend` capture of the class profile.** Compare it with `resolved_hd_4132.json`.
  This proves the resolver or shows what it misses.
- **Accept a small support difference if the exact engine cannot be found.** Start and end G-code,
  temperatures, walls, skin and infill already match byte for byte or to 0.1 mm. That is what
  matters for the printer's safety and the probing sequence. Print one benchy from our file before
  students use it.
- **Park WebAssembly.** It would save container cost, but there is no maintained 4.13 build. We
  would have to compile LulzBot's engine ourselves, and tree supports would be slow on a
  Chromebook. Revisit after the container works, if container time costs too much.

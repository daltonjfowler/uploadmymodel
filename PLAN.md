# uploadmymodel: Plan (draft for review)

A web app where students **slice their own 3D models for the classroom LulzBot Workhorse** from a
Chromebook, using **only the print settings the teacher allows**, then carry the G-code to the
printer on an **SD card in a USB dongle**. Cura LulzBot Edition stays on the teacher's computer for
anything unusual. This app handles "kid mode" only.

Third in the family, after [uploadmycode](https://uploadmycode.com) and
[uploadmylaser](https://uploadmylaser.com). It should copy their architecture where it fits: a
Cloudflare Worker, a **Cloudflare Container for the heavy work**, a teacher key, a class phrase,
and no student accounts.

| uploadmycode | uploadmylaser | uploadmymodel |
|---|---|---|
| sketch.ino → container → .hex | SVG/DXF → container → .rd | STL/OBJ/3MF → container (slicer) → .gcode |
| sent over Web Serial | sent over Web Serial | **downloaded**, copied to SD card by hand |
| Uno board fixed on the server | power/speed presets on the server | print profiles frozen on the server |

**Status:** holding page live at https://uploadmymodel.com (2026-09-25). Nothing below is built yet.

---

## 1. Goals / non-goals

**Goals (first version)**
- Works in Chrome on district Chromebooks. Nothing to install.
- Student flow: open site → upload model → see it on the Workhorse bed → turn / lay flat / scale →
  pick a class setting → **Slice** → see print time and filament → **Download for SD card**.
- Students **never set temperatures, speeds, retraction, or start/end G-code.** Those come only from
  the teacher's profile, on the server.
- The printer does exactly what it does today with the class Cura profile: same start sequence
  (nozzle wipe, bed probing), same temperatures, same end sequence.
- Teacher page: choose which class settings students see, set limits (max print time, max size),
  set the class phrase.

**Non-goals (for now)**
- Sending to the printer over USB or Wi-Fi. SD card only. (The Workhorse is not on the network, and
  the SD card step keeps a human in the loop.)
- Multi-material, custom supports, per-model settings, modifier meshes. Use Cura LE for those.
- Student accounts, saved job history on the server.

---

## 2. What we think we know (verify in Phase 0)

Treat every row as a guess until it is marked verified. The class profile is the source of truth.

| Fact | Value we expect | Verified? |
|---|---|---|
| Printer | LulzBot Workhorse (Marlin firmware, LulzBot build) | no |
| Build volume | 280 × 280 × 285 mm | no |
| Filament diameter | 2.85 mm | no |
| Tool head / nozzle | shown in Cura LE's printer name (e.g. an SE-style 0.5 mm head) | no |
| Bed | heated, PEI; auto-levels by probing corner washers after a nozzle wipe | no |
| Start G-code | long LulzBot sequence (heat, wipe, probe, prime). Must be copied exactly | no |
| SD card | full-size slot on the LCD. Marlin reads FAT16/FAT32, **not exFAT** | no |
| Long file names | LCD probably shows them; must test | no |
| Slicer today | Cura LulzBot Edition, version ? | no |
| Material | ? (e.g. PLA from LulzBot / Polymaker) | no |

Why the SD card format matters: most cards bigger than 32 GB come formatted exFAT, and the printer
will not see them. The student guide will say "use the class cards" and the teacher guide will say
how to format one as FAT32.

---

## 3. Architecture (proposed)

```
Chromebook (Chrome)                            Cloudflare
┌──────────────────────────────┐  POST /api/slice  ┌──────────── Worker ────────────────────────┐
│ upload STL / OBJ / 3MF       │ ─────────────────►│ phrase check, rate limit, size limit       │
│ 3D preview on the bed        │  {model, presetId,│ loads the frozen preset + limits from KV   │
│ turn / lay flat / scale      │   transform, name}│ forwards to SlicerContainer                │
│ pick class setting           │                   │           │                                │
│                              │ ◄─────────────────│           ▼                                │
│ Download .gcode → SD card    │  {gcode, timeS,   │ container: mesh check → place on bed →     │
└──────────────────────────────┘   filamentG,      │ CuraEngine with frozen settings → checks   │
                                   warnings}       └────────────────────────────────────────────┘
```

- **Slicer engine: CuraEngine** (recommended), the same engine version that Cura LE uses, run in
  the container. This is the only way to get "prints exactly like it does now" with the tested
  profile. Fallback if it proves too hard: PrusaSlicer's command line, which takes flat config
  files, but the profile would have to be rebuilt by hand and re-tested on the printer.
- **The hard part, stated up front:** CuraEngine alone does not understand Cura's setting formulas.
  The Cura app works out hundreds of dependent values (e.g. infill line spacing from infill %)
  before calling the engine. Plan: work those out **once, offline**, from the teacher's exported
  profile, and store each class setting as a **frozen, flat list of every value**. The container
  only passes frozen values. Students pick a preset; they never send a setting.
- **Proof it matches:** a golden test slices the same models with Cura LE (on the teacher's PC) and
  with our container, then compares: start/end G-code identical, same temperatures, same layer
  count, total filament and print time within a few percent.
- **Worker** is uploadmylaser's skeleton: `SlicerContainer` in place of `LaserContainer`, same
  `Counters` Durable Object, its own `CLASS_KV` namespace (never share one with the other sites),
  teacher key, phrase, optional school IP lock.
- **Browser stays light** for slow Chromebooks: three.js (MIT) for the 3D preview, no framework.
- **Stateless:** models are sliced in memory and never stored.
- **Cost:** slicing is CPU-heavy. The container allowance is shared with uploadmycode and
  uploadmylaser. Measure slice times on the `basic` instance in Phase 1 before choosing a size.
- **License:** CuraEngine is AGPLv3. We run it unmodified in a public repo and credit it. If we ever
  change its code, the changed source must be published too.

---

## 4. Guardrails

| Students can | Students cannot |
|---|---|
| Upload STL (first), then OBJ and 3MF | Change temperatures, speeds, cooling, retraction |
| Turn, lay flat, scale (shown in mm) | Edit start/end G-code or the material |
| Pick one of the teacher's class settings (e.g. Draft / Normal / Strong) | Type in any setting number |
| Supports on/off, if the teacher allows it | Go past the bed size or the teacher's max print time |
| Type their name for the file | Print more copies than the teacher allows |

Server-side checks before any G-code is returned:
- Model fits the bed with a margin, and is not microscopic or huge by mistake (e.g. mm vs inches).
- Mesh sanity: warn on holes / not watertight, and on parts too thin to print with this nozzle.
- Estimated print time ≤ teacher's limit; filament ≤ limit.
- A header comment in the G-code with student name, class setting, date, and estimates, so the
  teacher can see who made a file. An `M117` message puts the student's name on the LCD at start.
- File name built on the server: short, plain letters and numbers, e.g. `jordan-bracket.gcode`.

Honest limit: the output is a plain text file on an SD card. Guardrails stop **mistakes**, not a
determined student with a text editor. The printer firmware's own temperature limits are the last
line of defense, and the teacher still starts every print.

---

## 5. Phases (each ends with a review before the next starts)

### Phase 0: Gather and verify
Dalton sends (see §6). Then:
- Put the profile files in `profiles/` and write `docs/HARDWARE.md` with verified facts.
- Test the SD path on a real Chromebook: save a known-good Cura LE file to a class SD card through
  the dongle, eject, print it. Check how the file name shows on the LCD.
- Engine spike: build CuraEngine (matching Cura LE's version) in Docker, slice a 20 mm cube with a
  frozen profile, diff against Cura LE's G-code.
- **Review gate:** does our cube G-code match Cura LE's? Decide CuraEngine vs PrusaSlicer.

### Phase 1: Slicing core
- Container: STL/OBJ/3MF in → mesh checks → centre on bed → CuraEngine with a frozen preset →
  G-code + estimates out.
- Tool that turns the teacher's Cura export into frozen presets (runs on a dev machine, not live).
- Golden tests with 3-5 real student models. Measure slice time and memory on `basic`.
- **Review gate:** print the golden models from our G-code. They should look like Cura LE's.

### Phase 2: Student page
- Upload, 3D bed preview, turn / lay flat / scale, class-setting picker, Slice, results, Download.
- Friendly errors ("Your model is bigger than the printer. Try 50%.").
- Theme toggle and footer like the other two sites.
- **Review gate:** a student who has never seen it can go from Tinkercad export to SD card alone.

### Phase 3: Teacher page
- Teacher key, class phrase, which presets are visible, supports allowed, max time / size / copies,
  warm-up button for the container.
- **Review gate:** Dalton sets up a class without help.

### Phase 4: Classroom pilot
- `docs/TEST_PLAN.md`, a one-page student guide (including "eject before you pull the card"), and a
  teacher guide (formatting SD cards, what the LCD message means).
- One class period uses it. Fix what they trip on.

### Later, maybe
- Layer-by-layer G-code preview.
- Auto-orient ("best side down"), several models on one plate.
- A teacher queue: students submit, teacher approves and downloads.

---

## 6. What Dalton sends for Phase 0

1. **Cura LE version** (Help → About).
2. **Printer and tool head** exactly as Cura LE names them, and the **material** selected.
3. **A project file:** load a small test model (a 20 mm cube is fine), select the class profile,
   then File → Save Project. This `.3mf` holds the whole settings stack, which is what we need most.
4. **The G-code** Cura LE makes from that same project: the real file you would put on the SD card.
5. **The profile export:** Preferences → Configure Cura → Profiles → select it → Export
   (`.curaprofile`).
6. **Which settings you change for students today** (e.g. supports, infill %, brim) and which ones
   they must never touch.
7. **Class rules:** max print time, max size, prints per student, supports allowed or not.
8. **SD card details:** card size and format, and whether the LCD shows long file names.

---

## 7. Open questions

- Which Cura LE version, and can we build the matching CuraEngine version in Docker? (Phase 0)
- Should the student's name go in the file name, the LCD message, both, or neither?
- Do students need supports at all in version 1, or is "lay it flat" enough to start?
- One class setting or several? (Suggest two to start: Normal and Strong.)
- Is the Workhorse the only printer, or will other LulzBots need profiles later?

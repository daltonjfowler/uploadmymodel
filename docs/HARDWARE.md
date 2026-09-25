# Hardware and slicer facts

Every fact says where it came from. **School G-code** means
`test/golden/benchy_school_cura_4.13.2.gcode`, a real file sliced at school with the class profile.
That is the strongest source we have. **Home Cura** means Cura LulzBot Edition 4.13.17 installed on
Dalton's home PC, which is a newer version than school (see "Two Cura versions" below).

## Printer

| Fact | Value | Source | Verified on the printer? |
|---|---|---|---|
| How many | 4 printers | Dalton, 2026-09-25 | yes |
| Model | LulzBot TAZ Workhorse, SE tool head (all 4 the same? ask) | School G-code header | no |
| Tool head | SE, 0.50 mm nozzle, nickel-plated copper | School G-code + home Cura definition | no |
| Build volume | 280 × 280 × 285 mm | Home Cura (`taz.def.json`) | no |
| Filament | 2.85 mm, Polymaker PolyLite PLA | School G-code header | no |
| Firmware flavor | Marlin | School G-code (`;FLAVOR:Marlin`) | no |
| Firmware, printers 1-3 | Marlin **2.0.9.0.13** (LulzBot build) | Dalton, 2026-09-25 | yes |
| Firmware, printer 4 | newer, exact version unknown. Home Cura 4.13.17 ships 2.1.3.0.48, so that is a likely guess | Dalton + home Cura `resources/firmware/Workhorse/` | no |
| Bed levelling | nozzle wipe (`G12`) then probing (`G29`) every print | School G-code start | no |
| SD card | full-size slot on the LCD; Marlin reads FAT16/FAT32, not exFAT | general Marlin knowledge | no |
| Long file names on the LCD | unknown | | no |

## The class profile

`current_lulzbot_9_18`: Workhorse SE + PolyLite PLA + **High Detail** quality, with tree supports
touching the build plate and 20% infill. Full details: `profiles/current_lulzbot_9_18.json`.

What the printer actually does with it (school G-code):
- First layer 0.35 mm at 205 °C nozzle / 65 °C bed; after that 0.18 mm layers at 210 °C / 60 °C.
- Part fan off for layer 0, then 25 / 50 / 75 %, full from layer 4.
- Skirt, not brim. Mostly 25 mm/s walls, 30 mm/s infill, 35 mm/s supports.
- Ends by cooling the bed to 35 °C, then pushing the bed forward (`G1 Y280`) to present the print.
- 3DBenchy: 266 layers, 3 h 9 min, 2.76 m / about 20.6 g of filament.

## Two Cura versions (important)

School sliced with engine **4.13.2**. Home Cura is **4.13.17**. Their start G-code is different:

| School (4.13.2) | Home (4.13.17) |
|---|---|
| `G26` clear probe-fail flag | not present |
| `M109 R180` soften filament, then `G28`, then `G1 E-15` retract | `G28 O`, `G1 E-4` retract |
| `M204 S100` slow probing acceleration | not present |
| `G1 Z2 E0 F75` tiny prime | purge lines plus `M8100` purge pattern |
| `M900 K0.05` | `M900 K{linear_advance}` |

Three of the four printers run firmware 2.0.9.0.13, which is older than the 2.1.3.0.48 that home
Cura 4.13.17 is written for. School Cura's start G-code is what those three are tested with. So
**uploadmymodel must produce the school version's start and end G-code, byte for byte**, and home
Cura 4.13.17 should not be used to make class prints.

Goal: **one G-code file that runs on all four printers**, so a student can use any free printer.
If printer 4 already prints school Cura files fine today, the school start G-code is proven on both
firmware versions. Keep all firmware as it is while we build: if Cura offers a firmware update when
a printer is plugged in by USB, say no for now.

## Still to check at school

1. Cura LE version on the school computer (Help → About).
2. Printer 4's exact firmware version. Does it print school Cura files fine today? Are all four
   printers SE 0.50 mm tool heads? Label printer 4 so we can tell it apart.
3. SD card size and format (FAT32?), and how long file names show on the LCD.
4. A Chromebook → SD card dongle → printer test with a known-good file.

# Hardware and slicer facts

Every fact says where it came from. **School G-code** means
`test/golden/benchy_school_cura_4.13.2.gcode`, a real file sliced at school with the class profile.
That is the strongest source we have. **Home Cura** means Cura LulzBot Edition 4.13.17 installed on
Dalton's home PC, which is a newer version than school (see "Two Cura versions" below).

## Printer

| Fact | Value | Source | Verified on the printer? |
|---|---|---|---|
| Model | LulzBot TAZ Workhorse, SE tool head | School G-code header | no |
| Tool head | SE, 0.50 mm nozzle, nickel-plated copper | School G-code + home Cura definition | no |
| Build volume | 280 × 280 × 285 mm | Home Cura (`taz.def.json`) | no |
| Filament | 2.85 mm, Polymaker PolyLite PLA | School G-code header | no |
| Firmware flavor | Marlin | School G-code (`;FLAVOR:Marlin`) | no |
| Firmware version | unknown. Home Cura expects 2.1.3.0.48 | Home Cura (`taz_workhorse.def.json`) | no |
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

The school printer's firmware is matched to what school Cura sends today. Until we know the
printer's firmware version, **uploadmymodel must produce the school version's start and end G-code,
byte for byte**, and home Cura 4.13.17 should not be used to make class prints.

## Still to check at school

1. Cura LE version on the school computer (Help → About).
2. Printer firmware version (LCD info screen, if it has one).
3. SD card size and format (FAT32?), and how long file names show on the LCD.
4. A Chromebook → SD card dongle → printer test with a known-good file.

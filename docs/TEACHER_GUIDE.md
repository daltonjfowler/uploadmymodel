# Teacher guide

What works today (2026-09-26) and how to run it. Student steps are in
[STUDENT_GUIDE.md](STUDENT_GUIDE.md).

## Status

- **Live (2026-09-26):** the student page, real slicing (school's Cura LE 4.13.2 engine, about
  15 s for a supported Benchy), and the teacher page.
- Slicing only works while you have it open for the class (below). Everything else works any time.

## The teacher page

**uploadmymodel.com/teacher/** (also the **Teacher** link at the top of the student page).

1. **Teacher key.** One shared password for uploadmycode, uploadmylaser and uploadmymodel, saved in
   `TEACHER-PASSWORD.txt` on the development PC's desktop. Tick **Remember on this computer** on
   your own machine only. To change it, run `npx wrangler secret put TEACHER_KEY` in each of the
   three project folders.
2. **Class settings.** For each setting:
   - **Students can change**: on, or off to lock it. A locked setting shows greyed out with a 🔒,
     and the server refuses a file that changes it.
   - **Starts at**: what every student starts with, whether it is locked or not. "(school)" marks
     the current school Cura profile.
3. **Longest print.** Files that would print longer are refused, with a hint to use Fast quality,
   less infill or a smaller size. This uses the slicer's own time estimate, so it only works once
   the slicer is live.
4. **Note to students.** Up to 160 characters, shown at the top of the print settings.
5. **Save for the class.** Students get the change when they open or reload the page.
   **Back to the school profile** puts everything back (still needs Save).

## Opening slicing for a class

On the teacher page, **Slicing for this class**: keep the suggested phrase (or type your own),
choose how long, press **Open slicing**, and put the big phrase on the board. Students type it the
first time they press Slice. Everything else on the site works without it. **Close now** ends it
early; otherwise it closes by itself. While it is closed nobody can wake the slicer, so there is
nothing to pay for.

## One password for all three sites (later)

Each site checks its own `TEACHER_KEY` secret. The simplest way to share one password is to set
the same key on all three: run `npx wrangler secret put TEACHER_KEY` in each project folder
(uploadmycode, uploadmylaser, uploadmymodel) and paste the same key. For a separate password per
person (you and a coworker, each one removable on its own), the sites would need a small change
to accept a list of keys.

## What students can never change

Temperatures, speeds, cooling, retraction, start and end G-code, and the filament. These come from
Cura LulzBot Edition 4.13.2's own profile files (the version the school uses), the same as today.

## SD cards (not yet checked on the printers)

- The Workhorse reads **FAT32**. Cards over 32 GB usually come as exFAT and will not show up.
  Format them as FAT32, or use 32 GB or smaller cards.
- Files are named like `jordan-rocket.gcode`. How long names show on the printer screen is not
  checked yet.
- Students must **eject** the card before pulling it out of the Chromebook, or the file can be
  cut short.

## Decisions waiting for you

1. **Student name on the printer screen** during the print (an `M117` line)? Today it is only in
   the file name, which students can change.
2. At school: note the Cura LE version (Help → About), print one file from uploadmymodel next to
   one from school Cura, and run the **printer USB test** (`/usb-test/`) on a Chromebook for
   "print from USB" (`docs/USB_PRINTING.md`).

Decided 2026-09-26: tree supports always 0% infill (hollow branches in school's engine); the
teacher opens slicing with a class phrase; students name their files.

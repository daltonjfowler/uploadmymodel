# Teacher guide

What works today (2026-09-26) and how to run it. Student steps are in
[STUDENT_GUIDE.md](STUDENT_GUIDE.md).

## Status

- **Live now:** the student page (open, arrange, settings, Preview of any `.gcode` file) and the
  teacher page.
- **Not live yet: slicing.** Slice checks everything and then says the engine is not connected.
  The slicer works on the development PC (`container/README.md`). Putting it online needs a
  decision on Cloudflare container cost; the switch is ready on the `slicer-live` branch
  (`docs/GO_LIVE.md` there).

## The teacher page

**uploadmymodel.com/teacher/** (also the **Teacher** link at the top of the student page).

1. **Teacher key.** It is saved in `uploadmymodel-TEACHER-KEY.txt` on the development PC's
   desktop. Tick **Remember on this computer** on your own machine only. To change the key, run
   `npx wrangler secret put TEACHER_KEY` in the project folder.
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

1. **Tree support infill.** Your rule is 0%. In school's 4.13.2 engine that gives hollow branches,
   about half the support plastic of today's 15% (Benchy: 17.3 g against 20.6 g in total). They
   are lighter and easier to snap off, but may be weaker. Print one test Benchy from the slicer
   before deciding.
2. **Going live with the slicer**: container size and cost. Measured with Docker limits on the
   development PC: a supported Benchy takes about 80 s on a quarter CPU and 33 s on half a CPU.
   See `container/README.md`.
3. **Class phrase** (like uploadmycode and uploadmylaser): should the site stay open, or close
   when no phrase is set?
4. **Student name in the file**: only in the file name today. It could also show on the printer
   screen during the print (an `M117` line).
5. At school: note the Cura LE version (Help → About), and print one file from uploadmymodel next
   to one from school Cura to compare.

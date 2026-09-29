# Print from USB: plan (option A built)

> **2026-09-28 update: option A is BUILT** (`web/src/printer-usb.js`, "Copy to printer (USB)" on the
> result card, teacher switch "Copy to the printer over USB", on by default). The school test that
> day: 250000, `Cap:SD_WRITE:1`, `ok P15 B3`, 8.3 names only. The copy uses line numbers and
> checksums, keeps at most 3 lines / 110 bytes in flight, drops comments, refuses SD commands in
> the file, sends nothing before "Writing to file", and stops if the printer restarts or says
> busy. It never prints and never deletes. Real copy speed: about 10 KB/s, so a big file takes
> many minutes.

Dalton asked (2026-09-26) whether students could print over the printer's USB cable instead of
carrying an SD card. This page is the plan. The only thing built so far is a **read-only test
page**, `/usb-test/`, to find out at school whether a Chromebook can talk to the Workhorse at all.

## Step 1: the USB test (built, needs a school test)

On a Chromebook at school, plug the printer's USB cable in, open **uploadmymodel.com/usb-test/**
in Chrome, press Connect, pick the printer, then press the four buttons. Press **Copy for Dalton**
and paste the result somewhere. It tells us:

- whether Chrome sees the printer and at which speed (250000 or 115200);
- the firmware name and version on each printer (M115), and whether it reports SD card support,
  long file names and binary file transfer;
- temperatures (M105), SD printing status (M27) and the files on its card (M20).

The page can only send those four questions. There is no box to type commands into, and nothing
on it heats, moves or prints.

## Step 2: pick how it should work

**Option A: copy the file onto the printer's own SD card over USB, then the teacher presses
Print on the printer (recommended).**
- Marlin can write a file to its card while connected (`M28 name` … `M29`).
- After the copy, the print does not depend on the Chromebook at all: it can close, sleep or
  leave.
- The teacher still starts every print from the printer's screen, as today.
- Unknowns to test: copy speed (line by line at 250000 baud, a 3 MB file may take several
  minutes); Marlin 2.0.9 may only write short 8.3 names (like `JORDAN~1.GCO`), so the page would
  pick the name; a card must stay in the printer.

**Option B: stream the print from the Chromebook (like Cura's "Print via USB").**
- The Chromebook must stay awake, plugged in and on the page for the whole print (hours). A
  closed lid, a sleep, a tab reload or a student walking off stops the print halfway.
- It would also mean the page sends heating and motion commands, so it needs a teacher unlock
  and a big Stop button.
- Not recommended for a classroom.

## Safety rules for whichever we build

- The page only ever sends G-code made by the slicer from the teacher's profile, never typed
  commands.
- Option A never starts a print; option B needs the teacher to unlock it on the teacher page.
- The teacher page can turn USB printing off for the class.
- Web Serial is allowed only on this site's own pages (`permissions-policy: serial=(self)`).

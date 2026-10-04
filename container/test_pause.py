"""Check pause.py (colour change pauses) against the school Benchy and small made-up files.
Run: python container/test_pause.py  (from the repo root; no Docker or CuraEngine needed)."""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pause  # noqa: E402

GOLDEN = os.path.join(HERE, "..", "test", "golden", "benchy_school_cura_4.13.2.gcode")
BLOCK = re.compile(rb";TYPE:CUSTOM\n;uploadmymodel: pause.*?\nG92 E[-0-9.]+[^\n]*\n|;TYPE:CUSTOM\n;uploadmymodel: pause.*?\nM83 ; relative E, as before\n", re.S)


def golden():
    with open(GOLDEN, "rb") as f:
        return f.read()


def blocks(gcode):
    return [m.group(0).decode() for m in BLOCK.finditer(gcode)]


def made_up(layers=6, first=0.3, step=0.2, relative=False, box=(130, 130, 150, 150), reset_at=None):
    """A small Cura-shaped file: Z moves come at the end of the layer before (like Cura 4.13),
    each layer retracts before the travel and unretracts after its ;LAYER line."""
    x0, y0, x1, y1 = box
    out = [";FLAVOR:Marlin", "M140 S60", "M104 S205", "G90", "M83" if relative else "M82", "G92 E0", "M109 R205"]
    e = 0.0
    for n in range(layers):
        z = first + n * step
        out += ["G1 F1500 E-1.5" if relative else f"G1 F1500 E{e - 1.5:.5f}", f"G0 F3000 X{x0} Y{y0} Z{z:.2f}", f";LAYER:{n}"]
        out.append("G1 F1500 E1.5" if relative else f"G1 F1500 E{e:.5f}")
        if reset_at == n:
            out.append("G92 E0")
            e = 0.0
        for (x, y) in ((x1, y0), (x1, y1), (x0, y1), (x0, y0)):
            e += 1.0
            out.append(f"G1 F1200 X{x} Y{y} E{1.0 if relative else e:.5f}")
    out += [";TIME_ELAPSED:100", "M104 S0", "M140 S0", "M84"]
    return ("\n".join(out) + "\n").encode()


class LayerChoice(unittest.TestCase):
    def test_pauses_before_the_first_layer_printed_above_the_height(self):
        g = golden()  # first layer 0.35 mm, then 0.18 mm: layer 25 tops out at 4.85, layer 26 at 5.03
        for h, cura_layer, z in ((5, 26, 5.03), (4.9, 26, 5.03), (4.85, 26, 5.03), (4.8, 25, 4.85)):
            out, done = pause.add_pauses(g, [h])
            self.assertEqual(len(done), 1)
            self.assertEqual(done[0][0], h)
            self.assertAlmostEqual(done[0][2], z)
            self.assertEqual(done[0][1], cura_layer + 1, "numbered like the Preview tab (from 1)")
            i = out.index(b";uploadmymodel")
            self.assertTrue(out[:i].rstrip().endswith(f";TYPE:CUSTOM".encode()))
            self.assertTrue(out[:i].rstrip()[:-len(";TYPE:CUSTOM")].rstrip().endswith(f";LAYER:{cura_layer}".encode()))

    def test_several_pauses_and_heights_above_the_model(self):
        out, done = pause.add_pauses(golden(), [5, 15.15, 20, 200])
        self.assertEqual([(h, n) for h, n, _ in done], [(5, 27), (15.15, 84), (20, 111)])
        self.assertEqual(len(blocks(out)), 3)
        self.assertEqual(out.count(b"\nM0 "), 3)
        _, done = pause.add_pauses(golden(), [5, 200])
        self.assertEqual([h for h, _, _ in done], [5])

    def test_two_heights_in_one_layer_make_one_pause(self):
        out, done = pause.add_pauses(golden(), [4.9, 4.95])
        self.assertEqual(len(done), 1)
        self.assertEqual(out.count(b"\nM0 "), 1)

    def test_never_before_layer_0(self):
        _, done = pause.add_pauses(made_up(first=0.6), [0.5])
        self.assertEqual(done[0][1], 2)  # layer 1, the second in the file

    def test_nothing_else_changes(self):
        g = golden()
        out, _ = pause.add_pauses(g, [5, 15.15, 20])
        self.assertEqual(BLOCK.sub(b"", out), g)
        self.assertEqual(pause.add_pauses(g, []), (g, []))


class FilamentChange(unittest.TestCase):
    def block(self, gcode, h):
        out, done = pause.add_pauses(gcode, [h])
        self.assertEqual(len(done), 1)
        return blocks(out)[0]

    def test_extruder_position_restored_after_a_mid_file_reset(self):
        # The Benchy resets E (G92 E0) during layer 81; a pause before layer 83 must restore the
        # E position after the reset (23.27208), not 0, or the next move pushes out 8 mm at once.
        b = self.block(golden(), 15.15)
        self.assertTrue(b.rstrip().endswith("G92 E23.27208 ; the extruder position Cura expects"))
        self.assertIn("M82 ; absolute E again", b)

    def test_extruder_position_equals_the_last_e_before_the_layer(self):
        g = golden()
        out, _ = pause.add_pauses(g, [5])
        i = out.index(b";TYPE:CUSTOM\n;uploadmymodel")
        last_e = re.findall(rb"^G[01] [^;\n]*E(-?[0-9.]+)", out[:i], re.M)[-1].decode()
        self.assertIn(f"G92 E{float(last_e):.5f}", blocks(out)[0])

    def test_reset_in_the_layer_before(self):
        b = self.block(made_up(reset_at=2), 1.05)  # reset during layer 2, pause before layer 4
        self.assertIn("G92 E6.50000", b)  # 2 layers x 4 mm after the reset, minus the 1.5 retract

    def test_relative_extrusion_stays_relative(self):
        b = self.block(made_up(relative=True), 0.6)
        self.assertNotIn("G92", b)
        self.assertNotIn("M82", b)
        self.assertTrue(b.rstrip().endswith("M83 ; relative E, as before"))

    def test_filament_left_where_cura_expects_it(self):
        # Cura retracted 1.5 mm before the layer change and unretracts 1.5 mm right after the
        # ;LAYER line. After the swap the new filament reaches the nozzle tip (pushed by hand,
        # then purged), so the pause must leave it 1.5 mm back: purge, pull back 1 + 1.5, go back,
        # push 1 forward.
        b = self.block(golden(), 5)
        es = [float(v) for v in re.findall(r"^G1 E(-?[0-9.]+)", b, re.M)]
        self.assertEqual(es, [-1, pause.PURGE_MM, -2.5, 1])
        b = self.block(made_up(relative=True), 0.6)
        es = [float(v) for v in re.findall(r"^G1 E(-?[0-9.]+)", b, re.M)]
        self.assertEqual(es, [-1, pause.PURGE_MM, -2.5, 1])

    def test_motors_heaters_and_order(self):
        b = self.block(golden(), 5)
        lines = [l.split(";")[0].strip() for l in b.splitlines() if l and not l.startswith(";")]
        self.assertIn("M84 S0", lines)          # no idle timeout: X/Y/Z keep their place
        self.assertIn("M18 E", lines)           # only the filament motor is let go
        self.assertNotIn("M84", lines)          # never a bare M84/M18 (that frees every axis)
        self.assertNotIn("M18", lines)
        for bad in ("M600", "M125", "M25", "M104", "M140", "M190", "M106", "M107", "G28", "G91"):
            self.assertFalse(any(l.split()[0] == bad for l in lines), bad)
        self.assertIn("M109 R210", lines)       # waits for the G-code's own print temperature
        order = [lines.index(c) for c in ("M83", "G1 E-1 F1500", "M18 E", "M0", "M109 R210", "G1 E5 F60", "G1 E-2.5 F1500",
                                          "G1 X141.943 Y154.078 F9000", "G1 Z5.03 F300", "G1 E1 F1500", "M82")]
        self.assertEqual(order, sorted(order))
        self.assertLess(lines.index("G1 Z6.03 F300"), lines.index("G1 X190 Y190 F9000"))  # lift before moving

    def test_moves_stay_in_the_build_volume(self):
        out, _ = pause.add_pauses(golden(), [5, 15.15, 20])
        for b in blocks(out):
            for m in re.finditer(r"\b([XYZ])(-?[0-9.]+)", b.split("\n", 2)[2]):
                v = float(m.group(2))
                hi = {"X": 280, "Y": 280, "Z": 285}[m.group(1)]
                self.assertTrue(0 <= v <= hi, m.group(0))


class Parking(unittest.TestCase):
    def test_default_park_when_clear(self):
        b = FilamentChange.block(self, made_up(box=(100, 100, 150, 150)), 0.6)
        self.assertIn("G1 X190 Y190 F9000 ; park away from the print", b)
        self.assertIn("G1 E5 F60", b)

    def test_moves_away_when_the_print_is_under_x190_y190(self):
        b = FilamentChange.block(self, made_up(box=(100, 100, 200, 200)), 0.6)
        self.assertIn("G1 X140 Y265 F9000 ; park away from the print", b)
        self.assertIn("G1 E5 F60", b)

    def test_no_purge_when_the_print_covers_every_park_point(self):
        b = FilamentChange.block(self, made_up(box=(5, 5, 275, 275)), 0.6)
        self.assertIn("G1 X190 Y190 F9000 ; park over the print", b)
        self.assertNotIn("G1 E5", b)
        es = [float(v) for v in re.findall(r"^G1 E(-?[0-9.]+)", b, re.M)]
        self.assertEqual(es, [-1, -2.5, 1])

    def test_park_z_at_least_15_and_lift_above_the_print(self):
        b = FilamentChange.block(self, made_up(), 0.6)
        self.assertIn("G1 Z1.7 F300 ; lift off the print", b)  # layer 2 at 0.7 mm, + 1
        self.assertIn("\nG1 Z15 F300\n", b)


class Header(unittest.TestCase):
    def test_check_pauses(self):
        self.assertEqual(pause.check_pauses(None), [])
        self.assertEqual(pause.check_pauses("[12.5, 5, 5]"), [5, 12.5])
        for bad in ("x", "{}", "[0.4]", "[281]", "[5.01]", "[1,2,3,4]", '["5"]', "[true]"):
            with self.assertRaises(ValueError, msg=bad):
                pause.check_pauses(bad)


if __name__ == "__main__":
    unittest.main()

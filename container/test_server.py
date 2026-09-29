"""Check server.py's time budget without CuraEngine: every attempt of one slice shares
SLICE_BUDGET_S, so a slice can never hold the lock (and its place in the Worker's line) longer.
Run: python container/test_server.py  (from the repo root; no Docker needed)."""
import os
import subprocess
import sys
import types
import unittest

# Stand-ins for engine/resolve.py and engine/run.py, loaded before server.py imports them.
fake_resolve = types.ModuleType("resolve")
fake_resolve.resolve = lambda quality, gl_user=None, ex_user=None, material_id="polylite_pla": {}
fake_run = types.ModuleType("run")
fake_run.ENGINE = sys.executable  # server.py asks the engine for its version once; any program will do
sys.modules["resolve"] = fake_resolve
sys.modules["run"] = fake_run
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

STL = b"\0" * 84


class FakeEngine:
    """Each run takes `seconds[i]` on a fake clock and exits with `exits[i]`."""

    def __init__(self, seconds, exits, timeout_on=None):
        self.now = 1000.0
        self.seconds, self.exits, self.timeout_on = seconds, exits, timeout_on
        self.timeouts = []
        server.clock = lambda: self.now
        fake_run.slice_file = self.slice_file

    def slice_file(self, r, model, out, overrides, workdir=None, timeout=None):
        i = len(self.timeouts)
        self.timeouts.append(timeout)
        if self.timeout_on == i:
            raise subprocess.TimeoutExpired("CuraEngine", timeout)
        self.now += self.seconds[i]
        if self.exits[i] == 0:
            with open(out, "wb") as f:
                f.write(b";FLAVOR:Marlin\n")
        return {"exit": self.exits[i], "header": "", "grams": 1.0, "log": "crash"}


class Budget(unittest.TestCase):
    def test_first_try_gets_the_whole_budget(self):
        e = FakeEngine([15], [0])
        gcode, res, attempt = server.slice_plate(STL, "standard", {}, {})
        self.assertEqual((gcode, attempt), (b";FLAVOR:Marlin\n", 1))
        self.assertEqual(e.timeouts, [server.SLICE_BUDGET_S])

    def test_retries_share_what_is_left(self):
        e = FakeEngine([100, 20], [139, 0])
        _, _, attempt = server.slice_plate(STL, "standard", {}, {})
        self.assertEqual(attempt, 2)
        self.assertEqual(e.timeouts, [180, 80])

    def test_no_new_attempt_without_time_for_it(self):
        e = FakeEngine([100, 75, 1], [139, 139, 0])
        with self.assertRaises(server.Refused) as caught:
            server.slice_plate(STL, "standard", {}, {})
        self.assertEqual(caught.exception.status, 500)
        self.assertIn("took too long", str(caught.exception))
        self.assertEqual(e.timeouts, [180, 80])  # 5 s left: the third attempt never starts
        self.assertLessEqual(e.now - 1000.0, server.SLICE_BUDGET_S)

    def test_an_engine_that_runs_out_the_clock_is_stopped(self):
        e = FakeEngine([], [], timeout_on=0)
        with self.assertRaises(server.Refused) as caught:
            server.slice_plate(STL, "standard", {}, {})
        self.assertIn("took too long", str(caught.exception))
        self.assertEqual(e.timeouts, [180])

    def test_every_attempt_failing_is_an_engine_failure(self):
        FakeEngine([10, 10, 10], [139, 139, 139])
        with self.assertRaises(server.Refused) as caught:
            server.slice_plate(STL, "standard", {}, {})
        self.assertIn("engine failed", str(caught.exception))

    def test_the_worker_line_lease_covers_one_slice(self):
        # src/line.js LEASE_MS must be SLICE_BUDGET_S + 30 s (upload and answer).
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "src", "line.js"), encoding="utf-8") as f:
            line = f.read()
        self.assertIn(f"export const LEASE_MS = {(server.SLICE_BUDGET_S + 30) * 1000:_};", line)


if __name__ == "__main__":
    unittest.main()

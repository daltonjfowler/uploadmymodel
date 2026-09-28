"""uploadmymodel slicer service (runs in the container, see Dockerfile).

POST /slice
  body:    binary STL of the whole plate, in printer coordinates (front-left corner = 0,0), exactly
           as the Worker checked it (web/src/viewer.js exportPlateSTL).
  header:  x-cura-settings: JSON from shared/settings.js toCuraOverrides() (already checked by the
           Worker against the allow-lists and the teacher's locks; checked again here).
  answer:  200 text/plain G-code, with x-print-time-s, x-filament-m, x-filament-g, x-layers,
           x-engine-seconds, x-attempts. 400 / 413 / 500 JSON {"error": ...} otherwise.
GET /health -> {"ok": true, "engine": "<version line>"}

One slice at a time (a lock): tree supports use one core and ~75 MB, and a queue is kinder to a
small container than running several at once. Tree supports crash CuraEngine now and then
(docs/ENGINE_OPTIONS.md), so a failed slice is retried, all tries within SLICE_BUDGET_S.
"""
import json
import os
import re
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "engine"))
sys.path.insert(0, HERE)
import pause  # noqa: E402
import resolve  # noqa: E402
import run  # noqa: E402

PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 45 * 1024 * 1024
MAX_TRIANGLES = 800_000  # same as shared/settings.js LIMITS.maxTriangles
BED_X, BED_Y = 280.0, 280.0
ATTEMPTS = 3
# All attempts of one slice together, so a slice holds the lock (and its place in the Worker's line)
# for at most this long. A supported Benchy takes ~15 s live. src/line.js LEASE_MS is this + 30 s:
# change both together.
SLICE_BUDGET_S = 180
MIN_ATTEMPT_S = 10  # less than this left: do not start another attempt
clock = time.monotonic  # the tests replace it

QUALITY = {"high detail": "high_detail", "standard": "standard", "high speed": "high_speed"}
# Exactly the keys toCuraOverrides() sends, with the values each may take.
CHOICES = {
    "infill_pattern": {"grid", "lines", "triangles", "trihexagon", "cubic", "gyroid", "lightning"},
    "support_structure": {"tree"},
    "support_type": {"buildplate", "everywhere"},
    "adhesion_type": {"skirt", "brim", "raft", "none"},
}
NUMBERS = {
    "wall_line_count": (2, 4, 1),
    "infill_sparse_density": (0, 100, 5),
    "support_infill_rate": (0, 0, 1),
    "support_angle": (40, 80, 5),
}
BOOLS = {"support_enable"}
# The "Assistant to the Regional Manager" tab: optional extra keys and the only values each may take
# (written from shared/arm.js by scripts/arm-values.mjs; test/arm.test.mjs keeps them equal). A key
# the base list also has (wall_line_count, infill_pattern) may take either list's values.
with open(os.path.join(HERE, "arm_values.json"), encoding="utf-8") as _f:
    ARM_VALUES = json.load(_f)
# Everything the printer does must stay inside the build volume (a huge brim or a mold near the
# edge could reach past it): checked on every G0/G1 of the layers before the file goes out.
BED_Z = 285.0

lock = threading.Lock()
_help = subprocess.run([run.ENGINE, "help"], capture_output=True, text=True)
_version = re.search(r"Cura_SteamEngine version \S+", _help.stdout + _help.stderr)
ENGINE_VERSION = _version.group(0) if _version else "unknown"


class Refused(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def check_settings(raw):
    """The Worker's toCuraOverrides() output -> (quality, user layer as Cura-style strings)."""
    try:
        s = json.loads(raw or "")
    except ValueError:
        raise Refused(400, "settings are not JSON")
    if not isinstance(s, dict):
        raise Refused(400, "settings must be an object")
    expected = set(CHOICES) | set(NUMBERS) | BOOLS | {"quality_type"}
    if not expected <= set(s) or not set(s) <= expected | set(ARM_VALUES):
        raise Refused(400, f"settings keys must be {sorted(expected)} plus only these extras: {sorted(ARM_VALUES)}")
    if s["quality_type"] not in QUALITY:
        raise Refused(400, "quality_type")
    user = {}
    for k, v in s.items():
        if k == "quality_type":
            continue
        if arm_value_ok(k, v):
            user[k] = cura_string(v)
        elif k in CHOICES and v in CHOICES[k]:
            user[k] = v
        elif k in NUMBERS and isinstance(v, int) and not isinstance(v, bool) and _in_range(v, *NUMBERS[k]):
            user[k] = str(v)
        elif k in BOOLS and isinstance(v, bool):
            user[k] = cura_string(v)
        else:
            raise Refused(400, k)
    return QUALITY[s["quality_type"]], user


def _in_range(v, lo, hi, step):
    return lo <= v <= hi and (v - lo) % step == 0


def _same(a, b):
    # True == 1 in Python: a bool only matches a bool, a number only a number.
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) < 1e-9
    return type(a) is type(b) and a == b


def arm_value_ok(k, v):
    return any(_same(v, a) for a in ARM_VALUES.get(k, []))


def cura_string(v):
    if isinstance(v, bool):
        return "True" if v else "False"
    return str(v)


MOVE_LINE = re.compile(rb"^G[01]\b[^;\n]*", re.M)
AXIS = {axis: re.compile(rb"\b" + axis + rb"(-?\d+(?:\.\d+)?)") for axis in (b"X", b"Y", b"Z")}


def outside_build_volume(gcode):
    """The first move of the layers that leaves 0..280 x 0..280 x 0..285 mm, or None."""
    first = gcode.find(b"\n;LAYER:")
    last = gcode.rfind(b"\n;TIME_ELAPSED:")
    if first < 0 or last < first:
        return None
    for m in MOVE_LINE.finditer(gcode, first, last):
        line = m.group(0)
        for axis, hi in ((b"X", BED_X), (b"Y", BED_Y), (b"Z", BED_Z)):
            p = AXIS[axis].search(line)
            if p and not -0.001 <= float(p.group(1)) <= hi + 0.001:
                return line.decode(errors="replace")
    return None


def centred_stl(data):
    """Check the STL and move it from printer coordinates to centred on 0,0: CuraEngine adds the
    machine centre itself (machine_center_is_zero = false), like Cura does for a loaded mesh."""
    if len(data) < 84:
        raise Refused(400, "model is empty")
    (count,) = struct.unpack_from("<I", data, 80)
    if count == 0 or count > MAX_TRIANGLES or 84 + count * 50 != len(data):
        raise Refused(400, "model is not a valid binary STL of an allowed size")
    out = bytearray(data)
    tri = struct.Struct("<12fH")  # normal, 3 corners, attribute: one 50-byte record
    hx, hy = BED_X / 2, BED_Y / 2
    for i, r in enumerate(tri.iter_unpack(memoryview(data)[84:])):
        tri.pack_into(out, 84 + i * 50, r[0], r[1], r[2],
                      r[3] - hx, r[4] - hy, r[5], r[6] - hx, r[7] - hy, r[8], r[9] - hx, r[10] - hy, r[11], r[12])
    return bytes(out)


# The setting work (resolve.resolve) depends only on the settings, and a class mostly uses the same
# few combinations, so keep the answers. slice_file() copies what it changes, so reuse is safe.
_resolved = {}


def resolved(quality, user):
    key = (quality, tuple(sorted(user.items())))
    r = _resolved.get(key)
    if r is None:
        r = resolve.resolve(quality, gl_user=user, ex_user=user)
        if len(_resolved) > 64:
            _resolved.clear()
        _resolved[key] = r
    return r


def mesh_file_name(name):
    # The student's model name as a plain file name (the Worker already cleaned it; check again).
    clean = re.sub(r"[^a-z0-9-]+", "-", str(name or "").lower()).strip("-")[:30]
    return f"{clean or 'plate'}.stl"


def slice_plate(stl, quality, user, timings, model_name=None):
    deadline = clock() + SLICE_BUDGET_S
    t = time.time()
    r = resolved(quality, user)
    timings["resolve"] = time.time() - t
    overrides = {"material_bed_temp_prepend": "False", "material_print_temp_prepend": "False"}
    with tempfile.TemporaryDirectory() as tmp:
        model = os.path.join(tmp, mesh_file_name(model_name))
        out = os.path.join(tmp, "plate.gcode")
        with open(model, "wb") as f:
            f.write(stl)
        last = None
        for attempt in range(1, ATTEMPTS + 1):
            left = deadline - clock()
            if left < MIN_ATTEMPT_S:
                print(json.dumps({"message": "no time left to retry", "attempt": attempt}), flush=True)
                raise Refused(500, "slicing took too long")
            t = time.time()
            try:
                res = run.slice_file(r, model, out, overrides, workdir=os.path.join(tmp, "flat"), timeout=left)
            except subprocess.TimeoutExpired:
                raise Refused(500, "slicing took too long")
            timings["engine"] = timings.get("engine", 0) + time.time() - t
            if res["exit"] == 0:
                with open(out, "rb") as f:
                    gcode = f.read()
                return gcode, res, attempt
            last = res
            print(json.dumps({"message": "engine failed, retrying", "attempt": attempt, "exit": res["exit"]}), flush=True)
        tail = (last or {}).get("log", "")[-400:]
        print(json.dumps({"message": "engine failed", "log_tail": tail}), flush=True)
        raise Refused(500, "the slicing engine failed")


class Handler(BaseHTTPRequestHandler):
    server_version = "uploadmymodel-slicer"

    def log_message(self, fmt, *args):  # one JSON line per request instead of the default
        print(json.dumps({"request": self.requestline, "status": args[1] if len(args) > 1 else None}), flush=True)

    def reply_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply_json(200, {"ok": True, "engine": ENGINE_VERSION})
        else:
            self.reply_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/slice":
            return self.reply_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length", "-1"))
            if length < 0:
                raise Refused(411, "content-length required")
            if length > MAX_BODY:
                raise Refused(413, "model too big")
            quality, user = check_settings(self.headers.get("x-cura-settings"))
            try:
                pauses = pause.check_pauses(self.headers.get("x-pauses"))
            except ValueError as e:
                raise Refused(400, str(e))
            t0 = time.time()
            timings = {}
            stl = centred_stl(self.rfile.read(length))
            timings["model"] = time.time() - t0
            # Whoever holds the lock is done within SLICE_BUDGET_S, so waiting longer means trouble.
            if not lock.acquire(timeout=SLICE_BUDGET_S):
                raise Refused(503, "slicer busy")
            try:
                timings["queue"] = time.time() - t0 - timings["model"]
                gcode, res, attempts = slice_plate(stl, quality, user, timings, self.headers.get("x-model-name"))
            finally:
                lock.release()
            header = res["header"] or ""
            bad = outside_build_volume(gcode)
            if bad:
                print(json.dumps({"message": "outside the build volume", "move": bad[:80]}), flush=True)
                raise Refused(400, "outside")
            gcode, paused = pause.add_pauses(gcode, pauses)
            time_s = re.search(r";TIME:(\d+)", header)
            metres = re.search(r";Filament used: ([0-9.]+)m", header)
            layers = len(re.findall(rb"^;LAYER:\d+", gcode, re.M))
            self.send_response(200)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.send_header("content-length", str(len(gcode)))
            self.send_header("x-print-time-s", time_s.group(1) if time_s else "")
            self.send_header("x-filament-m", metres.group(1) if metres else "")
            self.send_header("x-filament-g", f"{res['grams']:.2f}")
            self.send_header("x-layers", str(layers))
            self.send_header("x-engine-seconds", f"{time.time() - t0:.1f}")
            self.send_header("x-attempts", str(attempts))
            self.send_header("x-pauses-done", ",".join(f"{h:g}@{layer}" for h, layer, _z in paused))
            self.send_header("x-timings", ";".join(f"{k}={v:.2f}" for k, v in timings.items()))
            self.end_headers()
            self.wfile.write(gcode)
        except (BrokenPipeError, ConnectionResetError):
            # The caller went away (tab closed, request cancelled): nothing left to answer.
            print(json.dumps({"message": "caller disconnected"}), flush=True)
        except Refused as e:
            self.reply_json(e.status, {"error": str(e)})
        except Exception as e:  # never leak a traceback to the caller
            print(json.dumps({"message": "slice crashed", "error": repr(e)}), flush=True)
            try:
                self.reply_json(500, {"error": "internal error"})
            except (BrokenPipeError, ConnectionResetError):
                pass


# The class settings as the Worker sends them (toCuraOverrides(CLASS_DEFAULTS)).
CLASS_DEFAULT_SETTINGS = {
    "quality_type": "high detail", "wall_line_count": 2, "infill_sparse_density": 20, "infill_pattern": "grid",
    "support_enable": True, "support_structure": "tree", "support_type": "buildplate", "support_infill_rate": 0,
    "support_angle": 60, "adhesion_type": "skirt",
}


def warm_up():
    # When the container wakes: work out the class settings and slice a 10 mm cube once, so the
    # first student gets cached settings and a warm engine.
    try:
        t = time.time()
        quality, user = check_settings(json.dumps(CLASS_DEFAULT_SETTINGS))
        v = [(0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0), (0, 0, 10), (10, 0, 10), (10, 10, 10), (0, 10, 10)]
        faces = [(0, 3, 2), (0, 2, 1), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (2, 3, 7), (2, 7, 6), (1, 2, 6), (1, 6, 5), (3, 0, 4), (3, 4, 7)]
        stl = bytearray(84 + len(faces) * 50)
        struct.pack_into("<I", stl, 80, len(faces))
        for i, f in enumerate(faces):
            corners = [c for k in f for c in (v[k][0] + BED_X / 2, v[k][1] + BED_Y / 2, v[k][2])]
            struct.pack_into("<12fH", stl, 84 + i * 50, 0, 0, 0, *corners, 0)
        with lock:
            slice_plate(centred_stl(bytes(stl)), quality, user, {})
        print(json.dumps({"message": "warm", "seconds": round(time.time() - t, 2)}), flush=True)
    except Exception as e:  # warming is a nicety; never stop the service for it
        print(json.dumps({"message": "warm-up failed", "error": repr(e)}), flush=True)


def stop(signum, frame):
    # THE sleep fix (uploadmycode's September 2026 bill, same bug). This process is PID 1 in the
    # container, and Linux ignores an unhandled SIGTERM for PID 1: Cloudflare's idle stop never
    # landed, so a started slicer stayed awake (and billed 3 GiB) until the next deploy replaced it.
    # The idle stop never comes mid-slice (a request in flight keeps the container awake); a deploy
    # or eviction may, so wait up to 2 s for a running slice, then go.
    print(json.dumps({"message": "shutdown", "signal": signum}), flush=True)
    got = lock.acquire(timeout=2)
    os._exit(0 if got else 1)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    print(json.dumps({"message": "slicer listening", "port": PORT, "engine": ENGINE_VERSION}), flush=True)
    threading.Thread(target=warm_up, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

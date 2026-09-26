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
(docs/ENGINE_OPTIONS.md), so a failed slice is retried.
"""
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine"))
import resolve  # noqa: E402
import run  # noqa: E402

PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 45 * 1024 * 1024
MAX_TRIANGLES = 800_000  # same as shared/settings.js LIMITS.maxTriangles
BED_X, BED_Y = 280.0, 280.0
ATTEMPTS = 3
TIMEOUT_S = 240

QUALITY = {"high detail": "high_detail", "standard": "standard", "high speed": "high_speed"}
# Exactly the keys toCuraOverrides() sends, with the values each may take.
CHOICES = {
    "infill_pattern": {"grid", "lines", "triangles", "trihexagon", "cubic", "gyroid", "lightning"},
    "support_structure": {"tree"},
    "support_type": {"buildplate", "everywhere"},
    "adhesion_type": {"skirt", "brim"},
}
NUMBERS = {
    "wall_line_count": (2, 4, 1),
    "infill_sparse_density": (0, 100, 5),
    "support_infill_rate": (0, 0, 1),
    "support_angle": (40, 80, 5),
}
BOOLS = {"support_enable"}

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
    if set(s) != expected:
        raise Refused(400, f"settings keys must be exactly {sorted(expected)}")
    if s["quality_type"] not in QUALITY:
        raise Refused(400, "quality_type")
    user = {}
    for k, allowed in CHOICES.items():
        if s[k] not in allowed:
            raise Refused(400, k)
        user[k] = s[k]
    for k, (lo, hi, step) in NUMBERS.items():
        v = s[k]
        if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi or (v - lo) % step:
            raise Refused(400, k)
        user[k] = str(v)
    for k in BOOLS:
        if not isinstance(s[k], bool):
            raise Refused(400, k)
        user[k] = "True" if s[k] else "False"
    return QUALITY[s["quality_type"]], user


def centred_stl(data):
    """Check the STL and move it from printer coordinates to centred on 0,0: CuraEngine adds the
    machine centre itself (machine_center_is_zero = false), like Cura does for a loaded mesh."""
    if len(data) < 84:
        raise Refused(400, "model is empty")
    (count,) = struct.unpack_from("<I", data, 80)
    if count == 0 or count > MAX_TRIANGLES or 84 + count * 50 != len(data):
        raise Refused(400, "model is not a valid binary STL of an allowed size")
    out = bytearray(data)
    for t in range(count):
        base = 84 + t * 50 + 12
        for v in range(3):
            off = base + v * 12
            x, y = struct.unpack_from("<ff", out, off)
            struct.pack_into("<ff", out, off, x - BED_X / 2, y - BED_Y / 2)
    return bytes(out)


def slice_plate(stl, quality, user):
    r = resolve.resolve(quality, gl_user=user, ex_user=user)
    overrides = {"material_bed_temp_prepend": "False", "material_print_temp_prepend": "False"}
    with tempfile.TemporaryDirectory() as tmp:
        model = os.path.join(tmp, "plate.stl")
        out = os.path.join(tmp, "plate.gcode")
        with open(model, "wb") as f:
            f.write(stl)
        last = None
        for attempt in range(1, ATTEMPTS + 1):
            try:
                res = run.slice_file(r, model, out, overrides, workdir=os.path.join(tmp, "flat"), timeout=TIMEOUT_S)
            except subprocess.TimeoutExpired:
                raise Refused(500, "slicing took too long")
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
            stl = centred_stl(self.rfile.read(length))
            t0 = time.time()
            with lock:
                gcode, res, attempts = slice_plate(stl, quality, user)
            header = res["header"] or ""
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
            self.end_headers()
            self.wfile.write(gcode)
        except Refused as e:
            self.reply_json(e.status, {"error": str(e)})
        except Exception as e:  # never leak a traceback to the caller
            print(json.dumps({"message": "slice crashed", "error": repr(e)}), flush=True)
            self.reply_json(500, {"error": "internal error"})


if __name__ == "__main__":
    print(json.dumps({"message": "slicer listening", "port": PORT, "engine": ENGINE_VERSION}), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

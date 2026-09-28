"""Pause at height for filament (colour) changes: the "Assistant to the Regional Manager" tab.

Adds the same steps Cura LulzBot Edition's own "Pause at height" script writes for Marlin (its
PostProcessingPlugin/scripts/PauseAtHeight.py, pause method "Marlin (M0)", default park X190 Y190),
before the first layer that starts above each height the student picked:

  retract 1 mm, lift 1 mm, park at X190 Y190 (and at least Z15), keep the motors on, show a
  message, M0 (wait for the knob), go back, unretract, carry on.

It never changes a temperature, a fan or a speed (the nozzle stays hot so the old filament can be
pulled and the new one pushed through by hand), and every move stays inside the build volume.
"""
import re

MAX_PAUSES = 3
MIN_HEIGHT, MAX_HEIGHT = 0.5, 280.0
PARK_X, PARK_Y, PARK_Z_MIN = 190.0, 190.0, 15.0
MACHINE_Z = 285.0
RETRACT_MM, RETRACT_F = 1.0, 1500  # Cura's defaults: 1 mm at 25 mm/s

LAYER = re.compile(rb"^;LAYER:(-?\d+)\s*$", re.M)
MOVE = re.compile(rb"^G[01]\b[^\n;]*", re.M)


def check_pauses(raw):
    """The x-pauses header: a JSON list of up to 3 heights in mm (multiples of 0.05)."""
    import json
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except ValueError:
        raise ValueError("pauses are not JSON")
    if not isinstance(v, list) or len(v) > MAX_PAUSES:
        raise ValueError(f"pauses: a list of at most {MAX_PAUSES} heights")
    out = []
    for h in v:
        if isinstance(h, bool) or not isinstance(h, (int, float)) or not MIN_HEIGHT <= h <= MAX_HEIGHT:
            raise ValueError(f"pauses: heights from {MIN_HEIGHT} to {MAX_HEIGHT} mm")
        if abs(round(h * 20) - h * 20) > 1e-6:
            raise ValueError("pauses: heights in steps of 0.05 mm")
        out.append(round(h, 2))
    return sorted(set(out))


def _param(line, letter):
    m = re.search(rb"\b" + letter + rb"(-?\d+(?:\.\d+)?)", line)
    return float(m.group(1)) if m else None


def _fmt(v):
    return f"{v:.3f}".rstrip("0").rstrip(".")


def add_pauses(gcode, heights):
    """gcode: bytes from CuraEngine. Returns (new gcode, [(height, layer, z)] actually inserted)."""
    if not heights:
        return gcode, []
    todo = sorted(heights)
    parts = []
    done = []
    pos = 0
    x = y = z = e = None
    feed = None
    layers = list(LAYER.finditer(gcode))
    for i, m in enumerate(layers):
        # Track the machine state up to this layer marker.
        for mv in MOVE.finditer(gcode, pos if i else 0, m.start()):
            line = mv.group(0)
            x = _param(line, b"X") if _param(line, b"X") is not None else x
            y = _param(line, b"Y") if _param(line, b"Y") is not None else y
            z = _param(line, b"Z") if _param(line, b"Z") is not None else z
            if line.startswith(b"G1"):
                e = _param(line, b"E") if _param(line, b"E") is not None else e
                feed = _param(line, b"F") if _param(line, b"F") is not None else feed
        for g92 in re.finditer(rb"^G92 E(-?\d+(?:\.\d+)?)", gcode[pos if i else 0:m.start()], re.M):
            e = float(g92.group(1))
        pos = m.start()
        if int(m.group(1)) < 1 or not todo:
            continue
        # This layer's height: the first Z the layer moves to (Cura puts it on the first travel).
        nxt = layers[i + 1].start() if i + 1 < len(layers) else len(gcode)
        layer_z = None
        for mv in MOVE.finditer(gcode, m.end(), nxt):
            layer_z = _param(mv.group(0), b"Z")
            if layer_z is not None:
                break
        if layer_z is None or z is None or x is None or y is None or e is None:
            continue
        wanted = [h for h in todo if layer_z > h + 1e-6]
        if not wanted:
            continue
        todo = [h for h in todo if h not in wanted]
        block = pause_block(x, y, z, e, feed, wanted[0], int(m.group(1)))
        cut = m.end() + 1  # right after the ";LAYER:n" line
        parts.append((cut, block))
        done.append((wanted[0], int(m.group(1)), layer_z))
    out = bytearray()
    last = 0
    for cut, block in parts:
        out += gcode[last:cut] + block
        last = cut
    out += gcode[last:]
    return bytes(out), done


def pause_block(x, y, z, e, feed, height, layer):
    lift = min(z + 1, MACHINE_Z)
    park_z = min(max(lift, PARK_Z_MIN), MACHINE_Z)
    lines = [
        ";TYPE:CUSTOM",
        f";uploadmymodel: pause for a filament change at {_fmt(height)} mm (before layer {layer})",
        "M83 ; relative E for the retraction",
        f"G1 E-{_fmt(RETRACT_MM)} F{RETRACT_F}",
        f"G1 Z{_fmt(lift)} F300",
        f"G1 X{_fmt(PARK_X)} Y{_fmt(PARK_Y)} F9000",
    ]
    if park_z > lift:
        lines.append(f"G1 Z{_fmt(park_z)} F300")
    lines += [
        "M84 S0 ; keep the motors on while paused, so the print cannot shift",
        "M117 Swap filament, click",
        "M0 ; wait for the knob",
        "M84 S120 ; motor idle timeout back to Marlin's default",
        "M117 Printing...",
        f"G1 X{_fmt(x)} Y{_fmt(y)} F9000",
        f"G1 Z{_fmt(z)} F300",
        f"G1 E{_fmt(RETRACT_MM)} F{RETRACT_F}",
    ]
    if feed:
        lines.append(f"G1 F{_fmt(feed)}")
    lines += ["M82 ; absolute E again", f"G92 E{e:.5f}"]
    return ("\n".join(lines) + "\n").encode()

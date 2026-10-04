"""Pause at height for filament (colour) changes: the "Assistant to the Regional Manager" tab.

Based on Cura LulzBot Edition's own "Pause at height" script for Marlin (its
PostProcessingPlugin/scripts/PauseAtHeight.py, pause method "Marlin (M0)", default park X190 Y190),
inserted right after the ";LAYER:n" line of the first layer printed above each height the student
picked (layer height = the Z of that layer's first printed line, as the Preview tab shows it):

  retract 1 mm, lift 1 mm, park away from the print (at least Z15), keep X/Y/Z motors on but let
  the filament motor go (so the filament can be pulled out and pushed in by hand), M0 (wait for the
  knob), wait for the nozzle to be at printing temperature again, push 5 mm of new filament
  through (only when the park point is clear of the print), retract as far as Cura expects at
  that point, go back, unretract, put the extruder position (G92 E) and the extrusion mode
  (M82 / M83) back, carry on.

Why M0 and not M600: M600 needs ADVANCED_PAUSE_FEATURE, and we have not checked that every
classroom printer's LulzBot firmware has it; an unknown M600 is skipped and the print carries on
in the old colour. M0 works on any Marlin with an LCD knob (Cura LE uses it for LulzBot).

It never sets a new temperature, a fan or a speed: the nozzle and bed stay at the profile's
temperatures (M109 R only re-waits for the temperature the G-code already set, in case firmware
turned the nozzle down while waiting). Every move stays inside the build volume.
"""
import re

MAX_PAUSES = 3
MIN_HEIGHT, MAX_HEIGHT = 0.5, 280.0
MACHINE_Z = 285.0  # the bed is 280 x 280 mm: every PARKS point is inside it
PARK_Z_MIN = 15.0
# Where to park, in order of preference: Cura LE's default first, then the middle of each bed edge
# (not the corners: the Workhorse probes its levelling washers there). The first point at least
# CLEAR_MM from everything the print puts down is used, so purge plastic and drips land on the bed.
PARKS = [(190.0, 190.0), (140.0, 265.0), (265.0, 140.0), (15.0, 140.0), (140.0, 15.0)]
CLEAR_MM = 15.0
RETRACT_MM, RETRACT_F = 1.0, 1500  # Cura's defaults: 1 mm at 25 mm/s
PURGE_MM, PURGE_F = 5.0, 60  # 5 mm of 2.85 mm filament at 1 mm/s

# One pass over the lines that matter: moves, E resets, modes, nozzle temperatures, layer marks.
LINE = re.compile(rb"^(?:(G0?[01]|G92|G28|G9[01]|M8[23]|M10[49])(?![0-9.])([^;\n]*)|;LAYER:(-?\d+)[ \t\r]*$)", re.M)
PARAMS = re.compile(rb"([XYZEFSR])(-?\d*\.?\d+)")


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


def _fmt(v):
    return f"{v:.3f}".rstrip("0").rstrip(".")


def _scan(gcode):
    """Walk the G-code once, in order. Returns (layers, (minx, miny, maxx, maxy) of printed lines).

    layers: one dict per ";LAYER:n" line: cut (offset just after that line), n (Cura's number),
    number (1-based, in file order, like the Preview tab), state (x, y, z, e, feed, relative_e,
    relative_xyz, nozzle temperature) at that line, z (the Z of the layer's first printed line)."""
    layers = []
    x = y = z = e = feed = None
    rel_e = rel_xyz = False
    temp = None
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    cur = None  # the layer being read
    for m in LINE.finditer(gcode):
        word = m.group(1)
        if word is None:
            nl = gcode.find(b"\n", m.end())
            cur = {"cut": len(gcode) if nl < 0 else nl + 1, "n": int(m.group(3)), "number": len(layers) + 1,
                   "state": (x, y, z, e, feed, rel_e, rel_xyz, temp), "z": None, "unretract": None}
            layers.append(cur)
            continue
        v = dict(PARAMS.findall(m.group(2)))
        if word in (b"G0", b"G1", b"G00", b"G01"):
            vx, vy, vz, ve, vf = (float(v[k]) if k in v else None for k in (b"X", b"Y", b"Z", b"E", b"F"))
            if rel_xyz:  # not used by Cura in the layers: a moved axis is unknown until G90 + a move
                nx = None if vx is not None else x
                ny = None if vy is not None else y
                nz = None if vz is not None else z
            else:
                nx = x if vx is None else vx
                ny = y if vy is None else vy
                nz = z if vz is None else vz
            pushed = False
            delta = None
            if ve is not None:
                if rel_e or rel_xyz:
                    delta = ve
                    e = None if e is None else e + ve
                else:
                    delta = None if e is None else ve - e
                    e = ve
                pushed = delta is not None and delta > 1e-6
            if cur is not None and cur["unretract"] is None and (ve is not None or nx != x or ny != y):
                # Cura retracts before the layer change and pushes the filament back right after
                # the ";LAYER" line: how far, so the pause can leave the filament the same way.
                cur["unretract"] = delta if pushed and nx == x and ny == y and delta < 20 else 0.0
            if pushed and cur is not None and nx is not None and ny is not None and (nx != x or ny != y):
                if cur["z"] is None:
                    cur["z"] = nz
                for px, py in ((nx, ny), (x, y)):
                    if px is not None and py is not None:
                        minx, maxx = min(minx, px), max(maxx, px)
                        miny, maxy = min(miny, py), max(maxy, py)
            x, y, z = nx, ny, nz
            if vf is not None:
                feed = vf
        elif word == b"G92":
            if b"E" in v:
                e = float(v[b"E"])
            if b"X" in v or b"Y" in v or b"Z" in v:  # never used by Cura in the layers
                x = y = z = None
        elif word == b"G28":
            x = y = z = None
        elif word == b"G90":
            rel_xyz = False
        elif word == b"G91":
            rel_xyz = True
        elif word == b"M82":
            rel_e = False
        elif word == b"M83":
            rel_e = True
        else:  # M104 / M109
            t = v.get(b"S", v.get(b"R"))
            if t is not None:
                temp = float(t)
    return layers, (minx, miny, maxx, maxy)


def park_point(box):
    """(x, y, clear): the first PARKS point CLEAR_MM away from the print's footprint, or Cura LE's
    X190 Y190 with clear=False when the print covers all of them."""
    minx, miny, maxx, maxy = box
    for px, py in PARKS:
        if not (minx - CLEAR_MM <= px <= maxx + CLEAR_MM and miny - CLEAR_MM <= py <= maxy + CLEAR_MM):
            return px, py, True
    return PARKS[0][0], PARKS[0][1], False


def add_pauses(gcode, heights):
    """gcode: bytes from CuraEngine. Returns (new gcode, [(height, layer number, layer z)] actually
    inserted). The layer number counts from 1 in file order, like the Preview tab."""
    if not heights:
        return gcode, []
    layers, box = _scan(gcode)
    park = park_point(box)
    todo = sorted(heights)
    parts = []
    done = []
    for L in layers:
        if not todo:
            break
        x, y, z, e, feed, rel_e, rel_xyz, temp = L["state"]
        # Never before Cura's layer 0 or a raft layer; skip a layer we cannot follow.
        if L["n"] < 1 or L["z"] is None or None in (x, y, z) or rel_xyz or (e is None and not rel_e):
            continue
        wanted = [h for h in todo if L["z"] > h + 1e-6]
        if not wanted:
            continue
        todo = [h for h in todo if h not in wanted]
        parts.append((L["cut"], pause_block(L["state"], park, wanted[0], L["n"], L["z"], L["unretract"] or 0.0)))
        done.append((wanted[0], L["number"], L["z"]))
    out = bytearray()
    last = 0
    for cut, block in parts:
        out += gcode[last:cut]
        if not out.endswith(b"\n"):
            out += b"\n"
        out += block
        last = cut
    out += gcode[last:]
    return bytes(out), done


def pause_block(state, park, height, layer, layer_z, unretract=0.0):
    """The G-code for one pause. state: (x, y, z, e, feed, relative_e, relative_xyz, temp) where the
    printer is just before the layer; park: (x, y, clear) from park_point(); unretract: how far Cura
    pushes the filament back right after the ";LAYER" line (it retracted before the layer change)."""
    x, y, z, e, feed, rel_e, _rel_xyz, temp = state
    park_x, park_y, clear = park
    lift = min(z + 1, MACHINE_Z)
    park_z = min(max(lift, PARK_Z_MIN), MACHINE_Z)
    lines = [
        ";TYPE:CUSTOM",
        f";uploadmymodel: pause for a filament change at {_fmt(height)} mm (before layer {layer}, Z{_fmt(layer_z)})",
        "M83 ; relative E for the pause",
        f"G1 E-{_fmt(RETRACT_MM)} F{RETRACT_F} ; pull the filament back a little",
        f"G1 Z{_fmt(lift)} F300 ; lift off the print",
        f"G1 X{_fmt(park_x)} Y{_fmt(park_y)} F9000 ; park {'away from' if clear else 'over'} the print",
    ]
    if park_z > lift:
        lines.append(f"G1 Z{_fmt(park_z)} F300")
    lines += [
        "M84 S0 ; no motor idle timeout while paused, so X, Y and Z cannot lose their place",
        "M18 E ; only the filament motor lets go, so the filament can be pulled out and pushed in by hand",
        "M117 Change filament, then click",
        "M0 ; wait for the knob (nozzle and bed stay hot)",
    ]
    if temp and temp > 0:
        lines.append(f"M109 R{_fmt(temp)} ; make sure the nozzle is at printing temperature again")
    if clear:
        lines.append(f"G1 E{_fmt(PURGE_MM)} F{PURGE_F} ; push a little new filament through, onto the empty bed")
    # The new filament now reaches the nozzle tip. Pull it back as far as Cura expects at this
    # point (our 1 mm plus Cura's own retraction), so Cura's next unretract does not make a blob.
    lines.append(f"G1 E-{_fmt(RETRACT_MM + unretract)} F{RETRACT_F}")
    lines += [
        "M84 S120 ; motor idle timeout back to Marlin's default",
        "M117 Printing...",
        f"G1 X{_fmt(x)} Y{_fmt(y)} F9000 ; back over the print",
        f"G1 Z{_fmt(z)} F300",
        f"G1 E{_fmt(RETRACT_MM)} F{RETRACT_F} ; filament forward again",
    ]
    if feed:
        lines.append(f"G1 F{_fmt(feed)}")
    if rel_e:
        lines.append("M83 ; relative E, as before")
    else:
        lines += ["M82 ; absolute E again", f"G92 E{e:.5f} ; the extruder position Cura expects"]
    return ("\n".join(lines) + "\n").encode()

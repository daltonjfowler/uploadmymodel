"""Spike: slice with CuraEngine.exe from Cura LE 4.13.17 using a frozen, flat settings file.

python run.py <resolved.json> <model.stl> <out.gcode> [key=value ...]   (overrides go to global AND extruder 0)
"""
import json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
# CURA_ENGINE: the CuraEngine binary (Linux: e.g. /usr/bin/CuraEngine).
ENGINE = os.environ.get("CURA_ENGINE", r"C:\Program Files\CuraLE 4.13\CuraEngine.exe")
GOLDEN = os.path.join(HERE, "..", "test", "golden", "benchy_school_cura_4.13.2.gcode")


def school_start_end():
    """Cut the school's expanded start and end G-code out of the golden file (CRLF -> LF)."""
    lines = open(GOLDEN, "rb").read().decode("utf-8").split("\r\n")
    s = lines.index("M82 ;absolute extrusion mode") + 1
    e = next(i for i in range(s, len(lines)) if lines[i] == "G92 E0")
    start = "\n".join(lines[s:e])  # the engine adds one "\n" after it
    start = re.sub(r";Filament weight = ~[0-9.]+g", ";Filament weight = {filament_weight}", start)
    es = next(i for i in range(len(lines) - 1, 0, -1) if lines[i].startswith("M400 "))
    ee = next(i for i in range(es, len(lines)) if lines[i].startswith("M117 Print Complete."))
    end = "\n".join(lines[es:ee + 2])
    return start, end


def expand(template, g, e, mat):
    """Cura's GcodeStartEndFormatter: {key} from extruder 0, else global; unknown keys stay as {key}."""
    tokens = dict(g)
    tokens.update(e)
    tokens.update({"material_brand": mat["brand"], "material_name": mat["name"], "material_type": mat["material"],
                   "print_bed_temperature": g["material_bed_temperature"], "print_temperature": e["material_print_temperature"],
                   "travel_speed": g["speed_travel"]})
    return re.sub(r"\{([^{}]+)\}", lambda m: tokens.get(m.group(1).strip(), m.group(0)), template)


def flat_def(name, values, extruder_id=None):
    d = {"version": 2, "name": name, "metadata": {}, "settings": {"flat": {"type": "category", "children": {
        k: {"type": "str", "default_value": v} for k, v in values.items()}}}}
    if extruder_id:
        d["metadata"]["machine_extruder_trains"] = {"0": extruder_id}
    return d


def slice_file(r, model, out, overrides=None, workdir=None, timeout=None):
    """Slice `model` (STL) to `out` with resolved settings `r` (resolve.resolve()). Returns
    {"exit", "seconds", "header", "filament_mm3", "grams", "log"}; exit != 0 means the engine failed
    and `out` is not usable. `workdir` holds the flat definition files (default: flat/ here)."""
    overrides = overrides or {}
    workdir = workdir or os.path.join(HERE, "flat")
    g, e = dict(r["global"]), dict(r["extruder0"])
    if os.environ.get("USE_GOLDEN_START") == "1":
        start, end = school_start_end()
    else:
        start, end = expand(g["machine_start_gcode"], g, e, r["material"]), expand(g["machine_end_gcode"], g, e, r["material"])
    g["machine_start_gcode"], g["machine_end_gcode"] = start, end
    for k, v in overrides.items():
        g[k] = v
        if k in e:
            e[k] = v
    os.makedirs(workdir, exist_ok=True)
    json.dump(flat_def("flat_extruder", e), open(os.path.join(workdir, "flat_extruder.def.json"), "w"), indent=1)
    json.dump(flat_def("flat_machine", g, "flat_extruder"), open(os.path.join(workdir, "flat_machine.def.json"), "w"), indent=1)

    env = dict(os.environ, CURA_ENGINE_SEARCH_PATH=workdir)
    # Run next to the model and pass only its file name: the engine writes it into the G-code as
    # ";MESH:<name>" on every layer (Cura writes the model's file name there too, e.g. 3DBenchy.stl).
    model = os.path.abspath(model)
    cmd = [ENGINE, "slice", "-v", "-j", os.path.abspath(os.path.join(workdir, "flat_machine.def.json")),
           "-l", os.path.basename(model), "-o", os.path.abspath(out)]
    env["CURA_ENGINE_SEARCH_PATH"] = os.path.abspath(workdir)
    t = time.time()
    p = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout, cwd=os.path.dirname(model))
    dt = time.time() - t
    log = p.stdout + p.stderr
    result = {"exit": p.returncode, "seconds": dt, "log": log, "header": None, "filament_mm3": None, "grams": None}
    m = re.search(r"Gcode header after slicing:\n(.*?)End of gcode header.", log, re.S)
    f = re.search(r"Filament \(mm\^3\): ([0-9.]+)", log)
    if p.returncode != 0 or not m or not f:
        result["exit"] = p.returncode or -1
        return result
    header = m.group(1)
    mm3 = float(f.group(1))
    # Post-process like Cura's frontend: real header, filament weight token, (print_job_name).
    grams = mm3 / 1000 * r["material"]["density"]
    data = open(out, "rb").read().decode("utf-8")
    nl = "\r\n" if "\r\n" in data else "\n"
    head_end = data.index(";Generated with")
    data = header.replace("\n", nl) + data[head_end:].lstrip("\r\n")
    data = data.replace("{filament_weight}", "~" + str(round(grams, 2)) + "g")
    open(out, "wb").write(data.encode("utf-8"))
    result.update(header=header, filament_mm3=mm3, grams=grams)
    return result


def main():
    resolved, model, out = sys.argv[1:4]
    overrides = dict(a.split("=", 1) for a in sys.argv[4:])
    r = json.load(open(resolved))
    res = slice_file(r, model, out, overrides)
    open(out + ".log", "w").write(res["log"])
    print("exit", res["exit"], f"{res['seconds']:.2f}s")
    if res["exit"] != 0:
        sys.exit(1)
    print(res["header"])
    dia = float(r["extruder0"]["material_diameter"])
    mm3 = res["filament_mm3"]
    print(f"filament {mm3:.0f} mm3 = {mm3 / (3.14159265 * (dia / 2) ** 2) / 1000:.5f} m = {res['grams']:.2f} g")


if __name__ == "__main__":
    main()

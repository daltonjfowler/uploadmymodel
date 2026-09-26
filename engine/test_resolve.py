"""Check: resolve.resolve('high_detail') (imported, as the slicer service uses it) gives exactly
reference/resolved_hd_4132.json. Run: python engine/test_resolve.py  (needs the Cura LE resources:
the home PC install, or the container's /opt/cura/resources)."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import resolve  # noqa: E402

got = resolve.resolve("high_detail")
want = json.load(open(os.path.join(HERE, "reference", "resolved_hd_4132.json")))
bad = [(s, k) for s in ("global", "extruder0") for k in set(got[s]) | set(want[s]) if got[s].get(k) != want[s].get(k)]
if got["material"] != want["material"]:
    bad.append(("material", "*"))
print(f"{len(got['global'])} global, {len(got['extruder0'])} extruder values; {len(bad)} differ from the reference")
for s, k in bad[:20]:
    print(f"  {s}.{k}: got {got[s].get(k)!r} want {want[s].get(k)!r}" if k != "*" else "  material differs")
sys.exit(1 if bad else 0)

"""Spike: resolve Cura LE setting formulas outside Cura, the way Uranium's container stacks do.

Stack (top first):  user > quality_changes > intent > quality > material > variant > definition_changes > definition
Extruder stack falls through to the global stack. Formulas are evaluated with the stack the lookup
started on as the context (Uranium's PropertyEvaluationContext.rootStack()).

Single extruder only. Writes flat JSON files of resolved values for CuraEngine.
Usage: python resolve.py <quality: high_detail|standard|high_speed> <out_prefix> [key=value ...global] [--e key=value ...extruder]
"""
import ast, builtins, configparser, json, math, os, sys, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
# CURA_RESOURCES: an installed Cura LE resources folder, for any file not in the overlay.
INSTALL = os.environ.get("CURA_RESOURCES", r"C:\Program Files\CuraLE 4.13\resources")
# RES_OVERLAY: files there win over the installed ones. Default: res4132/ next to this script (the
# school version's files from LulzBot's GitLab, see res4132/SOURCE.md). RES_OVERLAY= (empty) turns it off.
OVERLAY = os.environ.get("RES_OVERLAY", os.path.join(HERE, "res4132")) or None
RES = INSTALL


def res_path(*parts):
    if OVERLAY and os.path.exists(os.path.join(OVERLAY, *parts)):
        return os.path.join(OVERLAY, *parts)
    return os.path.join(INSTALL, *parts)


MACHINE = "taz_workhorse_se"
MATERIAL_FILE = "PolyLite_PLA_(Polymaker).xml.fdm_material"
MATERIAL_ID = "PolyLite_PLA_(Polymaker)"


def find_def(def_id):
    if OVERLAY:
        for sub in ("definitions", "extruders"):
            for root, _dirs, files in os.walk(os.path.join(OVERLAY, sub)):
                if def_id + ".def.json" in files:
                    return os.path.join(root, def_id + ".def.json")
    for root, _dirs, files in os.walk(os.path.join(RES, "definitions")):
        if def_id + ".def.json" in files:
            return os.path.join(root, def_id + ".def.json")
    for root, _dirs, files in os.walk(os.path.join(RES, "extruders")):
        if def_id + ".def.json" in files:
            return os.path.join(root, def_id + ".def.json")
    raise FileNotFoundError(def_id)


def load_definition(def_id):
    """Merge a definition chain into {key: {property: value}} plus metadata."""
    chain = []
    cur = def_id
    while cur:
        with open(find_def(cur), encoding="utf-8") as fh:
            d = json.load(fh)
        chain.append(d)
        cur = d.get("inherits")
    chain.reverse()  # base first
    props, meta = {}, {}

    def walk(tree):
        for key, p in tree.items():
            entry = props.setdefault(key, {})
            entry.update({k: v for k, v in p.items() if k != "children"})
            if "children" in p:
                walk(p["children"])

    for d in chain:
        meta.update(d.get("metadata", {}))
        walk(d.get("settings", {}))
        for key, p in d.get("overrides", {}).items():
            entry = props.setdefault(key, {})
            entry.update(p)
            if "default_value_from_file" in p:  # LulzBot extension: G-code from resources/gcodes
                path = res_path("gcodes", p["default_value_from_file"] + ".gcode")
                with open(path, encoding="utf-8") as fh:
                    entry["default_value"] = fh.read()
                entry.pop("value", None)
    return props, meta


class Formula:
    def __init__(self, src):
        self.src = src
        self.tree = ast.parse(src, mode="eval")
        self.code = compile(self.tree, src, "eval")
        self.names = {n.id for n in ast.walk(self.tree) if isinstance(n, ast.Name)}

    def __repr__(self):
        return f"={self.src}"


def parse_literal(raw, typ):
    if isinstance(raw, str) and raw.startswith("="):
        return Formula(raw[1:])
    if typ in ("float", "int", "extruder", "optional_extruder"):
        # Uranium keeps "65" as the int 65 and "0.18" as a float, so str() gives "65", not "65.0".
        try:
            return int(raw)
        except ValueError:
            return float(raw)
    if typ == "bool":
        return raw in ("True", "true", True)
    return raw


def read_cfg(path):
    cp = configparser.ConfigParser(interpolation=None)
    cp.optionxform = str
    cp.read(path, encoding="utf-8")
    return dict(cp["values"]) if cp.has_section("values") else {}


def read_material(path, machine):
    ns = {"m": "http://www.ultimaker.com/material"}
    root = ET.parse(path).getroot()
    mapping = {
        "print temperature": "default_material_print_temperature",
        "heated bed temperature": "default_material_bed_temperature",
        "standby temperature": "material_standby_temperature",
        "part removal temperature": "material_part_removal_temperature",
        "probe temperature": "material_probe_temperature",
        "wipe temperature": "material_wipe_temperature",
        "soften temperature": "material_soften_temperature",
        "print cooling": "cool_fan_speed",
        "retraction amount": "retraction_amount",
        "retraction speed": "retraction_speed",
    }
    out = {"material_diameter": root.find("m:properties/m:diameter", ns).text}
    settings = root.find("m:settings", ns)
    for s in settings.findall("m:setting", ns):
        if s.get("key") in mapping:
            out[mapping[s.get("key")]] = s.text
    for mach in settings.findall("m:machine", ns):
        ids = [mi.get("product") for mi in mach.findall("m:machine_identifier", ns)]
        if machine in ids:
            for s in mach.findall("m:setting", ns):
                if s.get("key") in mapping:
                    out[mapping[s.get("key")]] = s.text
    meta = {
        "brand": root.find("m:metadata/m:name/m:brand", ns).text,
        "material": root.find("m:metadata/m:name/m:material", ns).text,
        "name": root.find("m:metadata/m:name/m:label", ns).text,
        "GUID": root.find("m:metadata/m:GUID", ns).text,
        "purge_pattern": getattr(root.find("m:metadata/m:purge_pattern", ns), "text", "0"),
        "density": float(root.find("m:properties/m:density", ns).text),
    }
    return out, meta


class Stack:
    def __init__(self, name, containers, props, next_stack=None):
        self.name = name
        self.containers = containers  # list of dicts, top first
        self.props = props            # this stack's definition properties
        self.next = next_stack
        self.cache = {}
        self.resolving = set()

    def prop(self, key, p):
        if key in self.props and p in self.props[key]:
            return self.props[key][p]
        if self.next:
            return self.next.prop(key, p)
        return None

    def typ(self, key):
        return self.prop(key, "type")

    def value(self, key, root=None):
        root = root or self
        if root is self and key in self.cache:
            return self.cache[key]
        v = self._value(key, root)
        if root is self:
            self.cache[key] = v
        return v

    def _value(self, key, root):
        is_extruder = self.next is not None
        if is_extruder and self.prop(key, "settable_per_extruder") is False:
            return self.next.value(key)  # global-only setting: ask the global stack
        if not is_extruder:
            res = self.prop(key, "resolve")
            has_instance = any(key in c for c in self.containers)
            if res is not None and not has_instance and key not in self.resolving:
                self.resolving.add(key)
                try:
                    r = self.evaluate(res, root) if isinstance(res, str) else res
                finally:
                    self.resolving.discard(key)
                if r is not None:
                    return r
        for c in self.containers:
            if key in c:
                v = c[key]
                return self.evaluate(v.src, root) if isinstance(v, Formula) else v
        if key in self.props:
            p = self.props[key]
            if "value" in p:
                v = p["value"]
                return self.evaluate(v, root) if isinstance(v, str) else v
            if "default_value" in p:
                return p["default_value"]
        if self.next:
            return self.next._value(key, root)
        return None

    def raw(self, key, root=None):
        """ContainerStack.getRawProperty: no per-extruder redirect, no resolve (used by extruderValue(s))."""
        root = root or self
        for c in self.containers:
            if key in c:
                v = c[key]
                return self.evaluate(v.src, root) if isinstance(v, Formula) else v
        if key in self.props:
            p = self.props[key]
            if "value" in p:
                v = p["value"]
                return self.evaluate(v, root) if isinstance(v, str) else v
            if "default_value" in p:
                return p["default_value"]
        return self.next.raw(key, root) if self.next else None

    def evaluate(self, src, root):
        f = FORMULAS.get(src)
        if f is None:
            f = FORMULAS[src] = Formula(src)
        g = dict(FUNCS)
        for n in f.names:
            # builtins module, not __builtins__: that is a dict when this file is imported, and
            # dir() of a dict would let settings shadow min(), max(), round()...
            if n in g or hasattr(builtins, n):
                continue
            g[n] = root.value(n)
        try:
            return eval(f.code, g)
        except Exception as e:  # Uranium logs and returns None on errors
            print(f"  formula error in {src!r}: {e}", file=sys.stderr)
            return None


FORMULAS = {}
FUNCS = {"math": math}


def keys_of(props):
    return [k for k, p in props.items() if p.get("type") not in (None, "category")]


def resolve(quality="high_detail", gl_user=None, ex_user=None):
    """Every final setting value for one slice, as {"global", "extruder0", "material"}. gl_user and
    ex_user are the user layer (student choices), as strings like Cura stores them."""
    gl_user, ex_user = dict(gl_user or {}), dict(ex_user or {})
    gprops, gmeta = load_definition(MACHINE)
    ext_id = gmeta["machine_extruder_trains"]["0"]
    eprops, _ = load_definition(ext_id)

    qdir = None
    qname = {"high_detail": "High_detail", "standard": "Standard", "high_speed": "High_speed"}[quality]
    g_quality = read_cfg(res_path("quality", "taz_workhorse", "se", f"workhorse_se_global_{quality}.inst.cfg"))
    e_quality = read_cfg(res_path("quality", "taz_workhorse", "se", f"{MATERIAL_ID}_{qname}_workhorse_se.inst.cfg"))
    material, mat_meta = read_material(res_path("materials", MATERIAL_FILE), MACHINE)

    def typed(d, props_a, props_b=None):
        out = {}
        for k, v in d.items():
            t = (props_a.get(k) or (props_b or {}).get(k) or {}).get("type")
            out[k] = parse_literal(v, t)
        return out

    # The class profile current_lulzbot_9_18 (quality_changes), from the school G-code footer.
    g_qc = {"support_enable": "True", "support_structure": "tree", "support_type": "buildplate"}
    e_qc = {"infill_sparse_density": "20"}

    gstack = Stack("global", [typed(gl_user, gprops), typed(g_qc, gprops), {}, typed(g_quality, gprops), {}, {}, {}], gprops)
    estack = Stack("extruder0", [typed(ex_user, eprops, gprops), typed(e_qc, eprops, gprops), {},
                                 typed(e_quality, eprops, gprops), typed(material, eprops, gprops), {}, {}],
                   eprops, next_stack=gstack)
    # Uranium adds extruder_nr etc. via the extruder definition; machine_extruder_count from machine def.

    FUNCS.update({
        "extruderValue": lambda nr, key: estack.raw(key),
        "extruderValues": lambda key: [estack.raw(key)],
        "resolveOrValue": lambda key: gstack.value(key),
        "defaultExtruderPosition": lambda: "0",
        "anyExtruderWithMaterial": lambda key: 0,
        "anyExtruderNrWithOrDefault": lambda key: 0,
        "valueFromContainer": lambda i: None,
        "extruderValueFromContainer": lambda nr, key, i: None,
    })

    def to_engine(v):
        if isinstance(v, bool):
            return "True" if v else "False"
        if isinstance(v, (list, dict)):
            return str(v)
        return str(v) if v is not None else "None"

    all_keys = keys_of(gprops)
    g_values = {k: to_engine(gstack.value(k)) for k in all_keys}
    e_keys = [k for k in set(keys_of(gprops)) | set(keys_of(eprops))
              if (eprops.get(k, {}).get("settable_per_extruder", True) is not False
                  and gprops.get(k, {}).get("settable_per_extruder", True) is not False)]
    e_values = {k: to_engine(estack.value(k)) for k in sorted(e_keys)}
    e_values["material_guid"] = mat_meta["GUID"]

    return {"global": g_values, "extruder0": e_values, "material": mat_meta}


def main():
    quality = sys.argv[1] if len(sys.argv) > 1 else "high_detail"
    out_prefix = sys.argv[2] if len(sys.argv) > 2 else "resolved"
    gl_user, ex_user, target = {}, {}, None
    for a in sys.argv[3:]:
        if a == "--e":
            target = ex_user
            continue
        k, v = a.split("=", 1)
        (target if target is not None else gl_user)[k] = v
    r = resolve(quality, gl_user, ex_user)
    json.dump(r, open(out_prefix + ".json", "w"), indent=1)
    print(f"wrote {out_prefix}.json: {len(r['global'])} global, {len(r['extruder0'])} extruder settings")


if __name__ == "__main__":
    main()

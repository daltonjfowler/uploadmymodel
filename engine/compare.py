"""Compare two G-code files: header, start/end blocks, temps, fans, speeds per feature, retractions."""
import re, sys, collections
def load(p):
    return open(p, 'rb').read().decode('utf-8').replace('\r\n', '\n').split('\n')
def stats(lines):
    st = {'types': collections.Counter(), 'F': collections.defaultdict(collections.Counter), 'temps': [], 'fans': [], 'retracts': collections.Counter(), 'layers': 0}
    t = 'START'; layer = -1; lastE = 0.0; lastF = None
    for ln in lines:
        if ln.startswith(';LAYER:'): layer = int(ln[7:]); st['layers'] += 1
        if ln.startswith(';TYPE:'): t = ln[6:]; st['types'][t] += 1
        if layer < 0 and not ln.startswith(';LAYER'): continue
        c = ln.split(';')[0].strip()
        if re.match(r'M10[49]|M1[49]0', c): st['temps'].append((layer, c))
        if re.match(r'M10[67]', c): st['fans'].append((layer, c))
        m = re.search(r'F([0-9.]+)', c)
        if m: lastF = m.group(1)
        if c.startswith('G1') and 'X' in c and lastF: st['F'][t][lastF] += 1
        m = re.match(r'G1 F([0-9.]+) E(-?[0-9.]+)$', c)
        if m: st['retracts'][m.group(1)] += 1
    return st
a, b = load(sys.argv[1]), load(sys.argv[2])
sa, sb = stats(a), stats(b)
print('layers', sa['layers'], sb['layers'])
print('types A', dict(sa['types'])); print('types B', dict(sb['types']))
print('temps A', sa['temps'][:8], '...', sa['temps'][-4:]); print('temps B', sb['temps'][:8], '...', sb['temps'][-4:])
print('fans A', sa['fans'][:6]); print('fans B', sb['fans'][:6])
print('retract/prime feed A', dict(sa['retracts'])); print('retract/prime feed B', dict(sb['retracts']))
for t in sorted(set(sa['F']) | set(sb['F'])):
    print(f"F {t:14} A", sa['F'][t].most_common(4), "\n  " + " " * 14 + " B", sb['F'][t].most_common(4))
# start and end blocks
def block(lines, a0, a1):
    i = next(k for k, l in enumerate(lines) if l.startswith(a0)); j = next(k for k in range(i, len(lines)) if lines[k].startswith(a1)); return lines[i:j+1]
for name, lines in (('A', a), ('B', b)): pass
sa_start, sb_start = block(a, 'M82 ;abs', ';LAYER:0'), block(b, 'M82 ;abs', ';LAYER:0')
print('start block identical (from M82 to ;LAYER:0, ignoring LAYER_COUNT):', [l for l in sa_start if not l.startswith(';LAYER_COUNT')] == [l for l in sb_start if not l.startswith(';LAYER_COUNT')])
ea = a[next(k for k in range(len(a)-1, 0, -1) if a[k].startswith(';TIME_ELAPSED')) + 2:]
eb = b[next(k for k in range(len(b)-1, 0, -1) if b[k].startswith(';TIME_ELAPSED')) + 2:]
eb_nosettings = [l for l in eb if not l.startswith(';SETTING_3')]
print('end block identical (after final retract):', ea == eb_nosettings)
if ea != eb_nosettings:
    import difflib; print('\n'.join(difflib.unified_diff(ea, eb_nosettings, lineterm='', n=0)))

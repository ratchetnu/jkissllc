#!/usr/bin/env python3
# prep.py <src.md> <keep_jkiss 0|1> <out.md>
# Strips the <!--JKISS-ONLY-...--> block when keep=0, then renumbers "# N Title" headings 1..N.
import sys, re
src, keep, out = sys.argv[1], sys.argv[2] == '1', sys.argv[3]
text = open(src, encoding='utf-8').read()
if not keep:
    text = re.sub(r'<!--JKISS-ONLY-START-->.*?<!--JKISS-ONLY-END-->\n?', '', text, flags=re.S)
lines, c = text.split('\n'), 0
for i, ln in enumerate(lines):
    m = re.match(r'^# (\d+) (.*)$', ln)
    if m:
        c += 1
        lines[i] = f'# {c} {m.group(2)}'
open(out, 'w', encoding='utf-8').write('\n'.join(lines))
print(f'wrote {out} (jkiss={keep})')

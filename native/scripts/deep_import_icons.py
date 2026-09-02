"""Import Feather directly instead of through @expo/vector-icons' barrel.

The package main is build/IconsLazy.js, and despite the name its requires are
top-level and eager - lines 121-135 pull in AntDesign, Entypo, EvilIcons,
Fontisto, FontAwesome (x3 variants), Foundation, Ionicons, MaterialIcons,
MaterialCommunityIcons, Octicons, SimpleLineIcons, Zocial and the rest. So one
`import { Feather } from '@expo/vector-icons'` drags every family's font and
glyphmap into the bundle.

This app uses exactly one family. Measured in node_modules: the fonts total
4.0 MB and Feather.ttf is 56 KB.

The deep path resolves because the package declares no "exports" map and ships
Feather.js at its root re-exporting build/Feather.

  cd native && python3 scripts/deep_import_icons.py
"""
import pathlib
import sys

SRC = pathlib.Path('src')
SUBS = [
    # The type-only form must stay type-only: content.ts does
    # `keyof typeof Feather.glyphMap`, and making it a value import would give a
    # UI-free lib file a runtime dependency on the icon set.
    ("import type { Feather } from '@expo/vector-icons';",
     "import type Feather from '@expo/vector-icons/Feather';"),
    ("import { Feather } from '@expo/vector-icons';",
     "import Feather from '@expo/vector-icons/Feather';"),
]

if not SRC.is_dir():
    sys.exit('run from native/')

changed = 0
for p in sorted(SRC.rglob('*')):
    if p.suffix not in ('.ts', '.tsx') or not p.is_file():
        continue
    s = p.read_text(encoding='utf-8')
    before = s
    for old, new in SUBS:
        s = s.replace(old, new)
    if s != before:
        p.write_text(s, encoding='utf-8', newline='\n')
        changed += 1

print(f'rewrote {changed} file(s)')

# Nothing may still reach the barrel, or the eager requires come back and the
# whole change is undone by a single import.
left = []
for p in SRC.rglob('*'):
    if p.suffix in ('.ts', '.tsx') and p.is_file():
        for i, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
            if "'@expo/vector-icons'" in line:
                left.append(f'{p}:{i}: {line.strip()}')
print(f'remaining barrel imports: {len(left)}')
for line in left:
    print('  ', line)
sys.exit(1 if left else 0)

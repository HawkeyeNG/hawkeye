"""Drop the four ML Kit script models Hawkeye never uses, then patch-package it.

WHY. @react-native-ml-kit/text-recognition links FIVE GoogleMLKit recognisers on
iOS - Latin, Chinese, Devanagari, Japanese and Korean - and each carries its own
on-device model. Hawkeye reads Nigerian EC8A result sheets, which are Latin, and
src/lib/ocr.ts calls recognize(uri) with no script argument, so the module's own
branch takes the Latin path every time. The other four are dead weight in a
binary that low-bandwidth users have to download.

The podspec alone is not enough: ios/TextRecognition.m @imports all five modules
and branches on the script name, so dropping the pods without touching the source
breaks compilation. Both are edited here, and the removed scripts now return the
module's existing "Unsupported script" rejection rather than silently doing
something else.

  cd native && python3 scripts/trim_mlkit_scripts.py && npx patch-package @react-native-ml-kit/text-recognition

Re-run after any reinstall that regenerates node_modules WITHOUT applying
patches; normally postinstall applies patches/ for you.
"""
import pathlib
import sys

PKG = pathlib.Path('node_modules/@react-native-ml-kit/text-recognition')
DROP = ['Chinese', 'Devanagari', 'Japanese', 'Korean']

if not PKG.exists():
    sys.exit('run this from the native/ directory (node_modules not found)')

# ---- 1. the podspec ------------------------------------------------------
spec = next(PKG.glob('*.podspec'))
s = spec.read_text(encoding='utf-8')
before = s
for name in DROP:
    s = s.replace(f"  # To recognize {name} script\n"
                  f"  s.dependency 'GoogleMLKit/TextRecognition{name}', '8.0.0'\n", '')
if s == before:
    print('podspec: already trimmed (or its wording changed - CHECK IT)')
else:
    spec.write_text(s, encoding='utf-8')
    print(f'podspec: dropped {len(DROP)} script pods')
remaining = [ln.strip() for ln in s.splitlines() if 'GoogleMLKit' in ln]
print('  remaining GoogleMLKit deps:', remaining)

# ---- 2. the Objective-C source -------------------------------------------
m = PKG / 'ios/TextRecognition.m'
t = m.read_text(encoding='utf-8')
before = t
for name in DROP:
    t = t.replace(f'@import MLKitTextRecognition{name};\n', '')
    # Collapse each branch into nothing; the trailing else already rejects an
    # unknown script, so a caller asking for one now gets a clear error rather
    # than a link failure.
    t = t.replace(
        f'    }} else if ([script isEqualToString:@"{name}"]) {{\n'
        f'        options = [[MLK{name}TextRecognizerOptions alloc] init];\n', '')
if t == before:
    print('TextRecognition.m: already trimmed (or its wording changed - CHECK IT)')
else:
    m.write_text(t, encoding='utf-8')
    print('TextRecognition.m: dropped the imports and branches')

left = [ln.strip() for ln in t.splitlines() if 'MLKit' in ln and '@import' in ln]
print('  remaining imports:', left)

bad = [n for n in DROP if f'MLK{n}TextRecognizerOptions' in t]
if bad:
    sys.exit(f'FAILED: still references {bad} - the build would not link')
print('\nnow run:  npx patch-package @react-native-ml-kit/text-recognition')

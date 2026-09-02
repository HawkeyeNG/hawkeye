"""Write the patch-package patch for the ML Kit script trim, without npm.

patch-package normally npm-installs a pristine copy to diff against; that needs
the registry, which this link keeps failing. The original content is known
exactly - the four script blocks removed by trim_mlkit_scripts.py - so the
pristine side is reconstructed here and diffed locally instead.

The result is verified by restoring node_modules to the original and re-applying
the patch, so a patch that does not apply cannot be committed.

  cd native && python3 scripts/make_mlkit_patch.py
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

PKGDIR = 'node_modules/@react-native-ml-kit/text-recognition'
PKG = pathlib.Path(PKGDIR)
OUT = pathlib.Path('patches/@react-native-ml-kit+text-recognition+2.0.0.patch')
DROP = ['Chinese', 'Devanagari', 'Japanese', 'Korean']
SPEC = 'RNMLKitTextRecognition.podspec'
SRC = 'ios/TextRecognition.m'


def original_podspec(trimmed: str) -> str:
    """Put the four dependency lines back, in their original order."""
    anchor = "  s.dependency 'GoogleMLKit/TextRecognition', '8.0.0'\n"
    if anchor not in trimmed:
        sys.exit('podspec no longer contains the Latin dependency - aborting')
    block = anchor + ''.join(
        f"  # To recognize {n} script\n  s.dependency 'GoogleMLKit/TextRecognition{n}', '8.0.0'\n"
        for n in DROP)
    return trimmed.replace(anchor, block, 1)


def original_source(trimmed: str) -> str:
    """Put the four @imports and the four branches back."""
    imp = '@import MLKitTextRecognitionCommon;\n'
    if imp not in trimmed:
        sys.exit('source no longer contains the Common import - aborting')
    t = trimmed.replace(
        imp, imp + ''.join(f'@import MLKitTextRecognition{n};\n' for n in DROP), 1)

    tail = '    } else {\n        return reject(@"Text Recognition", @"Unsupported script", nil);\n'
    if tail not in t:
        sys.exit('source no longer contains the reject branch - aborting')
    branches = ''.join(
        f'    }} else if ([script isEqualToString:@"{n}"]) {{\n'
        f'        options = [[MLK{n}TextRecognizerOptions alloc] init];\n' for n in DROP)
    return t.replace(tail, branches + tail, 1)


if not PKG.exists():
    sys.exit('run from native/ (node_modules not found)')

cur_spec = (PKG / SPEC).read_text(encoding='utf-8')
cur_src = (PKG / SRC).read_text(encoding='utf-8')
if any(f"TextRecognition{n}'" in cur_spec for n in DROP):
    sys.exit('the podspec is NOT trimmed - run trim_mlkit_scripts.py first')

tmp = pathlib.Path(tempfile.mkdtemp())
old, new = tmp / 'old' / PKGDIR, tmp / 'new' / PKGDIR
for d in (old, new):
    (d / 'ios').mkdir(parents=True)
(old / SPEC).write_text(original_podspec(cur_spec), encoding='utf-8')
(old / SRC).write_text(original_source(cur_src), encoding='utf-8')
(new / SPEC).write_text(cur_spec, encoding='utf-8')
(new / SRC).write_text(cur_src, encoding='utf-8')

r = subprocess.run(
    ['git', 'diff', '--no-index', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
     'old/' + PKGDIR, 'new/' + PKGDIR],
    cwd=tmp, capture_output=True, text=True)
diff = r.stdout
if not diff.strip():
    sys.exit('empty diff - nothing was trimmed?')

# patch-package expects paths rooted at node_modules/…, not old/ and new/.
diff = diff.replace(f'a/old/{PKGDIR}', f'a/{PKGDIR}').replace(f'b/new/{PKGDIR}', f'b/{PKGDIR}')
diff = diff.replace(f'old/{PKGDIR}', PKGDIR).replace(f'new/{PKGDIR}', PKGDIR)

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(diff, encoding='utf-8', newline='\n')
print(f'wrote {OUT}  ({len(diff)} bytes)')

# ---- prove it applies to the ORIGINAL package ----------------------------
shutil.copy2(old / SPEC, PKG / SPEC)
shutil.copy2(old / SRC, PKG / SRC)
print('restored node_modules to the pristine content; applying the patch...')
r = subprocess.run(['npx', 'patch-package'], capture_output=True, text=True)
print(r.stdout[-700:] or r.stderr[-700:])

after_spec = (PKG / SPEC).read_text(encoding='utf-8')
after_src = (PKG / SRC).read_text(encoding='utf-8')
ok = (after_spec == cur_spec and after_src == cur_src)
print(f'\npatch reproduces the trimmed files exactly: {ok}')
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if ok else 1)

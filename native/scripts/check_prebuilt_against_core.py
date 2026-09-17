#!/usr/bin/env python3
"""
Would this expo module's PRECOMPILED framework launch against the
ExpoModulesCore an app actually ships? Answers it BEFORE spending an EAS build.

expo-* npm packages carry their prebuilt iOS frameworks at
output/<flavor>/xcframeworks/<Product>.tar.gz (see expo-modules-autolinking/
scripts/ios/precompiled_modules.rb). Each was compiled against the core that was
current when that version was published, and nothing checks the pairing until
dyld does, at launch. check_ipa_symbols.py checks a finished .ipa; this checks a
candidate package version against the core framework taken from a shipped .ipa.

Usage: check_prebuilt_against_core.py <package.tgz> <app.ipa>
       exit 0 = every ExpoModulesCore import resolves, 1 = missing, 2 = no prebuilt found
"""
import io
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

import lief

lief.logging.disable()
CORE = '@rpath/ExpoModulesCore.framework/ExpoModulesCore'


def core_exports(ipa):
    z = zipfile.ZipFile(ipa)
    name = next(n for n in z.namelist() if n.endswith('Frameworks/ExpoModulesCore.framework/ExpoModulesCore'))
    with tempfile.TemporaryDirectory() as t:
        fat = lief.MachO.parse(z.extract(name, t))  # keep the FatBinary alive: .at(0) borrows from it
        return {s.name for s in fat.at(0).exported_symbols}


def main(tgz, ipa):
    exports = core_exports(ipa)
    pkg = tarfile.open(tgz)
    inner = [m for m in pkg.getmembers() if '/output/release/xcframeworks/' in m.name and m.name.endswith('.tar.gz')]
    if not inner:
        print(f'{Path(tgz).name}: no release prebuilt in the package (it would build from source)')
        return 2
    bad = 0
    for m in inner:
        xc = tarfile.open(fileobj=io.BytesIO(pkg.extractfile(m).read()))
        # the device slice: <P>.xcframework/ios-arm64/<P>.framework/<P>
        dev = [x for x in xc.getmembers() if '/ios-arm64/' in x.name and x.isfile()
               and Path(x.name).name + '.framework' == Path(x.name).parent.name]
        for d in dev:
            with tempfile.TemporaryDirectory() as t:
                p = Path(t) / 'bin'
                p.write_bytes(xc.extractfile(d).read())
                fat = lief.MachO.parse(str(p))  # keep alive while b is used
                b = fat.at(0)
                imports = [s.name for s in b.imported_symbols if s.library is not None and s.library.name == CORE]
                missing = [s for s in imports if s not in exports]
                print(f'{Path(tgz).name} {Path(d.name).name}: {len(imports)} ExpoModulesCore imports, {len(missing)} missing')
                for s in missing[:10]:
                    print(f'  missing {s}')
                bad += bool(missing) or not imports
    return 1 if bad else 0


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(*sys.argv[1:]))

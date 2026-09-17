#!/usr/bin/env python3
"""
Does every symbol an app's embedded frameworks import actually exist in the
framework it is bound to?

WHY. EAS builds iOS with EXPO_USE_PRECOMPILED_MODULES=true: each expo-* module
arrives as a prebuilt framework, compiled against whatever expo-modules-core
was current when THAT module version was published. Nothing links them against
the core this app ships until dyld does it at launch. So a module built against
a newer core compiles, archives, uploads and passes App Store processing, and
the app dies before its first frame with "DYLD 4 Symbol missing".

That is exactly how 1.0.3 (36) shipped to TestFlight on 2026-09-17:
expo-media-library 57.0.5 imports ExpoModulesCore.BaseModule.willDestroy(),
added in expo-modules-core 57.0.9, and the app ships 57.0.7.

This runs on the built .ipa, the only place the mismatch exists. It checks
imports bound to frameworks embedded in the app; system libraries and weak
imports (which dyld allows to be missing) are skipped.

Usage: check_ipa_symbols.py <app.ipa>     exit 0 = clean, 1 = missing symbols
Needs lief (pip install lief).
"""
import sys
import tempfile
import zipfile
from pathlib import PurePosixPath

import lief

lief.logging.disable()


def main(ipa):
    z = zipfile.ZipFile(ipa)
    app = next(PurePosixPath(n).parts[1] for n in z.namelist() if n.startswith('Payload/') and n.count('/') >= 2 and PurePosixPath(n).parts[1].endswith('.app'))
    root = f'Payload/{app}/'
    main_bin = root + app[:-4]
    fw_bins = [n for n in z.namelist()
               if n.startswith(root + 'Frameworks/') and '.framework/' in n
               and PurePosixPath(n).name == PurePosixPath(n).parent.name[:-len('.framework')]]

    with tempfile.TemporaryDirectory() as tmp:
        parsed, fats = {}, []
        for n in [main_bin] + fw_bins:
            p = z.extract(n, tmp)
            fat = lief.MachO.parse(p)
            fats.append(fat)  # keep every FatBinary alive: .at(0) borrows from it
            parsed[n] = fat.at(0) if fat is not None else None

        # install name ("@rpath/X.framework/X") -> exported symbol names
        exports = {}
        for n in fw_bins:
            b = parsed[n]
            ids = [c for c in b.commands if c.command == lief.MachO.LoadCommand.TYPE.ID_DYLIB] if b is not None else []
            if ids:
                exports[ids[0].name] = {s.name for s in b.exported_symbols}

        missing, checked = [], 0
        for n, b in parsed.items():
            if b is None:
                print(f'  could not parse {n}')
                missing.append((n, '<unparsed>', ''))
                continue
            for s in b.imported_symbols:
                lib = s.library.name if s.library is not None else None
                if lib not in exports:
                    continue  # system library, or not bound to an embedded framework
                checked += 1
                bi = s.binding_info if s.has_binding_info else None
                weak = bool(bi is not None and (getattr(bi, 'weak_import', False) or getattr(bi, 'is_weak_import', False)))
                if s.name not in exports[lib] and not weak:
                    missing.append((PurePosixPath(n).name, s.name, PurePosixPath(lib).name))

    print(f'{app}: {len(fw_bins)} frameworks, {checked} cross-framework imports checked')
    if not checked:
        print('FAIL: checked nothing - the reader found no imports, so this proves nothing')
        return 1
    if missing:
        print(f'FAIL: {len(missing)} imported symbol(s) missing - the app will crash at launch')
        for who, sym, lib in missing[:40]:
            print(f'  {who} needs {sym}  (from {lib})')
        return 1
    print('OK: every cross-framework import resolves')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))

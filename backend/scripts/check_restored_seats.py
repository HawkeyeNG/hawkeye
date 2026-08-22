"""Re-run the restored-constituency check against the files that actually hold
the 993 named state constituencies — races.ts in native, and whatever the web
uses — plus a CONTROL so a broken test cannot masquerade as a finding."""
import io, re, glob

RESTORED = {
    "Benue": ["Nyamatsor", "Ukum Afia", "Konshisha III", "Makurdi III", "Gboko III"],
    "Delta": ["Aniocha North II", "Ika North East II", "Sapele II", "Ethiope West II",
              "Warri South West II", "Warri North II", "Abraka", "Isoko North II", "Ughelli South II"],
    "Jigawa": ["Aujara"],
    "Kogi": ["Adavi East", "Eika", "Ajaokuta North", "Bassa-Komu", "Dekina Town & District",
             "Ijumu II", "Kabba-Bunu II", "Koton Karfe II", "Igalaogwa", "Ogugu", "Yagba West II"],
}

# Seats we KNOW exist. If these are not found, the test is broken, not the data.
CONTROL = ["Ughelli North", "Warri South", "Aniocha North", "Ika North East",
           "Sapele", "Ethiope West", "Isoko North", "Ijumu", "Yagba West"]

paths = ["/home/elrio/hawkeye/native/src/lib/races.ts"]
paths += [p for p in glob.glob("/home/elrio/hawkeye/app/*.js") + glob.glob("/home/elrio/hawkeye/app/*.json")]

blobs = []
for p in paths:
    try:
        t = io.open(p, encoding="utf-8", errors="ignore").read()
        if "Ughelli" in t or "Aniocha" in t:
            blobs.append((p, t.lower()))
    except Exception:
        pass

print("searched", len(blobs), "file(s) that actually contain state-constituency names:")
for p, _ in blobs:
    print("   ", p.replace("/home/elrio/hawkeye/", ""))
print()

def norm(s):
    s = re.sub(r"\(.*?\)", " ", s.lower())
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def found(name):
    n = norm(name)
    return any(n in b for _, b in blobs)

ctrl_missing = [c for c in CONTROL if not found(c)]
print(f"CONTROL — {len(CONTROL) - len(ctrl_missing)}/{len(CONTROL)} known seats found")
if ctrl_missing:
    print("  TEST IS UNRELIABLE, these known seats were not found:", ctrl_missing)
    print("  Treat the result below as inconclusive.")
print()

missing, present = [], []
for state, seats in RESTORED.items():
    for seat in seats:
        (present if found(seat) else missing).append(f"{state}: {seat}")

total = len(present) + len(missing)
print(f"RESTORED SEATS PRESENT : {len(present)}/{total}")
for x in present:
    print("   ", x)
print(f"\nRESTORED SEATS MISSING : {len(missing)}/{total}")
for x in missing:
    print("   ", x)

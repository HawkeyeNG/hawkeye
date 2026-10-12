#!/usr/bin/env python3
"""Which wards make up each state constituency in the LGAs INEC split in 2026.

The register names a unit's LGA and ward but not its state constituency, so an
LGA that elects two or three members could only be shown whole. INEC's table
"Restored Constituencies in Kogi, Jigawa, Benue and Delta States" (17 June
2026) lists, for each such LGA, every constituency with its registration areas
(wards) and its number of polling units. This script ties those ward names to
the register's and writes scripts/data/sha_ward_composition_2026.json.

NOTHING IS TAKEN ON TRUST. An LGA is written only when
  - every register ward of the LGA lands in exactly one of its constituencies, and
  - each constituency's polling units, counted in the register, equal INEC's figure.
An LGA that fails either test is reported and left out, and keeps its whole-LGA
figures. INEC's lists are sometimes cut short or repeat a ward; the unit counts
decide those cases, and only when exactly one reading fits.

    python3 scripts/build_sha_ward_composition.py            # report only
    python3 scripts/build_sha_ward_composition.py --write
"""
import difflib
import itertools
import json
import os
import re
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "backend", "storage", "hawkeye.db")
OUT = os.path.join(ROOT, "scripts", "data", "sha_ward_composition_2026.json")

SOURCE = {
    "title": "Restored Constituencies in Kogi, Jigawa, Benue and Delta States",
    "publisher": "INEC",
    "created": "2026-06-17",
    "url": "https://inecnigeria.org/wp-content/uploads/Restored-Constituencies-in-Kogi-Jigawa-Benue-and-Delta-States.pdf",
    "archived": "https://web.archive.org/web/20260815130345/https://inecnigeria.org/wp-content/uploads/Restored-Constituencies-in-Kogi-Jigawa-Benue-and-Delta-States.pdf",
    "sha256": "e38e71c7e4203a2a31b512e50092035e183990c33a6888cc664fbbdbc0adb667",
    "note": "Ward names are the register's spellings. INEC's table covers the 10 June 2026 "
            "restorations except Gboko and the two Warri LGAs; the 14 August ones are not in it.",
}

# (state, register LGA) -> [(seat as Hawkeye names it, INEC's label in the table, INEC's wards, INEC's units)]
TABLE = {
    ("Kogi", "Adavi"): [
        ("Adavi", "ADAVI WEST (Old and renamed)", "OGAMINANA, IRUVUCHEBA, ADAVI EBA, INOZIOMI/OSISI/IPAKU, IDANUHUA, OKUNCHI/OZURI/ONIEKA, EGE/IRUVOCHINOMI", 114),
        ("Adavi East", "ADAVI EAST (New)", "NAGAZI FARM CENTRE, IKARAWORO/IDOBANYERE, KUROKO I, KUROKO II", 103)],
    ("Kogi", "Ajaokuta"): [
        ("Ajaokuta", "AJAOKUTA", "EBIYA NORTH, EBIYA SOUTH, ICHUWA/UPAJA, ABODI/PATESI, BADOKO, OGIGIRI, ADOGO", 38),
        ("Ajaokuta North", "AJAOKUTA NORTH (New)", "ODONU/UNOSI, ACHAGANA, UNOSI/OMGBO, GEREGU/GANAJA TOWNSHIP, ADOGU/APAMIRA/OGODO/UHU OVENE, OBANGEDE/OHUWENE/OKULOINYERE, OLD AJAOKUTA", 108)],
    ("Kogi", "Okehi"): [
        ("Eika", "EIKA (New)", "EIKA/OHIZENYI, OKAITO/USUNGWE, OHUEPE/OMAVI UBORO, OBANGEDE/UHUODO", 71),
        ("Okehi", "IHIMA (Old and renamed)", "OBEIBA I, OBEIBA II, IKUEHI, OHUETA, OBOROKE EBA, OBOROKE UVETE I, OBOROKE UVETE II", 117)],
    ("Kogi", "Bassa"): [
        ("Bassa", "BASSA NGE/IGBIRRA", "GBOLOKO, KPATA, EFORO, OZUGBE, MOZUM", 55),
        ("Bassa-Komu", "BASSA KOMU (New)", "IKENDE, AKUBA I, AKUBA II, AYEDE/AKAKANA, OZONGULO/KPANCHE", 75)],
    ("Kogi", "Dekina"): [
        ("Dekina/Biraidu", "DEKINA/BIRAIDU", "ABOCHO, OGBABEDE, EMEWE", 99),
        ("Okura", "OKURA", "AYINGBA, EGUME, OJIKPADALA, OKURA", 138),
        ("Dekina Town & District", "DEKINA TOWN (New)", "DEKINA, ODU I, ODU II, IYALE, OGANE-INUGU", 115)],
    ("Kogi", "Olamaboro"): [
        ("Olamaboro I", "OLAMABORO", "IMANE I, IMANE II, OLAMABORO I, OLAMABORO II, OLAMABORO III", 99),
        ("Ogugu", "OGUGU (New)", "OGUGU I, OGUGU II, OGUGU III, OLAMABORO IV, OLAMABORO V", 75)],
    ("Kogi", "Ofu"): [
        ("Ofu", "OFU", "ITOBE/OKONKENYI, UGWOLAWO 1, UGWOLAWO 2, ALOJI, OFOKE, OCHADAMU", 112),
        ("Igalaogwa", "IGALA OGWA (New)", "IGO, ALLOMA, EJULE/ALLA, OGBONICHA, IBOKOEFAKWU", 72)],
    ("Kogi", "Ijumu"): [
        ("Ijumu", "IJUMU I (GBEDE)", "AIYETORO I, AIYETORO II, AYEGUNLE, IYAH/AYEH, ODOKORO", 46),
        ("Ijumu Arin", "IJUMU-ARIN II (New)", "IYARA, IFFE/IKOYI/OKE-IJUMU, EKINRIN ADE, IYAMOYE, IBGOOLAYERE/ILAERE, AIYERE/ARIMAH, ILETEJU/ORIGA, EGBEDA EGGA/OKEDAYO, OGIDI, OGALE/ADUGE", 75)],
    ("Kogi", "Kabba/Bunu"): [
        ("Kabba/Bunu", "KABBA/ BUNU I", "OTU, EGBEDA, OKEDAYO, ASUTA, ODO AKETE, OKEKOKO, ODOLU, AIYEWA, AIYEJEJU", 93),
        ("Kabba-Bunu II", "KABBA/ BUNU II (New)", "ILUKE, AKUTUPAKIRI, AIYETORO KIRI, ODO-APE, OLLE/OKE-OFIN, OKEBUKUN", 63)],
    ("Kogi", "Kogi . K. K."): [
        ("Kogi (K.K)", "KOTON KARFE I", "UKWO-KOTON KARFE, ODAK-KOTON KARFE, KOTON KARFE SOUTH EAST, IRENODU, AKPASU, TAWARI", 62),
        ("Koton Karfe II", "KOTON KARFE II (New)", "GIRINYA, GEGU-BEKI NORTH, GEGU BEKI SOUTH, CHIKARA NORTH, CHIKARA SOUTH", 43)],
    ("Jigawa", "Jahun"): [
        ("Aujara", "AUJARA", "GUNKA, KALE, KANWA, AUJARA, HARBO TSOHUWA, HARBO SABUWA", 123),
        ("Jahun", "JAHUN", "JAHUN, JABARNA, IDANDUNA", 109)],
    ("Benue", "Ukum"): [
        ("Ukum II", "UKUM II (AFIA)", "ATERAYANGE, AZENDESHI, MBAYENGE, ITYULUV, LUMBUV, MBAZUN, TSAAV", 156),
        ("Ukum I (Ngenev)", "UKUM I (New)", "BORIKYO, MBATIAN, UGBAAM, UYAM, KENDEV, KUNDAV", 116)],
    ("Benue", "Konshisha"): [
        ("Konshisha I (Gaav)", "KONSHISHA (GAAV)", "TSE-AGBERAGBA, MBATSEN, MBAVAA, MBAWAR, MBANOR, MBAYEGH/MBAIKYER, MBAKE", 160),
        ("Konshisha III (Shangev-Tiev)", "KONSHISHA (SHANGEV -TIEV) - New", "IKYURAV/MBATWER, MBAIKYASE, MBAIWARNYAM, MBAGUSA/MBATSER", 94)],
    ("Benue", "Makurdi"): [
        ("Makurdi I (North)", "MAKURDI I (NORTH)", "AGAN, MBALAGH, NORTH BANK I, NORTH BANK II", 137),
        ("Makurdi South", "MARKURDI II (SOUTH)", "MODERN MARKET, BAR, ANKPA/WADATA", 144),
        ("Makurdi III (South East)", "MARKURDI III (SOUTH EAST)", "CENTRAL/SOUTH MISSION, CLERKS/MARKET, FIIDI, WAILOMAYO", 281)],
    ("Benue", "Buruku"): [
        ("Nyamatsor (Buruku)", "NYAMATSOR (New)", "MBAKYAAN, MBAYAKA, MBAAKURA, MBATYOUGH, MABAADE, MBAAZAGEE, ETULO, SHOROV", 132),
        ("Buruku", "TOMBO", "MBAIKYONGO, MBAATIRKYAA, BINEV, MBAAPEN, MBAYA", 108)],
    ("Delta", "Ika North- East"): [
        ("Ika North East", "IKA NORTH EAST I", "OWA I, OWA II, OWA III, OWA IV, OWA V, OWA VI, UTE-OKPU, IDUMUESAH, UTE-OGBEJE, OTOLOKPO", 162),
        ("Ika North East II", "IKA NORTH EAST II (New)", "AKUMAZI, IGBODO, UMUNEDE, MBIRI", 76)],
    ("Delta", "Aniocha North"): [
        ("Aniocha North", "ANIOCHA I", "OBIOR, ONICHA UGBO, OBOMKPA, ONICHA-OLONA, ISSELE-AZAGBA, ISSELE UKU I, ISSELE UKU II", 68),
        ("Aniocha North II", "ANIOCHA II (New)", "OBOMKPA, IDUMUJE-UNOR, UKWU-NZU", 29)],
    ("Delta", "Sapele"): [
        ("Sapele", "SAPELE I", "SAPELE URBAN I, SAPELE URBAN II, SAPELE URBAN III, SAPELE URBAN IV, SAPELE URBAN V, SAPELE URBAN VI, SAPELE URBAN VII, SAPELE URBAN VIII", 174),
        ("Sapele II", "SAPELE II (New)", "AMUKPE, ELEME, OKOKPORO/UGBORHEN", 94)],
    ("Delta", "Ethiope West"): [
        ("Ethiope West", "ETHIOPE WEST I", "OGHARA I, OGHARA II, OGHARA III, OGHARA IV, OGHARA V", 117),
        ("Ethiope West II", "ETHIOPE WEST II (New)", "MOSOGAR I, MOSOGAR II, JESSE I, JESSE II, JESSE III, JESSE IV", 103)],
}

ROMAN = {"1": "I", "2": "II", "3": "III", "4": "IV", "5": "V", "6": "VI", "7": "VII", "8": "VIII"}


def key(s):
    """Letters and digits only, upper case, with a trailing digit read as a numeral."""
    s = re.sub(r"\b([1-8])\b", lambda m: ROMAN[m.group(1)], s.upper())
    return re.sub(r"[^A-Z0-9]", "", s)


def solve(state, lga, seats, wards):
    """wards: {register ward: units}. Returns (assignment or None, notes)."""
    notes, claims = [], {w: [] for w in wards}
    by_key = {key(w): w for w in wards}
    for seat, _label, names, _n in seats:
        for name in [x.strip() for x in names.split(",") if x.strip()]:
            w = by_key.get(key(name))
            if not w:
                best = sorted(((difflib.SequenceMatcher(None, key(name), k).ratio(), k) for k in by_key), reverse=True)
                if best and best[0][0] >= 0.72 and (len(best) == 1 or best[0][0] - best[1][0] >= 0.08):
                    w = by_key[best[0][1]]
                    notes.append(f"'{name}' read as register ward '{w}' ({best[0][0]:.2f})")
            if not w:
                notes.append(f"'{name}' ({seat}) matches no register ward")
                continue
            if seat not in claims[w]:
                claims[w].append(seat)
    want = {seat: n for seat, _l, _names, n in seats}
    fixed = {w: c[0] for w, c in claims.items() if len(c) == 1}
    open_wards = [(w, c if c else list(want)) for w, c in claims.items() if len(c) != 1]
    fits = []
    for choice in itertools.product(*[c for _w, c in open_wards]) if len(open_wards) <= 8 else []:
        got = dict(fixed, **{w: s for (w, _c), s in zip(open_wards, choice)})
        total = {s: 0 for s in want}
        for w, s in got.items():
            total[s] += wards[w]
        if total == want:
            fits.append(got)
    if not open_wards:
        total = {s: 0 for s in want}
        for w, s in fixed.items():
            total[s] += wards[w]
        fits = [fixed] if total == want else []
        if not fits:
            notes.append(f"unit counts differ: register {total}, INEC {want}")
    elif len(fits) == 1:
        for (w, c) in open_wards:
            notes.append(f"ward '{w}' ({'listed twice' if c != list(want) else 'not listed'}) placed in {fits[0][w]} by the unit counts")
    else:
        notes.append(f"{len(fits)} readings fit the unit counts for {[w for w, _c in open_wards]}: left whole")
    return (fits[0] if len(fits) == 1 else None), notes


def main():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    out, report, ok = {}, [], 0
    for (state, lga), seats in TABLE.items():
        rows = db.execute("SELECT ward, COUNT(*), MIN(pu_code) FROM polling_units WHERE state = ? AND lga = ? GROUP BY ward", (state, lga)).fetchall()
        wards = {w: n for w, n, _c in rows}
        codes = {w: "-".join(str(c).split("-")[:3]) for w, _n, c in rows}
        if not wards:
            report.append(f"SKIP {state} / {lga}: the register has no such LGA")
            continue
        got, notes = solve(state, lga, seats, wards)
        head = f"{'ok  ' if got else 'SKIP'} {state} / {lga}: " + ", ".join(f"{s} {n}" for s, _l, _w, n in seats)
        report.append(head)
        report += [f"       {n}" for n in notes]
        if not got:
            continue
        ok += 1
        out[f"{state}|{lga}"] = {
            seat: {"inecLabel": label,
                   "wards": sorted(w for w, s in got.items() if s == seat),
                   "wardCodes": sorted(codes[w] for w, s in got.items() if s == seat),
                   "pollingUnits": n}
            for seat, label, _names, n in seats}
    print("\n".join(report))
    print(f"{ok} of {len(TABLE)} LGAs verified; {sum(len(v) for v in out.values())} constituencies")
    if "--write" in sys.argv:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf8") as f:
            json.dump({"_source": SOURCE, "lgas": out}, f, indent=1, ensure_ascii=False)
            f.write("\n")
        print(f"wrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()

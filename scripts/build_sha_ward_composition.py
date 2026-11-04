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

THE THREE WARRI LGAs COME FROM A SECOND DOCUMENT, WITH NO UNIT COUNTS. INEC's
"Composition of New State Constituencies and Registration Areas in Warri
Federal Constituency" (also 17 June 2026) lists each seat's registration areas
and nothing else, and the register only carried the new Warri wards from 4 Nov
2026 (backend register update delta-2026-11). With no count to settle a doubt,
the test is stricter on names instead: every ward INEC lists must match exactly
one register ward (key, difflib, or an ALIAS written out below with its
reason), every register ward must land in exactly one seat, each seat must get
as many wards as INEC lists, and at most ONE ward may be placed by elimination
(the one unmatched name and the one unclaimed ward), which the notes and the
output both record. Unit counts for these seats are the register's own.

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

WARRI_SOURCE = {
    "title": "Composition of New State Constituencies and Registration Areas in Warri Federal Constituency of Delta State",
    "publisher": "INEC",
    "created": "2026-06-17",
    "archived": "https://web.archive.org/web/20260815130345/https://wp1.inecnigeria.org/wp-content/uploads/Composition-of-New-State-Constituencies-and-Registration-Areas-in-Warri-Federal-Constituency-of-Delta-State.pdf",
    "sha256": "a9803d1525a23253d7c4370b3dc9ca0f75f08c0ff79334c9405b5681530e2dce",
    "note": "Registration areas only, no unit counts; matched to the register's Warri wards (INEC's public "
            "polling-unit directory, applied 4 Nov 2026) by name. The document's RA codes are not the "
            "directory's ward numbers, so codes were not compared. Unit counts are the register's.",
}
WARRI_LGAS = {("Delta", "Warri North"), ("Delta", "Warri South"), ("Delta", "Warri South West")}

# A name INEC's list spells so differently that neither the key nor difflib can join it, mapped by
# hand to the register ward it means — each with the reason, since nothing else checks it.
ALIASES = {
    # The document lists one RA "Asigborodo I/Asigborodo II"; the directory has a single ward,
    # "Asigborodo" (13 units, 10-23-13). No other Warri North ward carries the name.
    ("Delta", "Warri North", "ASIGBORODO I/ASIGBORODO II"): "Asigborodo",
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
    # From WARRI_SOURCE: registration areas as INEC lists them, no unit counts (None).
    ("Delta", "Warri North"): [
        ("Warri North", "WARRI NORTH 1", "AJA ITORI/OKOGHO, AJA OMETAN/TISUN/KOLOKOLO/SAGHARATE/UGHOTOSA, BERESIBI/UREJU/EGHORO/OBONTEGHAREDA, EBROHIMI, GBOKODA, KOKO I, KOKO II, KOKO III, OBAGHORO, OGHEYE", None),
        ("Warri North II", "WARRI NORTH 2", "ABADIGBENE/OKIFAMBA/ASANTUWAGBENE, ASIGBORODO I/ASIGBORODO II, OGBINBIRI, OGBINBIRI AZAMA/ASISABUBOTIE/IDEBAGBENE, OGBUDUGBUDU, AWAMBA, OPUAMA I, OPUAMA II, POLOBUBO I, POLOBUBO II", None)],
    ("Delta", "Warri South"): [
        ("Warri South I", "WARRI SOUTH I", "BOWEN, ERUOGWARAN OTOVWODO/OMOINE, EKPEN/ESISI, GRA 1, IGBUDU-ESSI, OBODO/OMADINO, ODE-ITSEKIRI, PESSU, OGEDENGBE, UGBUWANGUE/EKUREDE-ITSEKIRI", None),
        ("Warri South II", "WARRI SOUTH 2", "OKUMAGBA I, OKUMAGBA II, EDJEBA, OKERE, OGUNU/OKURODE-URHOBO/UKPOTITI/OTEGHELE, ITIFO/MARKRO, EGBORODJE, GRA 2, EWEIN, OGBE-IJOH WARRI URBAN", None)],
    ("Delta", "Warri South West"): [
        ("Warri South-West", "WARRI SOUTH WEST 1", "AZAMA/IGOBA/INIKOROOGHA, BENIKRUKRU/KOKODIAGBENE, DIEBIRI, IZANSA-IJELEJELE/IKEREMOR, ISABA, KUNUKUNUMA/KANTU/KURUTIE/PEPE-AMA, OGBE-IJOH, OKERENKOKO/EGWA, OKOROWARE, OPOROZA, OPOROZA-AMASEIKUMOR", None),
        ("Warri South West II", "WARRI SOUTH WEST 2", "AJA-DAIBOR, AKPAKPA, MANDANGHO, OGIDIGBEN I, OGIDIGBEN II, ORERE I, ORERE II, UGBORODO I, UGBORODO II", None)],
}

ROMAN = {"1": "I", "2": "II", "3": "III", "4": "IV", "5": "V", "6": "VI", "7": "VII", "8": "VIII"}


def key(s):
    """Letters and digits only, upper case, with a trailing digit read as a numeral."""
    s = re.sub(r"\b([1-8])\b", lambda m: ROMAN[m.group(1)], s.upper())
    return re.sub(r"[^A-Z0-9]", "", s)


def solve(state, lga, seats, wards):
    """wards: {register ward: units}. Returns (assignment or None, notes, wards placed by elimination)."""
    notes, claims, unmatched = [], {w: [] for w in wards}, []
    by_key = {key(w): w for w in wards}
    for seat, _label, names, _n in seats:
        for name in [x.strip() for x in names.split(",") if x.strip()]:
            w = None
            alias = ALIASES.get((state, lga, name.upper()))
            if alias:
                w = by_key.get(key(alias))
                notes.append(f"'{name}' read as register ward '{alias}' (ALIASES)" if w else f"ALIAS '{alias}' is not a register ward")
            if not w:
                w = by_key.get(key(name))
            if not w:
                best = sorted(((difflib.SequenceMatcher(None, key(name), k).ratio(), k) for k in by_key), reverse=True)
                if best and best[0][0] >= 0.72 and (len(best) == 1 or best[0][0] - best[1][0] >= 0.08):
                    w = by_key[best[0][1]]
                    notes.append(f"'{name}' read as register ward '{w}' ({best[0][0]:.2f})")
            if not w:
                notes.append(f"'{name}' ({seat}) matches no register ward")
                unmatched.append((seat, name))
                continue
            if seat not in claims[w]:
                claims[w].append(seat)
    if any(n is None for _s, _l, _names, n in seats):
        return solve_by_names(seats, claims, unmatched, notes)
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
    return (fits[0] if len(fits) == 1 else None), notes, []


def solve_by_names(seats, claims, unmatched, notes):
    """No unit counts (WARRI_SOURCE): names alone must settle every ward, one elimination at most."""
    twice = [w for w, c in claims.items() if len(c) > 1]
    if twice:
        notes.append(f"claimed by two seats: {twice}: left whole")
        return None, notes, []
    got = {w: c[0] for w, c in claims.items() if c}
    unclaimed = [w for w, c in claims.items() if not c]
    eliminated = []
    if len(unmatched) == 1 and len(unclaimed) == 1:
        seat, name = unmatched[0]
        got[unclaimed[0]] = seat
        eliminated = [unclaimed[0]]
        notes.append(f"ward '{unclaimed[0]}' placed in {seat} BY ELIMINATION: the only register ward left, "
                     f"for the only name left ('{name}')")
    elif unmatched or unclaimed:
        notes.append(f"names unmatched {[n for _s, n in unmatched]}, register wards unclaimed {unclaimed}: left whole")
        return None, notes, []
    for seat, _label, names, _n in seats:
        listed = len([x for x in names.split(",") if x.strip()])
        placed = sum(1 for s in got.values() if s == seat)
        if listed != placed:
            notes.append(f"{seat}: INEC lists {listed} wards, {placed} placed: left whole")
            return None, notes, []
    return got, notes, eliminated


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
        got, notes, eliminated = solve(state, lga, seats, wards)
        units = {seat: (n if n is not None else sum(wards[w] for w, s in (got or {}).items() if s == seat))
                 for seat, _l, _w, n in seats}
        head = f"{'ok  ' if got else 'SKIP'} {state} / {lga}: " + ", ".join(
            f"{s} {units[s]}{'' if n is not None else ' (register count; INEC gives none)'}" for s, _l, _w, n in seats)
        report.append(head)
        report += [f"       {n}" for n in notes]
        if not got:
            continue
        ok += 1
        out[f"{state}|{lga}"] = {
            seat: {"inecLabel": label,
                   "wards": sorted(w for w, s in got.items() if s == seat),
                   "wardCodes": sorted(codes[w] for w, s in got.items() if s == seat),
                   "pollingUnits": units[seat],
                   **({} if n is not None else {"source": "warri", "unitsFrom": "register"}),
                   **({"byElimination": sorted(w for w in eliminated if got[w] == seat)}
                      if any(got[w] == seat for w in eliminated) else {})}
            for seat, label, _names, n in seats}
    print("\n".join(report))
    print(f"{ok} of {len(TABLE)} LGAs verified; {sum(len(v) for v in out.values())} constituencies")
    if "--write" in sys.argv:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf8") as f:
            json.dump({"_source": SOURCE, "_sourceWarri": WARRI_SOURCE, "lgas": out}, f, indent=1, ensure_ascii=False)
            f.write("\n")
        print(f"wrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()

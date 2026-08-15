#!/usr/bin/env python3
"""Build scripts/data/constituency_aliases.json — INEC spelling -> register value.

    python3 scripts/build_constituency_aliases.py <inec-list.pdf>

Two tiers, both requiring the candidates to be in the SAME STATE:

  direct  register <-> INEC on the whole name at ratio >= 0.90.
  nass    register <-> NASS <-> INEC, each link >= 0.72 with at least one >= 0.90.
          NASS is backend/src/data/political_cache.json — 360 sitting Reps and
          109 Senators with state and district, already pulled from nass.gov.ng
          and Wikipedia. It is an INDEPENDENT third spelling of every seat, so
          two corroborating links justify accepting scores a lone match could
          not: 'Aninri/Agwu/Oji-uzo' scores only 0.75 against NASS's
          ANINRI/AWGU/OJI RIVER, but NASS then matches INEC at 1.0 — two
          sources agreeing that the register has two typos in one name.

WHY NOT TOKEN-LEVEL FUZZY MATCHING. It was tried first and thrown away. Without
geography it proposed DAMBAM->DAMBOA (Bauchi against Borno), NDONI->ANDONI,
MARTE->MATES and OPKE->OPE. Every one merges two real seats — and unlike a
parser slip, a bad alias is INVISIBLE to the duplicate-party contamination
check, because the merged result looks like one legitimate race. A missing race
is a gap; a wrongly merged one is a false claim about who stood where.

Every rejection is written to the file with its reason, so an absent alias is a
recorded decision rather than an oversight.
"""
import argparse
import difflib
import importlib.util
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("gen", os.path.join(HERE, "build_races_from_inec.py"))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

CACHE = os.path.join(ROOT, "backend", "src", "data", "political_cache.json")
OUT = os.path.join(HERE, "data", "constituency_aliases.json")

# Register rows that are typo-duplicates of another row. Both point at one seat,
# so aliasing both would fight over the same race key.
DUPLICATES = {
    "Nkokwa East/Ndokwa West/ Ukwuani": "typo duplicate of 'Ndokwa East/Ndokwa West/Ukwani'",
    "Ado/Obadigbo/Opkokwu": "typo duplicate of 'Ado/Obadigbo/Okpokwu'",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    a = ap.parse_args()

    lines, _, _ = gen.pdf_lines(a.pdf)
    sen_reg, fed_reg = gen.load_register()
    parties = {p["code"] for p in json.load(open(gen.PARTIES))}
    STATES = set(gen.STATES)

    # NASS roster, by level and state.
    cache = json.load(open(CACHE))
    nass = {"federal_constituency": {}, "senatorial": {}}
    for chamber, level in (("house", "federal_constituency"), ("senate", "senatorial")):
        for m in cache["members"][chamber]["members"]:
            st, d = gen.norm(m.get("state") or ""), (m.get("district") or "").strip()
            if st and d:
                nass[level].setdefault(st, set()).add(gen.norm(d))

    # INEC's own constituency strings, per state heading.
    by_state, cur = {}, None
    for i, l in enumerate(lines):
        n = gen.norm(l)
        if n in STATES:
            cur = n
            continue
        if not cur or n in parties or not n or re.fullmatch(r"[\d\s./]+", n):
            continue
        for w in (1, 2, 3):
            if i - w + 1 < 0:
                continue
            s = gen.norm(" ".join(lines[j].strip() for j in range(i - w + 1, i + 1)))
            if 3 < len(s) < 70:
                by_state.setdefault(cur, set()).add(s)

    # BUILD FROM SCRATCH, NOT FROM THE FILE WE ARE ABOUT TO REPLACE. gen loads
    # the existing alias table at import, so parsing with it in place makes every
    # already-aliased constituency look "seen" — the rebuild then emits only the
    # residue and silently drops the aliases it was supposed to preserve (452
    # races fell back to 427 exactly this way). Aliases off while surveying.
    gen.NAME_ALIASES = {}
    rows, _ = gen.parse(lines, list(parties), set(sen_reg), set(fed_reg))
    seen = {gen.key_of(r["constituency"] or "") for r in rows if r["constituency"]}

    accepted, rejected = {}, []
    ratio = lambda x, y: round(difflib.SequenceMatcher(None, x, y).ratio(), 3)

    for level, bag in (("senatorial", sen_reg), ("federal_constituency", fed_reg)):
        for k, e in sorted(bag.items()):
            if k in seen:
                continue
            name, st = e["label"], gen.norm(e["state"] or "")
            if name in DUPLICATES:
                rejected.append({"register": name, "reason": DUPLICATES[name]})
                continue
            target = gen.norm(name)
            ipool, npool = by_state.get(st, set()), nass[level].get(st, set())

            direct = difflib.get_close_matches(target, ipool, n=1, cutoff=0.90)
            if direct:
                accepted[gen.key_of(direct[0])] = {
                    "register": name, "level": level, "state": e["state"],
                    "inec": direct[0], "via": "direct", "ratio": ratio(target, direct[0])}
                continue

            n1 = difflib.get_close_matches(target, npool, n=1, cutoff=0.72)
            n2 = difflib.get_close_matches(n1[0], ipool, n=1, cutoff=0.72) if n1 else None
            if n1 and n2:
                r1, r2 = ratio(target, n1[0]), ratio(n1[0], n2[0])
                if max(r1, r2) >= 0.90:
                    accepted[gen.key_of(n2[0])] = {
                        "register": name, "level": level, "state": e["state"],
                        "inec": n2[0], "nass": n1[0], "via": "nass",
                        "ratio": min(r1, r2), "regNass": r1, "nassInec": r2}
                    continue
                rejected.append({"register": name, "state": e["state"], "nass": n1[0],
                                 "inec": n2[0], "regNass": r1, "nassInec": r2,
                                 "reason": "corroborated but both links weak (<0.90)"})
                continue
            rejected.append({"register": name, "state": e["state"],
                             "nass": n1[0] if n1 else None,
                             "reason": "no NASS match" if not n1 else "NASS matched but no INEC string found"})

    out = {
        "_note": "INEC constituency spelling -> the register's own value. Built by "
                 "scripts/build_constituency_aliases.py. Same-state matching only; "
                 "token-level fuzzy matching was rejected because it merged real seats "
                 "across state lines (DAMBAM->DAMBOA).",
        "_key": "order-insensitive normalised INEC name (build_races_from_inec.key_of)",
        "_tiers": {"direct": "register<->INEC whole name >= 0.90",
                   "nass": "register<->NASS<->INEC, each >= 0.72 and one >= 0.90"},
        "aliases": accepted,
        "rejected": rejected,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), indent=1, ensure_ascii=False)
    tiers = {}
    for v in accepted.values():
        tiers[v["via"]] = tiers.get(v["via"], 0) + 1
    print(f"accepted {len(accepted)} ({tiers}), rejected {len(rejected)} -> {OUT}")
    for r in rejected:
        print(f"   REJECT {r['register'][:44]:<46} {r['reason']}")


if __name__ == "__main__":
    main()

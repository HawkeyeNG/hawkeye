#!/usr/bin/env python3
"""
The ballot of every 2027 race a polling unit votes in, from INEC's final lists.

    python3 scripts/parse_inec_final_lists_2027.py tmp/inec-2027/pdf     # first
    python3 scripts/build_ballots_2027.py [--write]

A "ballot" here is the list of parties fielding a candidate in ONE race, in the
order INEC prints the rows of the result sheet (alphabetical by acronym). The
presidential race has one; governorship has one per state; Senate one per
senatorial district; House of Representatives one per federal constituency.

THE JOIN IS THE WHOLE JOB. A unit finds its ballot through the register's own
`senatorial` / `federal_constituency` value, so every INEC race has to be tied
to the register's spelling of that seat. In order, always INSIDE ONE STATE:
  1. same components, any order (key_of);
  2. the hand-reviewed alias file (scripts/data/constituency_aliases.json);
  3. same letters once spaces and punctuation are squeezed out — INEC's cells
     wrap ("Umu- Nneochi", "Ibesikpo Asutan");
  4. closest spelling, only when it is clearly closest (ratio >= 0.84 and 0.06
     clear of the runner-up) and the pairing is mutual;
  5. the last unpaired race and the last unpaired seat of a state.
Steps 4 and 5 are PRINTED for a human to read; nothing is paired across states.
A race that still has no seat is listed and left out: its units fall back to
the full register of parties, which is what every unit had before this file.

State Assembly is not here: the register does not say which state constituency
a unit is in.

Without --write this prints the report and writes nothing.
"""
import argparse
import datetime
import difflib
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_races_from_inec as B  # noqa: E402

SRC = os.path.join(B.ROOT, "tmp", "inec-2027")
OUT_BACKEND = os.path.join(B.ROOT, "backend", "src", "data", "ballots-2027.json")
OUT_APP = os.path.join(B.ROOT, "app", "ballots-2027.json")


def K(s):
    """The lookup key both sides compute: letters and digits only, upper case."""
    return re.sub(r"[^A-Z0-9]+", "", (s or "").upper())


def state_key(s):
    """The state as the CLIENTS can compute it from a unit: K(), plus the two
    spellings that differ between sources. (Not B.norm: its aliases turn
    NASARAWA into NASSARAWA, which no client would arrive at.)"""
    k = K(s)
    if k in ("FEDERALCAPITALTERRITORY", "FCTABUJA", "ABUJA"):
        return "FCT"
    return "NASARAWA" if k == "NASSARAWA" else k


def squeeze(s):
    """Order-insensitive and blind to spacing: the components, each squeezed, sorted."""
    return "/".join(sorted(K(p) for p in re.split(r"[/,]", B.norm(s)) if K(p)))


def register_seats(col):
    con = sqlite3.connect(f"file:{B.DB}?mode=ro", uri=True)
    seats = defaultdict(dict)   # state_key -> {label: units}
    q = f"SELECT state, {col}, COUNT(*) FROM polling_units WHERE {col} IS NOT NULL AND {col} <> '' GROUP BY state, {col}"
    for state, label, n in con.execute(q):
        seats[state_key(state)][label] = n
    con.close()
    return seats


def indexes(out):
    """Where a race is asked for WITHOUT a polling unit.

    BY_CODE (server): a sheet arrives with a unit code, SS-LL-WW-UUU. The
      senatorial district follows the LGA; so does the federal constituency,
      except where one LGA is split between two — then it follows the ward.
        "SS": state key   "SS-LL": [senate seat | None, reps seat | None]   "SS-LL-WW": reps seat
    LGA / WARD (clients): the collation forms choose a state, an LGA and a ward
      by NAME.   "STATE|LGA": [senate seat | None, [reps seats]]   "STATE|LGA|WARD": reps seat
    A seat is only written if it has a ballot above; anything ambiguous is left
    out, and absent means "not known" to every reader of this file."""
    con = sqlite3.connect(f"file:{B.DB}?mode=ro", uri=True)
    st_of, sen_c, rep_c, rep_w = {}, defaultdict(set), defaultdict(set), defaultdict(set)
    lga_c = defaultdict(set)
    sen_n, rep_n, rep_wn = defaultdict(set), defaultdict(set), defaultdict(set)
    for pu, state, lga, ward, sen, fed in con.execute("SELECT pu_code, state, lga, ward, senatorial, federal_constituency FROM polling_units"):
        parts = (pu or "").split("-")
        if len(parts) != 4:
            continue
        ss, ll, ww = parts[0], parts[1], parts[2]
        stk = state_key(state)
        st_of.setdefault(ss, set()).add(stk)
        nk = f"{stk}|{K(lga)}"
        lga_c[(ss, ll)].add(K(lga))
        if sen and f"{stk}|{K(sen)}" in out["SEN"]:
            sen_c[(ss, ll)].add(K(sen)); sen_n[nk].add(K(sen))
        if fed and f"{stk}|{K(fed)}" in out["REP"]:
            rep_c[(ss, ll)].add(K(fed)); rep_w[(ss, ll, ww)].add(K(fed))
            rep_n[nk].add(K(fed)); rep_wn[f"{nk}|{K(ward)}"].add(K(fed))
    con.close()
    one = lambda x: next(iter(x)) if len(x) == 1 else None  # noqa: E731
    by_code = {ss: one(v) for ss, v in sorted(st_of.items()) if one(v)}
    split = 0
    for (ss, ll) in sorted(set(sen_c) | set(rep_c) | set(lga_c)):
        # third: the LGA's own key, which is what a State Assembly ballot is filed under
        by_code[f"{ss}-{ll}"] = [one(sen_c.get((ss, ll), ())), one(rep_c.get((ss, ll), ())), one(lga_c.get((ss, ll), ()))]
        if len(rep_c.get((ss, ll), ())) > 1:
            split += 1
            for (a, b, ww), v in sorted(rep_w.items()):
                if (a, b) == (ss, ll) and one(v):
                    by_code[f"{ss}-{ll}-{ww}"] = one(v)
    lga = {k: [one(sen_n.get(k, ())), sorted(rep_n.get(k, ()))] for k in sorted(set(sen_n) | set(rep_n))}
    ward = {k: one(v) for k, v in sorted(rep_wn.items()) if one(v) and len(rep_n[k.rsplit("|", 1)[0]]) > 1}
    return by_code, lga, ward, {"lgas": len(lga), "lgas_split_between_reps_seats": split, "ward_entries": len(ward),
                                "lgas_with_two_senate_districts": sum(1 for v in sen_n.values() if len(v) > 1)}


def display(name):
    """INEC prints names in capitals; a page reads better in ordinary case. Each
    run of letters is capitalised, so hyphens and apostrophes keep their parts
    (OMO-AJE -> Omo-Aje). The ORDER is INEC's and is not touched."""
    name = re.sub(r"\s+", " ", (name or "").strip())
    return re.sub(r"[^\W\d_]+", lambda m: m.group(0)[:1].upper() + m.group(0)[1:].lower(), name)


def candidate_files(P, joined):
    """app/candidates-2027/<STATE>.json — who is standing, for the race pages.

    Keyed by the names the SEAT PAGES use (app/seat_lgas.json), not the register's:
    a page asks for its own seat. A seat page is tied to an INEC race by its own
    name first (so "Mushin II" gets Mushin II's candidates, not the union the
    ballot file has to use), then through the register join above. Name and party
    only — and the running mate for governorship; INEC's ages, qualifications and
    disability column are not republished."""
    seats = json.load(open(os.path.join(B.ROOT, "app", "seat_lgas.json")))
    files = defaultdict(lambda: {"SEN": {}, "REP": {}})
    row = lambda r: {"name": display(r["name"]), "party": r["party"]}  # noqa: E731
    for f in P("gov.json")["files"]:
        st = state_key(f["records"][0]["state"])
        files[st]["GOV"] = [{**row(r), "mate": display(r["runningMate"]["name"])} for r in sorted(f["records"], key=lambda r: r["party"])]
    unresolved, counts = [], {}
    for code in ("SEN", "REP"):
        named, paired, _folded = joined[code]
        direct, squeezed = defaultdict(dict), defaultdict(dict)
        for (st, n) in named:
            direct[st][K(n)] = n
            squeezed[st][squeeze(n)] = n
        via_label = {(st, K(label)): name for (st, label), (name, _how) in paired.items()}
        n_ok = 0
        for seat, v in seats[code].items():
            st = state_key(v["state"])
            inec = direct[st].get(K(seat)) or squeezed[st].get(squeeze(seat)) or via_label.get((st, K(seat)))
            if not inec:
                unresolved.append(f"{code} {v['state']} / {seat}")
                continue
            files[st][code][K(seat)] = [row(r) for r in sorted(named[(st, inec)], key=lambda r: r["party"])]
            n_ok += 1
        counts[code] = [n_ok, len(seats[code])]
    return files, unresolved, counts


def assembly(P):
    """State Houses of Assembly.

    The register does not say which state constituency a unit is in, only its
    LGA. So:
      - the SEAT PAGES (app/seat_lgas.json, 1,005 of them) are tied to INEC's
        races by name, for the candidate lists;
      - a unit's BALLOT is its LGA's: exact where the LGA elects one member, the
        UNION of its seats where it elects several (240 LGAs) — a superset, so a
        party on the unit's real sheet is never left out.
    INEC's list has races the seat table does not (constituencies restored in
    2026). Their LGA is not known, so their parties are added to EVERY LGA of
    their state: still a superset. A state with no list at all (Borno, missing
    from INEC's file) gets nothing, and every party stays listed there."""
    table = json.load(open(os.path.join(B.ROOT, "app", "seat_lgas.json")))["SHA"]
    named = defaultdict(list)
    for r in P("sha.json")["records"]:
        named[(state_key(r["state"]), re.sub(r"\s+", " ", r["constituency"]).strip())].append(r)
    seats, lgas_of = defaultdict(dict), {}
    for key, v in table.items():
        st, name = state_key(v["state"]), v.get("seat") or key.split("|", 1)[-1]
        seats[st][name] = v.get("pollingUnits", 0)
        lgas_of[(st, name)] = v.get("lgas", [])
    paired, _extra, unjoined, unused, review = join(named, seats, "SHA")
    row = lambda r: {"name": display(r["name"]), "party": r["party"]}  # noqa: E731
    pages = defaultdict(dict)                      # state -> {K(seat): rows}
    lga_races = defaultdict(set)                   # "STATE|LGA" -> {inec race}
    for (st, seat), (race, _how) in paired.items():
        pages[st][K(seat)] = [row(r) for r in sorted(named[(st, race)], key=lambda r: r["party"])]
        for lga in lgas_of[(st, seat)]:
            lga_races[f"{st}|{K(lga)}"].add(race)
    loose = defaultdict(set)                       # state -> parties of races with no seat page
    for st, race in unjoined:
        loose[st] |= {r["party"] for r in named[(st, race)]}
    states_with_list = {st for (st, _n) in named}
    ballots, shared = {}, []
    all_lgas = {f"{st}|{K(l)}" for (st, _seat), ls in lgas_of.items() for l in ls}
    for key in sorted(all_lgas):
        st = key.split("|", 1)[0]
        if st not in states_with_list:
            continue
        races = lga_races.get(key, set())
        codes = set(loose[st])
        for race in races:
            codes |= {r["party"] for r in named[(st, race)]}
        if not codes:
            continue
        ballots[key] = sorted(codes)
        if len(races) != 1 or loose[st]:
            shared.append(key)
    # Where INEC listed an LGA's wards per constituency (and every count checked
    # out against the register), a ward names its own race: an exact list.
    comp = json.load(open(os.path.join(B.ROOT, "scripts", "data", "sha_ward_composition_2026.json")))["lgas"]
    shaw, shaw_code = {}, {}
    for lk, seats_c in sorted(comp.items()):
        state, lga = lk.split("|", 1)
        st = state_key(state)
        if any((st, seat) not in paired for seat in seats_c):
            print(f"  [SHA] ward composition for {lk} skipped: a seat there has no INEC race")
            continue
        for seat, v in seats_c.items():
            codes = sorted({r["party"] for r in named[(st, paired[(st, seat)][0])]})
            for w in v["wards"]:
                shaw[f"{st}|{K(lga)}|{K(w)}"] = codes
            for c in v["wardCodes"]:
                shaw_code[c] = codes
    stats = {"wards_with_their_own_ballot": len(shaw), "inec_races": len(named), "seat_pages": sum(len(v) for v in seats.values()), "pages_with_candidates": len(paired),
             "inec_races_without_a_page": [f"{a} / {b}" for a, b in unjoined], "pages_without_a_race": [f"{a} / {b}" for a, b, _u in unused],
             "lgas_with_a_ballot": len(ballots), "of_which_exact": len(ballots) - len(shared), "of_which_union": len(shared)}
    return pages, ballots, sorted(shared), stats, review, shaw, shaw_code


def tokens(s):
    return frozenset(t for t in re.split(r"[^A-Z0-9]+", B.norm(s)) if t)


# Register labels no rule above can tie to their race, paired BY HAND after
# reading both. (state key, register label) -> INEC's name for the race.
HAND_LABELS = {
    # Lokoja LGA's units carry this label; the seat is Lokoja + Kogi (Koton-Karfe) LGAs.
    ("KOGI", "Lokoja/Koton Karfe/Kogi"): "Kogi (Lokoja)/Kogi (K.K.)",
    # State Assembly: the same seat, named the other way round.
    ("BENUE", "Konshisha III (Shangev-Tiev)"): "SHANGEV - TIEV (KONSHISHA)",
    # Restored in 2026. (Nyamatsor (Buruku), Ukum II and Ijumu Arin already carry
    # the final list's names on their seat pages.)
    ("KOGI", "Dekina Town & District"): "DEKINA TOWN",
}

NUMERAL = re.compile(r"\s+(I{1,3}|IV|V)$")


def join(races, seats, level):
    """races: {(state_key, inec_name): [...]} -> (label_of, extra, unjoined, unused, review)
       label_of: {(state_key, register_label): (inec_name, how)}
       extra:    {(state_key, register_label): [inec_name, ...]} — sibling seats folded in (see step 6)."""
    label_of, extra, review = {}, defaultdict(list), []
    by_state = defaultdict(list)
    for (st, name) in races:
        by_state[st].append(name)
    unjoined, unused = [], []
    ratio = lambda x, y: difflib.SequenceMatcher(None, squeeze(x), squeeze(y)).ratio()  # noqa: E731
    for st, names in sorted(by_state.items()):
        free = dict(seats.get(st, {}))            # register label -> units, still unpaired
        got = defaultdict(list)                   # inec name -> labels

        def take(name, label, how):
            label_of[(st, label)] = (name, how)
            got[name].append(label)
            free.pop(label, None)

        # 1-3 (+ same words in any grouping). The register spells some seats two
        # ways ("Jemaa/Sanga", "Jema'A/Sanga"), so a race takes EVERY label that matches.
        tests = (
            ("key", lambda n, l: B.key_of(l) == B.key_of(n)),
            ("alias", lambda n, l: bool(B.NAME_ALIASES.get(B.key_of(n))) and B.key_of(l) == B.key_of(B.NAME_ALIASES[B.key_of(n)])),
            ("squeeze", lambda n, l: squeeze(l) == squeeze(n)),
            ("words", lambda n, l: tokens(l) == tokens(n)),
        )
        for how, same in tests:
            for name in names:
                for label in [l for l in free if same(name, l)]:
                    take(name, label, how)
        # 4. clearly-closest spelling, mutual, for races with no label yet
        for name in [n for n in names if not got[n]]:
            sc = sorted(((ratio(name, l), l) for l in free), reverse=True)
            if not sc or sc[0][0] < 0.84 or (len(sc) > 1 and sc[0][0] - sc[1][0] < 0.06):
                continue
            label = sc[0][1]
            back = sorted(((ratio(n, label), n) for n in names if not got[n]), reverse=True)
            if back[0][1] != name:
                continue
            review.append(f"  [{level} {st}] closest {sc[0][0]:.2f}:  INEC '{name}'  ->  register '{label}'")
            take(name, label, "closest")
        # 5. one race and one seat left in the state
        left = [n for n in names if not got[n]]
        if len(left) == 1 and len(free) == 1:
            name, label = left[0], next(iter(free))
            review.append(f"  [{level} {st}] last pair {ratio(name, label):.2f}:  INEC '{name}'  ->  register '{label}'")
            take(name, label, "last-pair")
        # 6. numbered siblings the register does not tell apart ("Mushin II" has no
        #    label of its own): fold the race into its siblings' ballots. The union
        #    never drops a party that is on the unit's real sheet.
        for name in [n for n in names if not got[n]]:
            m = NUMERAL.search(B.norm(name))
            if not m:
                continue
            base = NUMERAL.sub("", B.norm(name))
            sibs = [(stt, l) for (stt, l), (n2, _) in label_of.items() if stt == st and NUMERAL.search(B.norm(n2)) and squeeze(NUMERAL.sub("", B.norm(n2))) == squeeze(base)]
            if sibs:
                for k in sibs:
                    extra[k].append(name)
                got[name] = [k[1] for k in sibs]
                review.append(f"  [{level} {st}] folded in:  INEC '{name}'  ->  shares the ballot of register {[k[1] for k in sibs]} (union)")
        # 7. a second spelling of a seat already paired
        for label in list(free):
            sc = sorted(((ratio(n, label), n) for n in names if got[n]), reverse=True)
            if sc and sc[0][0] >= 0.84 and (len(sc) == 1 or sc[0][0] - sc[1][0] >= 0.06):
                review.append(f"  [{level} {st}] second spelling {sc[0][0]:.2f}:  register '{label}'  ->  INEC '{sc[0][1]}'")
                take(sc[0][1], label, "second-spelling")
        for label in list(free):
            want = HAND_LABELS.get((st, label))
            if want and want in names:
                review.append(f"  [{level} {st}] by hand:  register '{label}'  ->  INEC '{want}'")
                take(want, label, "hand")
        unjoined += [(st, n) for n in names if not got[n]]
        unused += [(st, l, u) for l, u in free.items()]
    return label_of, extra, unjoined, unused, review


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()
    P = lambda n: json.load(open(os.path.join(SRC, "parsed", n)))  # noqa: E731
    parties = {p.get("code") or p.get("abbr") for p in (lambda j: j if isinstance(j, list) else j.get("parties", list(j.values())))(json.load(open(B.PARTIES)))}
    ballot = lambda recs: sorted({r["party"] for r in recs})  # noqa: E731

    out = {"PRES": ballot(P("pres.json")["records"]), "GOV": {}, "SEN": {}, "REP": {}}
    for f in P("gov.json")["files"]:
        st = {r["state"] for r in f["records"]}
        assert len(st) == 1, f["file"]
        out["GOV"][state_key(st.pop())] = ballot(f["records"])

    report = [f"PRES  {len(out['PRES'])} parties", f"GOV   {len(out['GOV'])} states, {min(map(len, out['GOV'].values()))}-{max(map(len, out['GOV'].values()))} parties each"]
    stats = {}
    joined = {}
    for code, fname, col in (("SEN", "sen.json", "senatorial"), ("REP", "rep.json", "federal_constituency")):
        races = defaultdict(list)
        for r in P(fname)["records"]:
            # one seat, however INEC wrapped its name on a given page
            races[(state_key(r["state"]), squeeze(r["constituency"]))].append(r)
        names = {}
        for r in P(fname)["records"]:
            names.setdefault((state_key(r["state"]), squeeze(r["constituency"])), re.sub(r"\s+", " ", r["constituency"]).strip())
        seats = register_seats(col)
        if code == "SEN":  # the FCT's single district is just "FCT" in the register
            for k in list(races):
                if k[0] == "FCT":
                    races[("FCT", "FCT")] = races.pop(k); names[("FCT", "FCT")] = "FCT"
        named = {(st, names[(st, sq)]): v for (st, sq), v in races.items()}
        paired, extra, unjoined, unused, review = join(named, seats, code)
        joined[code] = (named, paired, [k for k, v in extra.items() if v])
        how = defaultdict(int)
        units_total = sum(sum(v.values()) for v in seats.values())
        units_covered = 0
        for (st, label), (name, h) in paired.items():
            recs = list(named[(st, name)])
            for more in extra.get((st, label), []):
                recs += named[(st, more)]
            key = f"{st}|{K(label)}"
            # two register spellings can squeeze to one key: same seat, same ballot
            out[code][key] = sorted(set(out[code].get(key, [])) | set(ballot(recs)))
            how[h] += 1
            units_covered += seats[st][label]
        stats[code] = {"inec_races": len(named), "register_seats": sum(len(v) for v in seats.values()), "joined": len({(st, n) for (st, _), (n, _h) in paired.items()}) + sum(1 for v in extra.values() for _ in v) * 0, "labels_paired": len(paired), "folded_into_siblings": sorted({f"{k[0]} / {n}" for k, v in extra.items() for n in v}),
                       "how": dict(how), "units_covered": units_covered, "units_total": units_total,
                       "unjoined": [f"{st} / {n}" for st, n in unjoined], "unused_register_seats": [f"{st} / {l} ({u} units)" for st, l, u in unused]}
        report.append(f"{code}   INEC races {len(named)} · register seats {stats[code]['register_seats']} · joined {stats[code]['joined']} (+{len(stats[code]['folded_into_siblings'])} folded) · labels {len(paired)} {dict(how)} · "
                      f"units covered {units_covered:,} of {units_total:,} ({100 * units_covered / units_total:.1f}%)")
        report += review
        report += [f"  [{code}] NO SEAT for INEC race: {x}" for x in stats[code]["unjoined"]]
        report += [f"  [{code}] register seat with no race: {x}" for x in stats[code]["unused_register_seats"]]

    sha_pages, sha_ballots, sha_shared, sha_stats, sha_review, shaw, shaw_code = assembly(P)
    out["SHA"] = sha_ballots
    out["SHAW"] = shaw
    stats["SHA"] = sha_stats
    report.append(f"SHA   {sha_stats['inec_races']} INEC races · {sha_stats['pages_with_candidates']} of {sha_stats['seat_pages']} seat pages get candidates · "
                  f"LGA ballots {sha_stats['lgas_with_a_ballot']} ({sha_stats['of_which_exact']} exact, {sha_stats['of_which_union']} a union)")
    report += sha_review
    report += [f"  [SHA] INEC race with no seat page: {x}" for x in sha_stats["inec_races_without_a_page"]]
    report += [f"  [SHA] seat page with no race: {x}" for x in sha_stats["pages_without_a_race"]]
    # Reps seats whose ballot is a union of numbered siblings (step 6 of the join)
    rep_shared = sorted({f"{st}|{K(label)}" for (st, label) in joined["REP"][2]})
    shared = {"REP": rep_shared, "SHA": sha_shared}
    cand_files, cand_unresolved, cand_counts = candidate_files(P, joined)
    for st, seats_ in sha_pages.items():
        cand_files[st]["SHA"] = seats_
    report.append(f"race pages: candidate lists for {cand_counts} seat pages (resolved, of) in {len(cand_files)} state files; governorship in {sum(1 for v in cand_files.values() if v.get('GOV'))}")
    report += [f"  [pages] no INEC race found for seat page: {x}" for x in cand_unresolved]
    by_code, lga_idx, ward_idx, idx_stats = indexes(out)
    stats["index"] = idx_stats
    distinct = {c: len({",".join(v) for v in out[c].values()}) for c in ("GOV", "SEN", "REP")}
    stats["distinct_ballots"] = distinct
    report.append(f"index: {idx_stats} · distinct ballots {distinct}")
    bad = sorted({p for v in [out["PRES"], *out["GOV"].values(), *out["SEN"].values(), *out["REP"].values(), *out["SHA"].values()] for p in v} - parties)
    report.append(f"party codes not on the register of parties: {bad or 'none'}")
    print("\n".join(report))

    src = [ln.rstrip("\n").split("\t") for ln in open(os.path.join(SRC, "sources.tsv"))]
    doc = {
        "_source": {
            "what": "Parties fielding a candidate in each 2027 race, from INEC's FINAL LIST OF CANDIDATES (Presidential/Senate/Reps published 12 Sept 2026, Governorship 10 Oct 2026).",
            "from": "https://www.inecnigeria.org/elections/2027-general-elections-update",
            "pulled": open(os.path.join(SRC, "pulled.txt")).read().strip().replace("pulled ", ""),
            "built": datetime.date.today().isoformat(),
            "files": {s[0]: s[2] for s in src if "ASSEMBLY" not in s[0]},
            "keys": "SEN/REP: '<STATE>|<SEAT>' with both parts upper-cased and stripped to letters and digits, the seat being the register's own senatorial / federal_constituency value. GOV: the state, same rule. SHA: '<STATE>|<LGA>' — the register does not record state constituencies, so the ballot is the LGA's: exact where it elects one member, the union of its seats where it elects several (those keys are listed under SHARED, as are the Reps seats whose ballot is a union). A key that is absent means: not known — show every registered party.",
            "join": stats,
        },
        **out,
    }
    if args.write:
        for path in (OUT_BACKEND, OUT_APP):
            body = ({**doc, "SHAW_CODE": shaw_code, "SHARED": shared, "BY_CODE": by_code} if path == OUT_BACKEND
                    else {"_source": {k: doc["_source"][k] for k in ("what", "from", "pulled", "built", "keys")}, **out, "SHARED": shared, "LGA": lga_idx, "WARD": ward_idx})
            json.dump(body, open(path, "w"), ensure_ascii=False, separators=(",", ":"))
            print("wrote", os.path.relpath(path, B.ROOT), os.path.getsize(path), "bytes")
        cdir = os.path.join(B.ROOT, "app", "candidates-2027")
        os.makedirs(cdir, exist_ok=True)
        total = 0
        for st, body in sorted(cand_files.items()):
            doc_c = {"asOf": {"GOV": "2026-10-10", "SEN": "2026-09-12", "REP": "2026-09-12", "SHA": "2026-10-10"},
                     "source": "INEC, Final List of Candidates, 2027 General Election — https://www.inecnigeria.org/elections/2027-general-elections-update",
                     **body}
            fp = os.path.join(cdir, st + ".json")
            json.dump(doc_c, open(fp, "w"), ensure_ascii=False, separators=(",", ":"))
            total += os.path.getsize(fp)
        print("wrote", len(cand_files), "files in app/candidates-2027/,", total, "bytes in all")
    else:
        print("(dry run — pass --write to write the two files)")


if __name__ == "__main__":
    main()

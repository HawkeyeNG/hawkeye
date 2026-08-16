#!/usr/bin/env python3
"""Turn INEC's published final list of candidates into Hawkeye race objects.

    python3 scripts/build_races_from_inec.py <list.pdf> [--out DIR] [--cycle 2027]

INEC publishes the general-election final list as ONE text-layer PDF covering
Presidential + Senatorial + House of Representatives — 470 seats in a single
document. (Off-cycle and bye-election lists are fax-grade scans with no text
layer; those need OCR and this script will refuse them rather than emit
nonsense.) Output is one JSON per race in the shape app/race.js already renders,
keyed by the constituency, joined to the register's own `senatorial` /
`federal_constituency` columns so each race knows its polling units.

WHY ANCHOR PARSING, NOT COLUMN POSITIONS. The table's columns differ between
sections (the presidential block carries POSITION and REMARKS; the NASS blocks
carry STATE), cells wrap across lines, and rows are genuinely irregular — some
carry "COURT ORDER" in place of a candidate. Positional parsing of that produces
confident garbage. Instead every row is anchored on tokens from CLOSED SETS we
already hold: the party register (backend/src/data/parties.json), the 36 states
plus FCT, and the constituency names in polling_units. A row is recognised when
a party code appears; the candidate is the line before it; the constituency and
state are the most recent such tokens seen. Anything that fails to anchor is
COUNTED AND REPORTED, never silently dropped.

Two PDF-text traps, both of which produced badly wrong numbers before they were
understood — see scripts/constituency_join_test.py for the same pair:
  * glyph runs must be joined with NO separator, or kerning splits words
    ("FINAL LIS T OF C ANDID TES");
  * lines must then be joined WITH a space, or wrapped table cells stay severed
    ("NDOKWA EAST/NDOKWA" + "WEST/UKWANI").

DEFAULT OUTPUT IS A SCRATCH DIRECTORY. Pointing this at app/ ships whatever it
parsed to the website, and the only list published today is the 2022 one for the
2023 general — running it as a test must not quietly publish a stale cycle.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import unicodedata
import zlib
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "backend", "storage", "hawkeye.db")
PARTIES = os.path.join(ROOT, "backend", "src", "data", "parties.json")
ALIAS_FILE = os.path.join(ROOT, "scripts", "data", "constituency_aliases.json")

# INEC's spelling -> the register's own value, for the seats where the two
# disagree. Matched WITHIN a state on the whole name and hand-reviewed; see the
# file's own _note for why token-level fuzzy matching was rejected (it proposed
# DAMBAM->DAMBOA, which is Bauchi against Borno). Rejections are kept in the
# file with their reason, so "not aliased" is a recorded decision, not an
# oversight.
try:
    _af = json.load(open(ALIAS_FILE))
    NAME_ALIASES = {k: v["register"] for k, v in _af.get("aliases", {}).items()}
except (FileNotFoundError, ValueError):
    NAME_ALIASES = {}

STATES = [
    "ABIA", "ADAMAWA", "AKWA IBOM", "ANAMBRA", "BAUCHI", "BAYELSA", "BENUE", "BORNO",
    "CROSS RIVER", "DELTA", "EBONYI", "EDO", "EKITI", "ENUGU", "FCT", "GOMBE", "IMO",
    "JIGAWA", "KADUNA", "KANO", "KATSINA", "KEBBI", "KOGI", "KWARA", "LAGOS",
    "NASARAWA", "NASSARAWA", "NIGER", "OGUN", "ONDO", "OSUN", "OYO", "PLATEAU",
    "RIVERS", "SOKOTO", "TARABA", "YOBE", "ZAMFARA",
]

# INEC and the register disagree on these spellings. Verified against the 2022
# list: NASSARAWA NORTH is in the PDF, NASARAWA NORTH is not.
ALIASES = {
    "NASARAWA": "NASSARAWA",
    "ABUJA": "FCT",
    "DELTAL": "DELTA",
    "ADEMAWA": "ADAMAWA",
}


# ---------------------------------------------------------------- PDF text
OCTAL = re.compile(rb"\\([0-7]{1,3})")
TOKEN = re.compile(rb"\((?:[^()\\]|\\.)*\)|T[dDmJj*]|TD")


def _decode(b):
    b = re.sub(rb"\\([()\\])", rb"\1", b)
    b = OCTAL.sub(lambda m: bytes([int(m.group(1), 8) & 0xFF]), b)
    s = b.decode("latin-1", "replace")
    for ch, rep in (("\x1f", "fi"), ("\x0c", "fi"), ("\x92", "'"), ("\x93", '"'), ("\x94", '"')):
        s = s.replace(ch, rep)
    return s


def pdf_lines(path):
    raw = open(path, "rb").read()
    out, fonts, images = [], 0, 0
    fonts = len(re.findall(rb"/Font", raw))
    images = len(re.findall(rb"/CCITTFaxDecode|/DCTDecode|/JBIG2Decode", raw))
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", raw, re.S):
        try:
            d = zlib.decompress(m.group(1))
        except Exception:
            continue
        run = []
        for t in TOKEN.finditer(d):
            tok = t.group(0)
            if tok.startswith(b"("):
                run.append(_decode(tok[1:-1]))          # NO separator — kerning
            elif tok in (b"Td", b"TD", b"Tm", b"T*"):
                if run:
                    out.append("".join(run).strip())
                    run = []
        if run:
            out.append("".join(run).strip())
    return [l for l in out if l], fonts, images


# ---------------------------------------------------------------- naming
def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = s.upper().replace("&", " AND ").replace("'", "").replace("\\", "/").replace("’", "")
    s = re.sub(r"\b(FEDERAL\s+)?CONSTITUENCY\b", " ", s)
    s = re.sub(r"\bSENATORIAL(\s+DISTRICT)?\b", " ", s)
    s = re.sub(r"\bDISTRICT\b", " ", s)
    s = re.sub(r"[^A-Z0-9/]+", " ", s)
    s = re.sub(r"\s*/\s*", "/", s)
    s = re.sub(r"\s+", " ", s).strip()
    for a, b in ALIASES.items():
        s = re.sub(rf"\b{a}\b", b, s)
    return s


def key_of(s):
    """Order-insensitive key: the two sources list multi-LGA components in
    different orders (INEC EKET/ONNA/ESIT EKET/IBENO vs register
    Eket/Esit Eket/Onna/Ibeno — same seat)."""
    n = norm(s)
    return "/".join(sorted(p.strip() for p in n.split("/") if p.strip()))


def slug(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", norm(s).lower())).strip("-")


# ---------------------------------------------------------------- register
def load_register():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    sen, fed = defaultdict(lambda: {"units": 0, "lgas": set(), "state": None, "label": None}), \
               defaultdict(lambda: {"units": 0, "lgas": set(), "state": None, "label": None})
    for col, bag in (("senatorial", sen), ("federal_constituency", fed)):
        q = f"SELECT {col}, state, lga, COUNT(*) FROM polling_units " \
            f"WHERE {col} IS NOT NULL AND {col} <> '' GROUP BY {col}, state, lga"
        for value, state, lga, n in con.execute(q):
            e = bag[key_of(value)]
            e["units"] += n
            if lga:
                e["lgas"].add(lga)
            e["state"] = e["state"] or state
            e["label"] = e["label"] or value
    con.close()
    return sen, fed


# ---------------------------------------------------------------- parsing
# The POSITION cell, which sits between the party and the name in the
# presidential and senate blocks. Read off the document — the senate block says
# "Senate", not "Senatorial", and missing that one word cost 80% of the senate
# candidates on the first run.
ROLE_WORDS = {"PRESIDENTIAL", "VICE", "VICE PRESIDENTIAL", "SENATE", "SENATORIAL",
              "HOUSE OF REPRESENTATIVES", "REPRESENTATIVE", "REPS"}
# Cells that sit next to a name and must never be mistaken for one.
NOT_A_NAME = {"NONE", "M", "F", "MALE", "FEMALE", "YES", "NO", "NIL", "N/A",
              "COURT ORDER", "VACANT", "WITHDRAWN", "PWD", "AGE", "GENDER",
              "QUALIFICATIONS", "REMARKS", "PARTY", "CONSTITUENCY", "S/N"}


def looks_like_name(s, party_set, state_set):
    n = norm(s)
    if not n or n in NOT_A_NAME or n in party_set or n in state_set or n in ROLE_WORDS:
        return False
    if re.fullmatch(r"[\d\s./]+", n):
        return False
    # Qualification cells are the main false positive: they are long, shouty and
    # full of certificate names.
    if re.search(r"\b(WAEC|NECO|SSCE|FSLC|B\.?SC|BSC|MBBS|LLB|HND|OND|NCE|PHD|MSC|"
                 r"CERTIFICATE|DEGREE|DIPLOMA|SCHOOL|UNIVERSITY|BACHELOR|MASTER)\b", n):
        return False
    return len(n) >= 4 and len(n.split()) <= 6


def _join_name(lines, j, party_set, state_set):
    """A wrapped name continues on the next line ('IMUMOLEN IRENE' / 'CHRISTOPHER')."""
    parts = [lines[j].strip()]
    if j + 1 < len(lines) and looks_like_name(lines[j + 1], party_set, state_set) \
       and len(norm(lines[j + 1]).split()) <= 2:
        parts.append(lines[j + 1].strip())
    return re.sub(r"\s+", " ", " ".join(parts))


def parse(lines, parties, sen_keys, fed_keys):
    """Anchor on party codes; recognise constituencies against the REGISTER.

    The first cut treated "any line that isn't something else" as the current
    constituency, which cannot work: wrapping splits 'Ebonyi South' into
    'Ebonyi' + 'South', so the tracker ended up holding 'SOUTH', 'CENTRAL', even
    'MOHAMMED'. It produced 4,221 senate rows, two thousand unjoinable
    constituencies and zero candidates.

    A constituency is now only a constituency if the register agrees. Each line
    is tested alone and joined with the one or two before it, so a wrapped name
    is reassembled; the winning span's indices are marked CONSUMED so the
    name-finder cannot mistake half a constituency for a candidate. The level
    (senate or reps) then comes from WHICH register column matched, rather than
    from section headings that wrap and repeat.
    """
    party_set, state_set = set(parties), set(STATES)
    rows = []
    position, cur_state, cur_con, cur_level = "Presidential", None, None, None
    consumed = set()

    for i, raw in enumerate(lines):
        t = raw.strip()
        up = norm(t)
        if not up or i in consumed:
            continue

        # Constituency: longest window (3..1 lines) the register recognises,
        # or that the alias table maps onto something the register recognises.
        matched = False
        for w in (3, 2, 1):
            if i - w + 1 < 0:
                continue
            span = " ".join(lines[j].strip() for j in range(i - w + 1, i + 1))
            k = key_of(span)
            if k not in sen_keys and k not in fed_keys and k in NAME_ALIASES:
                span = NAME_ALIASES[k]          # rewrite to the register's own spelling
                k = key_of(span)
            if k in sen_keys or k in fed_keys:
                cur_con, cur_level = span, ("senatorial" if k in sen_keys else "federal_constituency")
                position = "Senator" if cur_level == "senatorial" else "Representative"
                consumed.update(range(i - w + 1, i + 1))
                matched = True
                break
        if matched:
            continue

        if up in state_set:
            cur_state = up
            continue
        if "NIGERIA" == up:
            position, cur_con, cur_level = "Presidential", "Nigeria", "national"
            continue

        if up in party_set:
            # THE TWO BLOCKS ORDER THEIR COLUMNS DIFFERENTLY, which is why a
            # single walk-back lost a third of the Senate and mangled the
            # presidency:
            #   presidential  S/N | NIGERIA | PARTY | POSITION | NAME | PWD ...
            #   senate/reps   S/N | [STATE] | CONSTITUENCY | NAME | PARTY | PWD ...
            # So look FORWARD first — if a role word follows the party, this is
            # the presidential layout and the name is past it — and fall back to
            # looking backward otherwise. The document tells us which; we do not
            # assume.
            role, name = None, None
            j = i + 1
            while j < len(lines) and j < i + 6:
                cand = lines[j].strip()
                cn = norm(cand)
                if cn in ROLE_WORDS:
                    # "Vice-" and "Presidential" arrive as TWO lines, so a plain
                    # assignment let the second overwrite the first and every
                    # running mate was promoted to a presidential candidate.
                    # Once vice is seen it sticks.
                    if "VICE" in cn:
                        role = "Vice-Presidential"
                    elif role is None:
                        role = "Presidential" if cn == "PRESIDENTIAL" else "Candidate"
                    j += 1
                    continue
                if role:                      # presidential layout: name follows
                    if looks_like_name(cand, party_set, state_set):
                        name = _join_name(lines, j, party_set, state_set)
                    break
                break
            if name is None:
                for j in range(i - 1, max(-1, i - 5), -1):
                    if j in consumed:
                        continue
                    cand = lines[j].strip()
                    cn = norm(cand)
                    if not cand or cn in state_set or cn in party_set or re.fullmatch(r"[\d\s.]+", cand):
                        continue
                    # "COURT ORDER" and friends are real rows with no candidate
                    # on them. Recorded as such — never invented.
                    if cn in ("COURT ORDER", "NONE", "VACANT", "WITHDRAWN"):
                        break
                    if looks_like_name(cand, party_set, state_set):
                        name = re.sub(r"\s+", " ", cand)
                    break
            rows.append({"position": position, "state": cur_state,
                         "constituency": cur_con, "level": cur_level,
                         "role": role, "name": name, "party": up})
    return rows, []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--out", default="/tmp/races_out",
                    help="output dir (default a scratch dir — pointing this at app/ publishes)")
    ap.add_argument("--cycle", default="2027")
    ap.add_argument("--election", default=None)
    a = ap.parse_args()

    lines, fonts, scan_streams = pdf_lines(a.pdf)
    print(f"pdf: {a.pdf}")
    print(f"  text lines {len(lines):,}   font objects {fonts}   scan streams {scan_streams}")
    if fonts == 0 or len(lines) < 500:
        sys.exit("REFUSING: this PDF has no usable text layer (scanned). It needs OCR, "
                 "not this parser — emitting a race file from it would be fabrication.")

    parties = [p["code"] for p in json.load(open(PARTIES))]
    sen_reg, fed_reg = load_register()
    print(f"  register: {len(sen_reg)} senatorial, {len(fed_reg)} federal constituencies")

    rows, _ = parse(lines, parties, set(sen_reg), set(fed_reg))
    print(f"  candidate rows anchored on a party code: {len(rows):,}")
    by_pos = Counter(r["position"] for r in rows)
    print(f"  by position: {dict(by_pos)}")

    # ---- group into races, joining to the register
    races, unjoined = {}, Counter()
    for r in rows:
        if r["position"] == "Presidential":
            k, reg, level = "presidency", None, "national"
        else:
            bag = sen_reg if r["level"] == "senatorial" else fed_reg
            kk = key_of(r["constituency"] or "")
            reg = bag.get(kk)
            if not reg:
                unjoined[(r["position"], r["constituency"])] += 1
                continue
            level = "senatorial" if r["position"] == "Senator" else "federal_constituency"
            k = f"{'sen' if level == 'senatorial' else 'rep'}-{slug(reg['label'])}"
        race = races.setdefault(k, {
            "key": k, "position": r["position"], "level": level,
            "label": reg["label"] if reg else "Nigeria",
            "state": (reg or {}).get("state") or r["state"],
            "units": (reg or {}).get("units"), "lgas": sorted((reg or {}).get("lgas", [])),
            "cands": [],
        })
        if not r["name"]:
            continue
        # A running mate is not a second candidate. The presidential block lists
        # Presidential and Vice-Presidential as separate rows under one party, so
        # counting rows would report 36 candidates for an 18-way race.
        if r.get("role") == "Vice-Presidential":
            race.setdefault("mates", {})[r["party"]] = r["name"].title()
        else:
            race["cands"].append({"name": r["name"].title(), "party": r["party"]})

    print(f"  races built: {len(races)}   unjoined constituencies: {len(unjoined)}")

    # CONTAMINATION CHECK. A constituency the register does not recognise never
    # sets cur_con, so its rows silently attach to whichever race was current —
    # the parse looks clean while two seats are merged. One party can field only
    # ONE candidate per seat, so a repeated party code inside a race is proof
    # that rows from more than one constituency landed in it.
    dirty = []
    for k, r in races.items():
        c = Counter(x["party"] for x in r["cands"])
        dup = {p: n for p, n in c.items() if n > 1}
        if dup:
            dirty.append((k, len(r["cands"]), dup))
    if dirty:
        print(f"  ** {len(dirty)} race(s) contain a repeated party — rows from an "
              f"unrecognised constituency merged in. These need an ALIASES entry: **")
        for k, n, dup in sorted(dirty, key=lambda x: -x[1])[:12]:
            print(f"      {k}  ({n} candidates)  repeats: {dict(list(dup.items())[:4])}")
    else:
        print("  contamination check: clean — no race repeats a party code")
    if unjoined:
        print("  top unjoined (register spelling differs — extend ALIASES):")
        for (pos, con), n in unjoined.most_common(10):
            print(f"      {pos:<14} {con!r}  ({n} rows)")

    # ---- emit race objects in app/race.js's shape
    os.makedirs(a.out, exist_ok=True)
    election = a.election or f"{a.cycle} General Election"
    index = []
    for k, r in sorted(races.items()):
        office = ("President of the Federal Republic of Nigeria" if r["level"] == "national"
                  else f"Senator — {r['label']}" if r["position"] == "Senator"
                  else f"House of Representatives — {r['label']}")
        obj = {
            "asOf": None,                      # stamped by the caller, not invented here
            "office": office,
            "election": election,
            "dateText": a.cycle,
            "dateLabel": "Election year",
            "note": "Compiled from INEC's published final list of candidates. "
                    "Verify against INEC — official candidate lists and results are INEC's.",
            "stats": {k2: v for k2, v in (("lgas", len(r["lgas"]) or None),
                                          ("pollingUnits", r["units"])) if v},
            # candidates[] is dereferenced unconditionally by race.js and must
            # exist. Down-ballot races carry no per-candidate prose, so every
            # name goes in others[] and the page renders the full ballot.
            "candidates": [],
            "others": sorted(
                [dict(c, **({"mate": r["mates"][c["party"]]} if c["party"] in r.get("mates", {}) else {}))
                 for c in r["cands"]],
                key=lambda c: (c["party"], c["name"])),
            # LGA NAMES, not just the count. The race map is cut from
            # app/lga_geo.json, whose keys are "<state>|<lga>" lowercased, so the
            # client needs the members — the same way the Osun board subdivides a
            # state into its LGAs rather than drawing one flat outline.
            "join": {"level": r["level"], "value": r["label"], "state": r["state"],
                     "lgas": r["lgas"]},
        }
        json.dump(obj, open(os.path.join(a.out, f"{k}.json"), "w"), indent=1, ensure_ascii=False)
        index.append({"key": k, "office": office, "state": r["state"],
                      "position": r["position"], "candidates": len(obj["others"])})
    json.dump(index, open(os.path.join(a.out, "index.json"), "w"), indent=1, ensure_ascii=False)

    total = sum(i["candidates"] for i in index)
    print(f"\nwrote {len(index)} race files + index.json to {a.out}")
    print(f"  candidates emitted: {total:,}")
    for pos in ("Presidential", "Senator", "Representative"):
        n = [i for i in index if i["position"] == pos]
        print(f"  {pos:<15} races {len(n):>4}   candidates {sum(i['candidates'] for i in n):>6}")


if __name__ == "__main__":
    main()

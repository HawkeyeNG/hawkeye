#!/usr/bin/env python3
"""Rebuild tests/fixtures/sen-ebonyi-south.json — the down-ballot race fixture.

WHY A FIXTURE. race_render_test.mjs read this race out of /tmp/races_out/, the
scratch directory scripts/build_races_from_inec.py writes to. Scratch does not
survive, and the test died on ENOENT with nothing to say about the code it was
meant to be checking. The generator needs INEC's PDF, which is not in the repo
(deliberately — see the generator's header on not publishing 2023 data as 2027),
so the ONE race the test needs is reproduced here instead.

Shape and field-for-field semantics are copied from the generator's own emit
block (build_races_from_inec.py). The LGA membership and polling-unit count come
from the register, so the fixture stays true to the geometry the map is cut from
rather than freezing a list someone typed.

    python3 tests/fixtures/make_sen_fixture.py
"""
import json
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(ROOT, "backend", "storage", "hawkeye.db")
OUT = os.path.join(ROOT, "tests", "fixtures", "sen-ebonyi-south.json")

SEAT = "Ebonyi South"
STATE = "Ebonyi"

# A plausible field, in the generator's own `others[]` shape. These are NOT real
# candidates and the fixture says so in its own note — the test only ever counts
# rows and reads headings, so inventing names here cannot leak into anything a
# reader sees.
OTHERS = [
    {"name": "Test Candidate One", "party": "APC"},
    {"name": "Test Candidate Two", "party": "LP"},
    {"name": "Test Candidate Three", "party": "PDP"},
    {"name": "Test Candidate Four", "party": "YPP"},
]

con = sqlite3.connect(DB)
lgas = [r[0] for r in con.execute(
    "SELECT DISTINCT lga FROM polling_units WHERE senatorial = ? AND lga IS NOT NULL ORDER BY lga",
    (SEAT,))]
units = con.execute(
    "SELECT COUNT(*) FROM polling_units WHERE senatorial = ?", (SEAT,)).fetchone()[0]
con.close()
assert lgas, f"no LGAs for {SEAT} — is the register loaded?"

obj = {
    "asOf": None,
    "office": f"Senator — {SEAT}",
    "election": f"{STATE} State · Senate",
    "dateText": "2023",
    "dateLabel": "Election year",
    "note": "FIXTURE — not real candidate data. Reproduces the shape of a race "
            "emitted by scripts/build_races_from_inec.py so the render test can "
            "run without the source PDF.",
    "stats": {"lgas": len(lgas), "pollingUnits": units},
    "candidates": [],
    "others": sorted(OTHERS, key=lambda c: (c["party"], c["name"])),
    "join": {"contest": "SEN", "level": "senatorial", "value": SEAT,
             "state": STATE, "lgas": lgas},
}
json.dump(obj, open(OUT, "w"), indent=1, ensure_ascii=False)
print(f"wrote {OUT}: {len(lgas)} LGAs, {units:,} units, {len(OTHERS)} candidates")

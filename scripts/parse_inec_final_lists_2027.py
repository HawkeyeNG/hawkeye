#!/usr/bin/env python3
"""
Parse INEC's 2027 FINAL LIST OF CANDIDATES PDFs into plain JSON.

    python3 scripts/parse_inec_final_lists_2027.py tmp/inec-2027/pdf --out tmp/inec-2027/parsed

WHY A SECOND PARSER. build_races_from_inec.py reads the 2022 file, whose text
has no table structure left and has to be anchored on closed sets. The 2027
files (published 12 Sept and 10 Oct 2026 on the rebuilt inecnigeria.org) are
ruled tables: every cell is bounded by drawn lines. So this reads the RULINGS
and drops each word into the cell it sits in. Nothing is inferred from word
order, and a wrapped name or constituency cannot leak into its neighbour.

Five layouts, one grid rule:
  Presidential   SN | PARTY | STATE | POSITION | NAME | PWD | AGE | GENDER | QUALIFICATION(S) | REMARKS
  Governorship   SN | STATE | POSITION | NAME | PARTY | ...        (one file per state)
  Senate / Reps / State Assembly
                 SN | STATE | CONSTITUENCY | NAME | PARTY | ...
A presidential or governorship row holds TWO people (candidate above, running
mate below); the line between them crosses every column except SN and PARTY,
which is how a row boundary is told from that inner line: a row boundary is a
horizontal ruling that crosses the SN column.

The page carries a large rotated "INEC" watermark as real text. It is one very
tall "word" and is dropped by height; left in, its letters land in cells.

OUTPUT IS SCRATCH (tmp/ by default). It is INEC's list as printed, with the
checks below; it is not the site's data and nothing here publishes.

CHECKS, printed and written to summary.json — a list is not trusted unless:
  - serial numbers run 1..N with no gap and no row lacks one;
  - every party code is on the register of parties (backend/src/data/parties.json);
  - no party appears twice in one race (two seats merged, or a row misread);
  - Senate and Reps constituencies join to the polling-unit register.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict

import fitz  # PyMuPDF

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_races_from_inec as B  # norm / key_of / load_register / aliases  # noqa: E402

HEADERS = {
    "SN": "sn", "S/N": "sn", "STATE": "state", "CONSTITUENCY": "constituency", "POSITION": "position",
    "NAME OF CANDIDATE": "name", "PARTY": "party", "PWD": "pwd", "AGE": "age", "GENDER": "gender",
    "QUALIFICATION(S)": "qualifications", "QUALIFICATIONS": "qualifications", "REMARKS": "remarks",
}
TWO_PEOPLE = ("pres", "gov")


def kind_of(title, filename):
    t = (title + " " + filename).upper()
    if "SENATORIAL" in t or "SENATE" in t:
        return "sen"
    if "HOUSE OF REPRESENTATIVES" in t or "REPS" in t:
        return "rep"
    if "STATE HOUSE" in t or "HOUSES OF ASSEMBLY" in t:
        return "sha"
    if "GOVERNORSHIP" in t:
        return "gov"
    if "PRESIDENTIAL" in t:
        return "pres"
    return "unknown"


def cluster(vals, tol=1.5):
    out = []
    for v in sorted(vals):
        if not out or v - out[-1] > tol:
            out.append(v)
    return out


def rulings(page):
    """Vertical x's and horizontal (y, x0, x1) segments. A pure fill counts only
    when it is thin (a line drawn as a filled sliver): row shading is a fill too,
    and its edges are not rulings."""
    vx, hs = [], []

    def seg(x0, y0, x1, y1):
        if abs(x0 - x1) < 1.5 and abs(y0 - y1) > 8:
            vx.append((x0 + x1) / 2)
        elif abs(y0 - y1) < 1.5 and abs(x0 - x1) > 8:
            hs.append(((y0 + y1) / 2, min(x0, x1), max(x0, x1)))

    for dr in page.get_drawings():
        r = dr["rect"]
        thin = r.width < 1.5 or r.height < 1.5
        if dr.get("type") == "f" and not thin:
            continue
        if thin:
            seg(r.x0, r.y0, r.x1, r.y1)
            continue
        for it in dr["items"]:
            if it[0] == "l":
                seg(it[1].x, it[1].y, it[2].x, it[2].y)
            elif it[0] == "re":
                q = it[1]
                for a in ((q.x0, q.y0, q.x1, q.y0), (q.x0, q.y1, q.x1, q.y1), (q.x0, q.y0, q.x0, q.y1), (q.x1, q.y0, q.x1, q.y1)):
                    seg(*a)
    return cluster(vx), hs


def cell_text(words):
    """Words of one cell, top line first. Lines are grouped by baseline so a
    wrapped name reads in order."""
    if not words:
        return ""
    words = sorted(words, key=lambda w: (w[1], w[0]))
    lines, cur, y = [], [], None
    for w in words:
        if y is None or abs(w[1] - y) > 4:
            if cur:
                lines.append(cur)
            cur, y = [], w[1]
        cur.append(w)
    lines.append(cur)
    return re.sub(r"\s+", " ", " ".join(" ".join(x[4] for x in sorted(ln, key=lambda w: w[0])) for ln in lines)).strip()


def parse_page(page, cols_prev):
    """-> (cols, rows, problems). rows: list of dicts col -> [top_text, bottom_text|None]."""
    problems = []
    xs, hs = rulings(page)
    if len(xs) != 11:
        return cols_prev, [], [f"expected 11 vertical rulings, found {len(xs)}"]
    c0 = (xs[0], xs[1])
    # A row boundary crosses the SN column; the candidate/running-mate line does not.
    ys = cluster([y for (y, a, b) in hs if a <= c0[0] + 3 and b >= c0[1] - 3])
    if len(ys) < 2:
        return cols_prev, [], ["no row rulings"]
    words = [w for w in page.get_text("words") if (w[3] - w[1]) < 20 and ys[0] - 1 <= (w[1] + w[3]) / 2 <= ys[-1] + 1]
    col_of = lambda x: next((i for i in range(10) if xs[i] <= x < xs[i + 1]), None)  # noqa: E731
    cols, rows = cols_prev, []
    for top, bot in zip(ys, ys[1:]):
        in_row = [w for w in words if top <= (w[1] + w[3]) / 2 < bot]
        cells = defaultdict(list)
        for w in in_row:
            c = col_of((w[0] + w[2]) / 2)
            if c is not None:
                cells[c].append(w)
        texts = [cell_text(cells.get(i, [])) for i in range(10)]
        if texts[0].upper() in ("SN", "S/N"):
            cols = [HEADERS.get(t.upper()) for t in texts]
            if None in cols:
                problems.append(f"unknown header {texts}")
            continue
        if not cols:
            problems.append("data row before any header")
            continue
        if not any(texts):
            continue
        row = {}
        for i, name in enumerate(cols):
            if name is None:
                continue
            # the inner line for THIS column, if the row is split there
            # (drawn inset from the cell's edges, so judged by overlap, not by reaching them)
            w_col = xs[i + 1] - xs[i]
            inner = [y for (y, a, b) in hs if top + 3 < y < bot - 3 and min(b, xs[i + 1]) - max(a, xs[i]) > 0.5 * w_col]
            if inner:
                cut = min(inner)
                up = [w for w in cells.get(i, []) if (w[1] + w[3]) / 2 < cut]
                dn = [w for w in cells.get(i, []) if (w[1] + w[3]) / 2 >= cut]
                row[name] = [cell_text(up), cell_text(dn)]
            else:
                row[name] = [texts[i], None]
        rows.append(row)
    return cols, rows, problems


def person(row, j):
    g = lambda k: (row.get(k) or ["", None])[j] if (row.get(k) or ["", None])[j] is not None else None  # noqa: E731
    age = g("age")
    return {
        "name": g("name"), "position": g("position"),
        "age": int(age) if age and age.isdigit() else None,
        "gender": g("gender"), "pwd": g("pwd"), "qualifications": g("qualifications"),
    }


def parse_file(path):
    doc = fitz.open(path)
    first = doc[0].get_text("text")
    title = " ".join(ln.strip() for ln in first.split("\n")[:8] if re.search(r"ELECTION|GOVERNORSHIP|PRESIDENTIAL|ASSEMBLY", ln))
    kind = kind_of(title, os.path.basename(path))
    cols, recs, problems = None, [], []
    for pn in range(len(doc)):
        cols, rows, probs = parse_page(doc[pn], cols)
        problems += [f"p{pn + 1}: {p}" for p in probs]
        for row in rows:
            one = lambda k: (row.get(k) or ["", None])[0]  # noqa: E731
            sn = one("sn")
            a = person(row, 0)
            rec = {
                "sn": int(sn) if sn.isdigit() else None, "page": pn + 1,
                "state": one("state").upper(), "constituency": one("constituency") or None,
                "party": one("party").upper(), "name": a["name"], "age": a["age"], "gender": a["gender"],
                "pwd": a["pwd"], "qualifications": a["qualifications"], "remarks": one("remarks") or None,
            }
            if kind in TWO_PEOPLE:
                split = row.get("name", ["", None])[1] is not None
                if not split:
                    problems.append(f"p{pn + 1}: SN {sn} has no running-mate line")
                else:
                    m = person(row, 1)
                    rec["runningMate"] = {k: m[k] for k in ("name", "age", "gender", "pwd", "qualifications")}
                    st = row.get("state")
                    if st and st[1] is not None:
                        rec["state"] = st[0].upper()
            recs.append(rec)
    return {"file": os.path.basename(path), "kind": kind, "title": title, "pages": len(doc),
            "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(), "records": recs, "problems": problems}


def check(parsed, parties, sen, fed):
    """The four checks of the docstring. Returns a summary dict."""
    recs, kind = parsed["records"], parsed["kind"]
    sns = [r["sn"] for r in recs]
    out = {"file": parsed["file"], "kind": kind, "pages": parsed["pages"], "rows": len(recs)}
    # INEC numbers each STATE from 1, so the run restarts when the state changes.
    bad, prev, prev_state = [], 0, None
    for i, r in enumerate(recs):
        want = 1 if r["state"] != prev_state else prev + 1
        if r["sn"] != want:
            bad.append([i + 1, r["page"], r["state"], want, r["sn"]])
        prev, prev_state = (r["sn"] or prev), r["state"]
    out["sn_ok"] = not bad
    if bad:
        out["sn_first_breaks"] = bad[:8]
    out["no_name"] = sum(1 for r in recs if not r["name"])
    out["unknown_party"] = sorted(Counter(r["party"] for r in recs if r["party"] not in parties).items())
    race = lambda r: (r["state"], r["constituency"] or "")  # noqa: E731
    by = defaultdict(list)
    for r in recs:
        by[race(r)].append(r)
    out["races"] = len(by)
    out["states"] = len({r["state"] for r in recs})
    out["state_list"] = sorted({r["state"] for r in recs})
    dup = {f"{k[0]} / {k[1]}": [p for p, n in Counter(x["party"] for x in v).items() if n > 1] for k, v in by.items()}
    out["party_twice_in_a_race"] = {k: v for k, v in dup.items() if v}
    out["remarks"] = sorted(Counter(r["remarks"] for r in recs if r["remarks"]).items(), key=lambda kv: -kv[1])[:12]
    out["women"] = sum(1 for r in recs if (r["gender"] or "").upper().startswith("F"))
    out["pwd"] = sum(1 for r in recs if (r["pwd"] or "None").strip().lower() not in ("none", ""))
    out["parties_fielding"] = len({r["party"] for r in recs})
    per = [len(v) for v in by.values()]
    out["candidates_per_race"] = [min(per), round(sum(per) / len(per), 1), max(per)] if per else []
    if kind in ("sen", "rep"):
        bag = sen if kind == "sen" else fed
        miss = []
        for (state, cons), v in by.items():
            name = B.NAME_ALIASES.get(f"{state}|{cons}", B.NAME_ALIASES.get(cons, cons))
            e = bag.get(B.key_of(name))
            if not e:
                miss.append(f"{state} / {cons}")
            elif B.norm(e["state"] or "") != B.norm(state):
                miss.append(f"{state} / {cons}  (register has it in {e['state']})")
        out["register_seats"] = len(bag)
        out["joined"] = len(by) - len(miss)
        out["not_joined"] = sorted(miss)
        inec_keys = {B.key_of(B.NAME_ALIASES.get(c, c)) for (_, c) in by}
        out["register_seats_with_no_candidates"] = sorted(v["label"] for k, v in bag.items() if k not in inec_keys)
    problems = parsed["problems"]
    out["problems"] = len(problems)
    out["problem_samples"] = problems[:6]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="a PDF, or a folder of them")
    ap.add_argument("--out", default=os.path.join(B.ROOT, "tmp", "inec-2027", "parsed"))
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(args.src, "*.pdf"))) if os.path.isdir(args.src) else [args.src]
    os.makedirs(args.out, exist_ok=True)
    parties = {p.get("code") or p.get("abbr") for p in (lambda j: j if isinstance(j, list) else j.get("parties", list(j.values())))(json.load(open(B.PARTIES)))}
    sen, fed = B.load_register()
    summary, gov = [], []
    for f in files:
        p = parse_file(f)
        s = check(p, parties, sen, fed)
        summary.append(s)
        if p["kind"] == "gov":
            gov.append(p)
        else:
            json.dump(p, open(os.path.join(args.out, p["kind"] + ".json"), "w"), ensure_ascii=False, indent=1)
        print(f"{p['kind']:5s} {s['rows']:5d} rows  {s['races']:4d} races  SN {'ok ' if s['sn_ok'] else 'BAD'}  "
              f"problems {s['problems']:3d}  unknown-party {len(s['unknown_party'])}  twice {len(s['party_twice_in_a_race'])}  {p['file'][:52]}")
    if gov:
        json.dump({"kind": "gov", "files": gov}, open(os.path.join(args.out, "gov.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(summary, open(os.path.join(args.out, "summary.json"), "w"), ensure_ascii=False, indent=1)
    print("written to", args.out)


if __name__ == "__main__":
    main()

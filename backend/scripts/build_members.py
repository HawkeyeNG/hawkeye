#!/usr/bin/env python3
"""
Build app/members.json — Hawkeye's own per-member roster of the National Assembly.

WHY THIS FILE EXISTS. There is no single authority that says which party every
sitting member belongs to *today*. nass.gov.ng publishes the party a member was
elected on and never records defections; Wikipedia's roster table covers 16
states; medianigeria has the 2023 declared result for the Senate only; the one
complete name list (currentaffairs.ng) carries no party at all. Any one of them
alone produces a wrong page. So we merge them, record which source produced
each row, keep a hand-maintained overlay of documented party changes, and
DERIVE the seat counts from the roster. The picture and the names then come
from the same place and cannot drift apart.

Run:  python3 backend/scripts/build_members.py
Writes: app/members.json  (committed — this is the published artefact)
Reads:  app/party_changes.json  (editorial overlay, hand-maintained)
"""
import json, os, re, sys, time, urllib.parse, urllib.request, collections

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "app", "members.json")
CHANGES = os.path.join(ROOT, "app", "party_changes.json")

UA = {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}
WIKI_UA = {"user-agent": "HawkeyeBot/1.0 (+https://hawkeye.com.ng; election transparency)"}

clean = lambda s: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", str(s or ""))).strip()
nd = lambda s: re.sub(r"[^a-z]", "", re.sub(r"federal constituency|senatorial district", "", str(s or "").lower()))
tok = lambda s: set(w for w in re.split(r"\s+", re.sub(r"[^a-z\s]", " ", str(s or "").lower())) if len(w) > 2)
PARTIES = {"APC", "PDP", "LP", "NNPP", "APGA", "SDP", "ADC", "YPP", "ADP", "PRP", "AA", "APM", "BP", "ZLP", "AAC", "NRM"}

STATES = ["Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno",
          "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "Gombe", "Imo", "Jigawa",
          "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger",
          "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara"]


def get(u, h=None, tries=3):
    last = None
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(u, headers={**UA, **(h or {})}), timeout=60).read().decode("utf8", "replace")
        except Exception as e:
            last = e
            time.sleep(1 + i)
    raise last


def wikitext(page):
    u = ("https://en.wikipedia.org/w/api.php?action=parse&page=" + urllib.parse.quote(page)
         + "&prop=wikitext&format=json&formatversion=2")
    j = json.loads(get(u, WIKI_UA))
    return None if "error" in j else j["parse"]["wikitext"]


def delink(s):
    s = re.sub(r"<ref[^>]*>.*?</ref>|<ref[^>]*/>", "", s, flags=re.S)
    s = re.sub(r"\{\{sortname\|([^}|]*)\|([^}|]*)(?:\|([^}]*?))?\}\}", lambda m: (m.group(3) or m.group(1) + " " + m.group(2)), s)
    s = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"^\s*(align|valign|bgcolor|rowspan|colspan)\b[^|]*\|", "", s)
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- sources ---
def src_currentaffairs(path):
    """The only COMPLETE name list (360 reps / 109 senators). No party column."""
    html = get("https://currentaffairs.ng/%s/" % path)
    out = []
    for row in re.finditer(r"<tr[^>]*>([\s\S]*?)</tr>", html):
        c = [clean(x.group(1)) for x in re.finditer(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row.group(1))]
        if len(c) < 3 or not c[0] or re.fullmatch(r"(senator|representative)", c[0], re.I):
            continue
        out.append({"name": c[0], "district": c[1], "state": c[2]})
    return out


def src_nass(chamber):
    """Party a member was ELECTED on. Incomplete and never tracks defections."""
    j = json.loads(get("https://nass.gov.ng/mps/get_legislators/?chamber=%d&draw=1&start=0&length=500" % chamber,
                       {"x-requested-with": "XMLHttpRequest", "referer": "https://nass.gov.ng/mps/senators"}))
    return [{"name": clean(r[0]), "state": clean(r[1]), "district": clean(r[2]),
             "party": clean(r[3]).upper()} for r in j["data"] if clean(r[0]) and clean(r[3])]


def src_wiki_house():
    """Wikipedia's per-state roster table. Covers Abia..Imo only, but current."""
    t = wikitext("List of members of the House of Representatives of Nigeria, 2023–2027")
    i = re.search(r"^==\s*Members\s*==", t, re.M).start()
    j = t.find("==References==", i)
    sec = t[i:j if j > 0 else len(t)]
    out, state = [], None
    for r in sec.split("\n|-"):
        cells = [c for c in re.split(r"\n\|", r) if c.strip()]
        si = next((n for n, c in enumerate(cells) if "rowspan" in c and "valign" in c), None)
        if si is not None:
            state = delink(cells[si])
        body = [c for n, c in enumerate(cells) if n != si]
        ni = next((n for n, c in enumerate(body) if "sortname" in c), None)
        if ni is None or ni == 0:
            continue
        party = next((p.group(1) for c in body[ni + 1:] if "party color" not in c
                      for p in [re.search(r"\|([A-Z]{2,5})\]\]", c)] if p), None)
        out.append({"state": state, "district": re.sub(r"\s*federal constituency\s*", "", delink(body[ni - 1]), flags=re.I),
                    "name": delink(body[ni]), "party": party})
    return [m for m in out if m["party"] in PARTIES]


def src_delegation(state):
    """`Nigerian National Assembly delegation from X` — 10th-Assembly section."""
    t = wikitext("Nigerian National Assembly delegation from %s" % state)
    if not t:
        return []
    m = re.search(r"==+[^=\n]*10th[^=\n]*==+", t)
    if not m:
        return []
    sec = t[m.end():]
    nxt = re.search(r"\n==[^=]", sec)
    sec = sec[:nxt.start()] if nxt else sec
    out, chamber = [], None
    for row in sec.split("\n|-"):
        cells = [delink(c) for c in re.split(r"\n\|", row) if c.strip()]
        cells = [c for c in cells if c and not re.fullmatch(r"#?[0-9a-fA-F]{3,8}", c)]
        for c in cells:
            if re.search(r"\bSenator\b", c):
                chamber = "senate"
            elif re.search(r"\bRepresentative\b", c):
                chamber = "house"
        pi = next((n for n, c in enumerate(cells) if c.strip().upper() in PARTIES), None)
        if pi is None or pi == 0 or not chamber:
            continue
        name, party = cells[pi - 1], cells[pi].strip().upper()
        district = cells[pi + 1] if pi + 1 < len(cells) else ""
        if not name or re.search(r"OFFICE|NAME|PARTY", name, re.I):
            continue
        out.append({"chamber": chamber, "state": state, "name": name,
                    "district": re.sub(r"\s*(federal constituency|senatorial district)\s*", "", district, flags=re.I).strip(),
                    "party": party})
    return out


def src_nigerianqueries():
    """The only COMPLETE House list carrying a party: one page, grouped by
    state, rows written `Name, PARTY - Constituency`. Party is as-elected."""
    body = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", get("https://nigerianqueries.com/names-of-reps-in-nigeria/")))
    body = body.replace("&#8211;", "-").replace("&amp;", "&").replace("–", "-").replace("—", "-")
    # Split on "<State> State Below is the full list" so each row inherits a state.
    # The heading runs on from the previous entry's constituency ("...Zaria Kano
    # State Below is the full list"), so resolve the state against the known
    # list rather than trusting whatever words precede " State".
    known = sorted(STATES, key=len, reverse=True)
    marks = []
    for m in re.finditer(r"([A-Z][A-Za-z ]+?)\s+State\s+Below is the full list", body):
        head = m.group(1).strip()
        st = next((s for s in known if head.lower().endswith(s.lower())), None)
        if st:
            marks.append((m.start(), st))
    out = []
    for n, (pos, state) in enumerate(marks):
        chunk = body[pos:marks[n + 1][0] if n + 1 < len(marks) else len(body)]
        # Entries run together with no delimiter — "...Ahoada East Nnam Obi
        # Prince Uchechuku, PDP - Ahoada West..." — so anchor on ", PARTY -"
        # and take the NAME as the words immediately before the comma. The
        # constituency's tail is unrecoverable (it blends into the next name),
        # so leave district empty and let the name join do the work; this is a
        # gap-filling source that only runs after the district-bearing ones.
        hits = [(m.start(), m.end(), m.group(1).upper())
                for m in re.finditer(r",\s*([A-Z]{2,5})\s*-\s*", chunk) if m.group(1).upper() in PARTIES]
        prev = 0
        for s, e, party in hits:
            words = re.findall(r"[A-Za-z][A-Za-z.'\-]*", chunk[prev:s])
            prev = e
            if len(words) < 2:
                continue
            out.append({"state": state, "name": " ".join(words[-3:]), "party": party, "district": ""})
    return out


def src_medianigeria(state):
    """2023 declared result. Senate only on these pages, but complete for it."""
    slug = state.lower().replace(" ", "-")
    html = get("https://www.medianigeria.com/%s-state-senate-and-house-of-representative-2023-election-winners/" % slug)
    out = []
    for m in re.finditer(r"<strong>\s*(.+?)\s*2023\s*Election\s*Winner\s*:?\s*</strong>\s*([^(<]+?)\s*\(([A-Za-z]{1,6})\)", html, re.I | re.S):
        cons, name, party = clean(m.group(1)), clean(m.group(2)), m.group(3).upper()
        if not cons or not name or party not in PARTIES:
            continue
        out.append({"chamber": "senate" if re.search(r"senatorial", cons, re.I) else "house",
                    "state": state,
                    "district": re.sub(r"\s*(federal constituency|senatorial districts?)\s*", "", cons, flags=re.I).strip(),
                    "name": re.sub(r"^(Senator|Sen\.|Hon\.)\s*", "", name, flags=re.I).strip(),
                    "party": party})
    return out


# ------------------------------------------------------------------ merge ---
class Lookup:
    """District first — it is unique per seat and both sides carry it. Name is
    the fallback and needs TWO shared tokens: a surname-only match once put the
    Deputy Senate President's ring on a different senator."""

    def __init__(self, rows):
        self.by_d = {}
        for r in rows:
            if nd(r.get("district")):
                self.by_d.setdefault(nd(r["district"]), r)
        self.by_n = [(r, tok(r["name"])) for r in rows]

    def find(self, m):
        hit = self.by_d.get(nd(m["district"]))
        if hit:
            return hit
        # Name fallback is scoped to the same state where both sides name one.
        # Nigeria reuses surnames heavily across states, and a cross-state
        # two-token match is a coin toss, not evidence.
        t = tok(m["name"])
        st = nd(m.get("state"))
        for r, rt in self.by_n:
            # State guard applies only to rows with no constituency of their own
            # (the run-together nigerianqueries list). Those rows carry stray
            # words from the neighbouring entry, so an unscoped two-token match
            # would happily land on the wrong member. Sources that DO carry a
            # district are left alone — their state spellings disagree ("FCT" vs
            # "Federal Capital Territory") and guarding them only loses matches.
            if not nd(r.get("district")) and st and nd(r.get("state")) and st != nd(r["state"]):
                continue
            if len(t & rt) >= 2:
                return r
        return None


def main():
    changes = json.load(open(CHANGES)) if os.path.exists(CHANGES) else {"changes": []}
    log = lambda *a: print(*a, file=sys.stderr)

    log("currentaffairs (names)...")
    spine = {"house": src_currentaffairs("rep"), "senate": src_currentaffairs("sen")}
    log("  house=%d senate=%d" % (len(spine["house"]), len(spine["senate"])))

    log("nass.gov.ng (elected party)...")
    nass = {"house": src_nass(2), "senate": src_nass(1)}
    log("  house=%d senate=%d" % (len(nass["house"]), len(nass["senate"])))

    log("wikipedia roster table...")
    wiki_h = src_wiki_house()
    log("  house=%d" % len(wiki_h))

    log("nigerianqueries (complete House list)...")
    try:
        nq = src_nigerianqueries()
    except Exception as e:
        nq = []
        log("  FAILED %s" % e)
    log("  house=%d" % len(nq))

    log("wikipedia state delegations + medianigeria...")
    deleg = {"house": [], "senate": []}
    media = {"house": [], "senate": []}
    for st in STATES:
        for fn, bucket in ((src_delegation, deleg), (src_medianigeria, media)):
            try:
                for r in fn(st):
                    bucket[r["chamber"]].append(r)
            except Exception:
                pass
    log("  delegation house=%d senate=%d | medianigeria house=%d senate=%d"
        % (len(deleg["house"]), len(deleg["senate"]), len(media["house"]), len(media["senate"])))

    # Most-current source wins. Each row records which one it came from, so a
    # disputed seat can be traced without re-running anything.
    ORDER = {"house": [("wikipedia", wiki_h), ("wikipedia-delegation", deleg["house"]),
                       ("nass.gov.ng", nass["house"]), ("nigerianqueries", nq),
                       ("medianigeria", media["house"])],
             "senate": [("wikipedia-delegation", deleg["senate"]), ("nass.gov.ng", nass["senate"]),
                        ("medianigeria", media["senate"])]}

    by_change = {}
    for c in changes.get("changes", []):
        by_change.setdefault(nd(c.get("district", "")), []).append(c)

    out, stats = {}, {}
    for ch in ("house", "senate"):
        looks = [(name, Lookup(rows)) for name, rows in ORDER[ch] if rows]
        members, srcs = [], collections.Counter()
        for s in spine[ch]:
            party = src = None
            fuller = s["name"]
            for name, lk in looks:
                hit = lk.find(s)
                if hit and hit.get("party") in PARTIES:
                    party, src = hit["party"], name
                    if len(hit["name"]) > len(fuller):
                        fuller = hit["name"]
                    break
            rec = {"name": fuller, "state": s["state"], "district": s["district"],
                   "party": party, "elected": party, "source": src}
            for c in by_change.get(nd(s["district"]), []):
                if party and c.get("from") and c["from"] != party:
                    continue
                rec["party"] = c["to"]
                rec["changed"] = {"from": party or c.get("from"), "to": c["to"],
                                  "date": c.get("date"), "source": c.get("source")}
                rec["source"] = "hawkeye"
            members.append(rec)
            srcs[src or "NONE"] += 1
        counts = collections.Counter(m["party"] for m in members if m["party"])
        out[ch] = {"size": 360 if ch == "house" else 109, "listed": len(members),
                   "withParty": sum(1 for m in members if m["party"]),
                   "parties": dict(counts.most_common()), "members": members}
        stats[ch] = srcs
        log("%s: %d/%d have a party  sources=%s" % (ch.upper(), out[ch]["withParty"], len(members), dict(srcs)))
        log("   parties: %s" % dict(counts.most_common()))

    doc = {
        "asOf": time.strftime("%Y-%m-%d"),
        "note": ("Hawkeye's own roster of the National Assembly. No single public source lists every "
                 "sitting member with a current party, so this merges all of them, records which source "
                 "produced each seat, and applies our own documented party changes on top. Seat counts "
                 "are derived from these members, so the chart and the names always agree."),
        "sources": [
            {"name": "currentaffairs.ng", "url": "https://currentaffairs.ng/rep/", "role": "complete name roster"},
            {"name": "National Assembly of Nigeria", "url": "https://nass.gov.ng/", "role": "party as elected"},
            {"name": "Wikipedia — House members 2023–2027", "url": "https://en.wikipedia.org/wiki/List_of_members_of_the_House_of_Representatives_of_Nigeria,_2023%E2%80%932027", "role": "current party, 16 states"},
            {"name": "Wikipedia — state delegations", "url": "https://en.wikipedia.org/wiki/Nigerian_National_Assembly_delegation_from_Kano", "role": "current party, per state"},
            {"name": "Media Nigeria — 2023 declared results", "url": "https://www.medianigeria.com/", "role": "2023 result, Senate"},
        ],
        "changesApplied": sum(1 for ch in out for m in out[ch]["members"] if m.get("changed")),
        "chambers": out,
    }
    json.dump(doc, open(OUT, "w"), indent=1)
    log("\nwrote %s (%d bytes), changes applied=%d" % (OUT, os.path.getsize(OUT), doc["changesApplied"]))
    for ch in out:
        miss = [m for m in out[ch]["members"] if not m["party"]]
        log("%s still missing party: %d" % (ch, len(miss)))
        for m in miss[:80]:
            log("   %-34s %-30s %s" % (m["name"][:33], m["district"][:29], m["state"]))


if __name__ == "__main__":
    main()

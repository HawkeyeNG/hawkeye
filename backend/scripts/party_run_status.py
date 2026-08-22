# -*- coding: utf-8 -*-
"""Where has the party-table run actually got to?

  python3 scripts/party_run_status.py [jsonl]

Counts outcomes over the whole output file and, separately, over the most
recent slice — a run that is failing NOW looks identical to one that failed an
hour ago if you only ever total the file.
"""
import json, sys, collections, os

path = sys.argv[1] if len(sys.argv) > 1 else 'storage/audit-osun2026/party_full.jsonl'
if not os.path.exists(path):
    print('no output file yet'); sys.exit(0)

lines = [l for l in open(path, encoding='utf-8') if l.strip()]
tot = collections.Counter()
recent = collections.Counter()
seen_ok, seen_any = set(), set()

for i, l in enumerate(lines):
    try:
        r = json.loads(l)
    except Exception:
        continue
    ok = isinstance(r.get('parties'), list) and len(r['parties']) > 0
    key = 'OK' if ok else (r.get('error') or 'no-reading')
    tot[key] += 1
    if i >= len(lines) - 300:
        recent[key] += 1
    f = os.path.basename(r.get('file', ''))
    seen_any.add(f)
    if ok:
        seen_ok.add(f)

print('%d records · %d distinct sheets · %d with a reading' % (len(lines), len(seen_any), len(seen_ok)))
print('\nwhole file:')
for k, v in tot.most_common(10):
    print('  %6d  %s' % (v, k))
print('\nlast %d records (is it failing NOW?):' % min(300, len(lines)))
for k, v in recent.most_common(10):
    print('  %6d  %s' % (v, k))

targets = 'storage/audit-osun2026/party_targets.json'
if os.path.exists(targets):
    want = {os.path.basename(x['file'] if isinstance(x, dict) else x)
            for x in json.load(open(targets, encoding='utf-8'))}
    print('\n%d of %d targeted sheets have a reading · %d still to go'
          % (len(seen_ok & want), len(want), len(want - seen_ok)))

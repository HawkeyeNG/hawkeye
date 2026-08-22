# -*- coding: utf-8 -*-
"""What are the MOST RECENT N records doing? Not the file total.

  python3 scripts/party_tail.py [n] [jsonl]

A run that recovered an hour ago and a run still failing look identical in a
whole-file tally. This looks only at the tail, which is where the answer is.
"""
import json, sys, os, collections

n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
path = sys.argv[2] if len(sys.argv) > 2 else 'storage/audit-osun2026/party_full.jsonl'
lines = [l for l in open(path, encoding='utf-8') if l.strip()][-n:]

c = collections.Counter()
for l in lines:
    try:
        r = json.loads(l)
    except Exception:
        continue
    ok = isinstance(r.get('parties'), list) and r['parties']
    c['OK' if ok else (r.get('error') or 'no-reading')] += 1

print('last %d records:' % len(lines))
for k, v in c.most_common():
    print('  %5d  %s' % (v, k))

print('\nlast 8 individually:')
for l in lines[-8:]:
    try:
        r = json.loads(l)
    except Exception:
        continue
    ok = isinstance(r.get('parties'), list) and r['parties']
    print('  %-20s %-22s %sms' % (os.path.basename(r.get('file', '')),
                                  'OK' if ok else (r.get('error') or 'no-reading'),
                                  r.get('ms')))

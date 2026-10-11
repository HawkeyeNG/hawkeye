#!/bin/bash
# Download INEC's 2027 FINAL LIST OF CANDIDATES PDFs into tmp/inec-2027/.
#
#   bash scripts/fetch_inec_lists.sh
#
# The first step of a refresh (see scripts/check_inec_lists.py for when one is
# due). Writes pdf/<name>, sources.tsv (name, bytes, sha256, url), press.txt
# (the pages the 2027 index links) and pulled.txt. The previous download is
# kept as pdf.prev/ so a refresh can be compared with what it replaces. Then:
#
#   python3 scripts/parse_inec_final_lists_2027.py tmp/inec-2027/pdf
#   python3 scripts/build_ballots_2027.py            # read the report, then --write
#
# INEC's TLS chain has been incomplete, hence -k: nothing is sent, and what
# comes back is checked by the parser, not trusted.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
D=tmp/inec-2027
B=https://www.inecnigeria.org
mkdir -p "$D"
[ -d "$D/pdf" ] && { rm -rf "$D/pdf.prev"; mv "$D/pdf" "$D/pdf.prev"; }
mkdir -p "$D/pdf"
page() { for i in 1 2 3 4 5; do out=$(curl -sk -m 60 -A 'Mozilla/5.0' "$1") && [ -n "$out" ] && { printf '%s' "$out"; return 0; }; sleep 6; done; return 1; }
page "$B/elections/2027-general-elections-update" > "$D/index.html" || { echo "could not read the 2027 index"; exit 1; }
grep -o '/press/[a-z0-9-]*' "$D/index.html" | sort -u > "$D/press.txt"
: > "$D/sources.tsv"
fail=0
while IFS= read -r p; do
  docs=$(page "$B$p" | grep -o 'href="/documents/[^"]*"' | sed 's/^href="//; s/"$//' | sort -u)
  [ -z "$docs" ] && { echo "NO DOCUMENT on $p"; fail=1; continue; }
  while IFS= read -r h; do
    f=$(basename "$h")
    u="$B$(printf '%s' "$h" | sed 's/ /%20/g')"
    ok=0
    for i in 1 2 3; do curl -sk -m 180 -A 'Mozilla/5.0' -o "$D/pdf/$f" "$u" && head -c 5 "$D/pdf/$f" | grep -q '%PDF' && { ok=1; break; }; sleep 5; done
    [ "$ok" = 1 ] || { echo "NOT A PDF: $u"; fail=1; continue; }
    printf '%s\t%s\t%s\t%s\n' "$f" "$(stat -c %s "$D/pdf/$f")" "$(sha256sum "$D/pdf/$f" | cut -c1-64)" "$u" >> "$D/sources.tsv"
  done <<< "$docs"
done < "$D/press.txt"
echo "pulled $(date -u +%FT%TZ)" > "$D/pulled.txt"
echo "pages $(wc -l < "$D/press.txt") · documents $(wc -l < "$D/sources.tsv") · $(du -sh "$D/pdf" | cut -f1)"
[ "$fail" = 0 ] || { echo "INCOMPLETE — do not parse this download"; exit 1; }

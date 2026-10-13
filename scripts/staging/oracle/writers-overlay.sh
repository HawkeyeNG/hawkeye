#!/bin/bash
# Several writer processes behind Caddy, with polite overload. STAGING ONLY.
#
# bootstrap.sh builds one writer and rewrites the Caddyfile and the writer unit on every redeploy;
# this turns that into several. Run it once by hand with the settings wanted: it records them in
# /etc/hawkeye/writers.conf, and from then on bootstrap.sh runs it again after each redeploy.
#
#   sudo install -m 0755 writers-overlay.sh /usr/local/sbin/hk-writers-overlay
#   sudo hk-writers-overlay 3              (JOURNAL=1 in front turns the report journal on)
#
# What the load tests of 13-14 Oct 2026 established (docs/private/ELECTION-NIGHT-HOSTING.md):
#
# - The ledger chain stays whole with several writers (the head is read inside the IMMEDIATE
#   transaction that inserts the report): verified after every run, no forks.
# - ONLY the report path is shared: POST /api/uploads/presign AND /api/submissions. The presign
#   step was first left out of the matcher, so one writer took every presign alone and every
#   multi-writer number before that fix understated capacity.
# - round_robin, not least_conn: a slow writer looks "busy" to least_conn and the others are
#   then loaded until all are full.
# - SQLITE_WAL_AUTOCHECKPOINT=0 on the request-path roles: otherwise the committing process runs
#   the checkpoint (two fsyncs) itself. The worker keeps SQLite's default.
# - POLITE OVERLOAD: a writer with 150 requests in flight is passed over; when all are, the
#   proxy answers 503 + Retry-After at once. Without it the writers' accept queues (511) filled,
#   the kernel dropped ~165,000 connections in a ten-minute run and reports waited 16-19 s to
#   fail. With it: no refused connection, no time-out, accepted reports back in ~4 s (p95).
# - THE CEILING IS LITESTREAM, not the writers: with it stopped three writers took the full
#   design rate (250 reports/s) with nothing refused; with it running, ~115-125/s, because it
#   holds SQLite's write lock ~13% of the time in 0.2-0.6 s stretches. monitor-interval 200ms
#   made that worse (21%, one hold of 9 s); Litestream 0.3.13 much worse (25%, holds to 20 s).
set -euo pipefail
# With no argument: what this host was last set to (bootstrap.sh calls it this way after a redeploy).
CONF=/etc/hawkeye/writers.conf
if [ $# -eq 0 ] && [ -f "$CONF" ]; then . "$CONF"; fi
N="${1:-${N:-3}}"
# 400: with 150 a healthy run at the design rate was refused 7% of the time; the accept queue is 511.
CAP="${WRITER_MAX_IN_FLIGHT:-400}"
RETRY_AFTER_S="${BUSY_RETRY_AFTER_S:-20}"
U=/etc/systemd/system
UP="127.0.0.1:8430"
[ "$N" -ge 1 ] && [ "$N" -le 9 ] || { echo "writers: 1 to 9"; exit 1; }

for n in $(seq 2 "$N"); do
  sed -e "s/PORT=8430/PORT=843$((n-1))/" \
      -e "s/HOST_ID=staging-writer/HOST_ID=staging-writer-$n/" \
      -e "s/^Description=.*/Description=Hawkeye writer $n (several writers)/" \
      -e 's/^After=hawkeye-prestart.service$/After=hawkeye-prestart.service hawkeye-writer.service/' \
      "$U/hawkeye-writer.service" > "$U/hawkeye-writer$n.service"
  UP="$UP 127.0.0.1:843$((n-1))"
done
for u in hawkeye-writer.service $(for n in $(seq 2 "$N"); do echo "hawkeye-writer$n.service"; done) hawkeye-reader@.service; do
  install -d "$U/$u.d"
  printf '[Service]\nEnvironment=SQLITE_WAL_AUTOCHECKPOINT=0\n' > "$U/$u.d/checkpoint.conf"
done
# JOURNAL=1: the writers keep the report journal (backend services/reportJournal.js) and ship it to the bucket.
for u in hawkeye-writer.service $(for n in $(seq 2 "$N"); do echo "hawkeye-writer$n.service"; done); do
  if [ "${JOURNAL:-}" = 1 ]; then printf '[Service]\nEnvironment=REPORT_JOURNAL=1\n' > "$U/$u.d/journal.conf"; else rm -f "$U/$u.d/journal.conf"; fi
done
systemctl daemon-reload

UP="$UP" CAP="$CAP" RETRY_AFTER_S="$RETRY_AFTER_S" python3 - <<'PY'
import os, re
p = '/etc/caddy/Caddyfile'
s = open(p).read()
s = re.sub(r"\t# SEVERAL WRITERS:[^\n]*\n\t@reports [^\n]*\n\thandle @reports \{\n.*?\n\t\}\n", "", s, flags=re.S)
s = re.sub(r"\t# EXPERIMENT:[^\n]*\n\t@reports [^\n]*\n\thandle @reports \{\n.*?\n\t\}\n", "", s, flags=re.S)
s = re.sub(r"\t# POLITE OVERLOAD:[^\n]*\n\thandle_errors \{\n.*?\n\t\}\n", "", s, flags=re.S)
writers = ("\t# SEVERAL WRITERS: the report path (presign AND submit) is shared; everything else stays on the first.\n"
           "\t@reports path /api/submissions /api/submissions/* /api/uploads/*\n"
           "\thandle @reports {\n"
           "\t\treverse_proxy " + os.environ['UP'] + " {\n"
           "\t\t\tlb_policy round_robin\n"
           "\t\t\tlb_try_duration 1s\n"
           "\t\t\tlb_try_interval 100ms\n"
           "\t\t\tunhealthy_request_count " + os.environ['CAP'] + "\n"
           "\t\t}\n"
           "\t}\n")
polite = ("\t# POLITE OVERLOAD: when the proxy cannot place a request, say so at once and say when to come back.\n"
          "\thandle_errors {\n"
          "\t\t@busy expression `{http.error.status_code} in [502, 503, 504]`\n"
          "\t\thandle @busy {\n"
          "\t\t\theader Retry-After " + os.environ['RETRY_AFTER_S'] + "\n"
          "\t\t\theader Content-Type application/json\n"
          # The Lite app calls from another origin: without these its WebView hides the 503 and
          # the outbox sees only "network error". The answer carries no data, so any origin may read it.
          "\t\t\theader Access-Control-Allow-Origin {http.request.header.Origin}\n"
          "\t\t\theader Access-Control-Allow-Credentials true\n"
          "\t\t\theader Access-Control-Expose-Headers Retry-After\n"
          "\t\t\theader Vary Origin\n"
          "\t\t\trespond `{\"error\":\"busy\",\"retryAfterS\":" + os.environ['RETRY_AFTER_S'] + "}` 503\n"
          "\t\t}\n"
          "\t}\n")
fallback = "\thandle {\n\t\treverse_proxy 127.0.0.1:8430\n\t}\n"
assert s.count(fallback) == 1, 'the fallback handle block was not found exactly once'
s = s.replace(fallback, writers + fallback)
i = s.index("\t@reads {")
s = s[:i] + polite + s[i:]
open(p, 'w').write(s)
PY
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "caddy config INVALID"; exit 1; }
systemctl reload hawkeye-caddy.service 2>/dev/null || systemctl restart hawkeye-caddy.service
for n in $(seq 2 "$N"); do systemctl restart "hawkeye-writer$n.service"; done
systemctl restart hawkeye-writer.service
printf 'N=%s\nWRITER_MAX_IN_FLIGHT=%s\nBUSY_RETRY_AFTER_S=%s\nJOURNAL=%s\n' "$N" "$CAP" "$RETRY_AFTER_S" "${JOURNAL:-}" > "$CONF"
echo "writers: $N ($UP) | at most $CAP in flight each | busy answer: 503, Retry-After ${RETRY_AFTER_S}s | journal: ${JOURNAL:-off}"

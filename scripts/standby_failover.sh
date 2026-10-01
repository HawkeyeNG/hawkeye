#!/usr/bin/env bash
# Hawkeye WARM STANDBY — point Cloudflare at the standby, and back.
#
#   scripts/standby_failover.sh status              read-only: records, who answers, standby health
#   scripts/standby_failover.sh verify              read-only: the token is active (/user/tokens/verify)
#   scripts/standby_failover.sh origin-cert --yes   issue a Cloudflare Origin CA cert for the standby from its
#                                                   CSR (the private key never leaves the host) and install it;
#                                                   needs the token permission Zone:SSL and Certificates:Edit
#   scripts/standby_failover.sh to-standby          dry run: what would change
#   scripts/standby_failover.sh to-standby --yes    flip every PROXIED A/AAAA record that points at the primary
#   scripts/standby_failover.sh to-primary [--yes]  flip them back (refused while the standby is a promoted
#                                                   primary, until its DB is back on GO54: --db-copied-back)
#
# WHAT A FLIP DOES. Only the SITE hostnames move — FLIP_NAMES, default
# "hawkeye.com.ng www.hawkeye.com.ng" — and only while proxied and pointing at the
# primary's origin. Everything else stays on GO54: mail/smtp/pop/ftp (also proxied
# A records on the primary today) and every DNS-only record, so webmail and mail
# keep working and no record ever publishes the standby's address.
# Proxied records take effect in seconds (no TTL wait). Before the first flip the
# primary's records are saved to ~/.config/hawkeye/standby_failover.json (0600) and
# to-primary restores exactly those. Addresses are never printed.
#
# THE STANDBY SERVES READ-ONLY (STANDBY=1): pages, boards, results, ledger, maps
# from the newest verified snapshot; every write answers 503 + Retry-After so the
# apps keep reports in their outboxes and send them when the primary is back.
# Nothing is merged, so failing back is just to-primary. A FULL promotion (writes
# on) is a separate, fenced, manual step on the host: hawkeye-standby-mode
# promote-full — scripts/standby/README.md "Full promotion".
#
# TOKEN: ~/.config/hawkeye/cf_failover.env, CF_FAILOVER_TOKEN=... (mode 600). A
# Cloudflare USER API token (My Profile -> API Tokens; this account's Account API
# token page offered no zone permissions) limited to the zone hawkeye.com.ng with
# Zone:DNS:Edit + Zone:Zone:Read. Add Zone:Zone Settings:Read and the script also
# reads the SSL mode. Read in-process by Python; never printed, never in argv.
set -euo pipefail
exec python3 - "$@" <<'PY'
import json, os, random, subprocess, sys, time, urllib.error, urllib.request

ZONE = os.environ.get("ZONE_NAME", "hawkeye.com.ng")
HOME = os.path.expanduser("~")
CONF_DIR = f"{HOME}/.config/hawkeye"
TOKF = os.environ.get("CF_FAILOVER_TOKEN_FILE", f"{CONF_DIR}/cf_failover.env")
SCONF = os.environ.get("HAWKEYE_STANDBY_CONF", f"{CONF_DIR}/standby.env")
STATE = f"{CONF_DIR}/standby_failover.json"
API = "https://api.cloudflare.com/client/v4"
STANDBY_HOST_ID = "oci-standby"   # HOST_ID in /etc/hawkeye/standby.env on the standby
FLIP_NAMES = set(os.environ.get("FLIP_NAMES", f"{ZONE} www.{ZONE}").split())

def die(m): print(f"standby_failover: {m}", file=sys.stderr); sys.exit(2)
def say(m): print(f"standby_failover: {m}", flush=True)

def parse_env(path):
    out = {}
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out

args = sys.argv[1:]
cmd = args[0] if args else "status"
flags = set(args[1:])
for f in flags:
    if f not in ("--yes", "--db-copied-back", "--force-tls"): die(f"unknown option {f}")
YES = "--yes" in flags

if not os.path.exists(SCONF): die(f"missing {SCONF}")
sc = parse_env(SCONF)
SHOST = sc.get("STANDBY_HOST") or die("STANDBY_HOST missing")
SUSER = sc.get("STANDBY_USER", "ubuntu")
SKEY = os.path.expanduser(sc.get("STANDBY_SSH_KEY", "~/.ssh/hawkeye_oracle"))

if not os.path.exists(TOKF): die(f"no token file {TOKF} (the owner creates it; see scripts/standby/README.md)")
if os.stat(TOKF).st_mode & 0o077: die(f"{TOKF} must not be readable by group/others (chmod 600)")
TOKEN = parse_env(TOKF).get("CF_FAILOVER_TOKEN") or die("CF_FAILOVER_TOKEN is empty")

def cf(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        try: return json.load(e)
        except Exception: return {"success": False, "errors": [{"code": e.code, "message": str(e.reason)}]}

def rssh(command):
    p = subprocess.run(["ssh", "-i", SKEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
                        f"{SUSER}@{SHOST}", command], capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr)

def edge_health():
    url = f"https://{ZONE}/api/health?cb={random.randrange(10**9)}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "hawkeye-failover"}), timeout=15) as r:
            h = json.load(r)
        return {k: h.get(k) for k in ("host", "role", "readOnly", "standby", "gitSha")}
    except Exception as e:
        return {"error": str(e)[:120]}

def origin_probe(ip):
    """One HTTPS request to an origin with SNI/Host = the zone; no secrets sent.
    Through the origin lock a 403 'origin_locked' proves Node is up."""
    p = subprocess.run(["curl", "-sk", "--max-time", "20", "-o", "-", "-w", "\n%{http_code}",
                        "--resolve", f"{ZONE}:443:{ip}", f"https://{ZONE}/api/health"], capture_output=True, text=True)
    body, _, code = p.stdout.rpartition("\n")
    return code.strip(), body

if cmd == "origin-cert":
    rc, csr = rssh("sudo cat /etc/hawkeye/tls/origin.csr")
    if rc != 0 or "BEGIN CERTIFICATE REQUEST" not in csr: die("cannot read /etc/hawkeye/tls/origin.csr on the standby (run standby_sync.sh --setup)")
    csr = csr[csr.index("-----BEGIN"):]
    if not YES: say(f"dry run: would issue an Origin CA cert for {ZONE} and *.{ZONE} (15 years) from the standby's CSR and install it — add --yes"); sys.exit(0)
    r = cf("POST", "/certificates", {"hostnames": [ZONE, f"*.{ZONE}"], "requested_validity": 5475, "request_type": "origin-rsa", "csr": csr})
    if not r.get("success"): die(f"Origin CA issue failed: {r.get('errors')} — the token needs Zone:SSL and Certificates:Edit on {ZONE}")
    p = subprocess.run(["ssh", "-i", SKEY, "-o", "BatchMode=yes", f"{SUSER}@{SHOST}", "sudo /usr/local/sbin/hawkeye-standby-mode install-origin-cert"],
                       input=r["result"]["certificate"], capture_output=True, text=True)
    print(p.stdout + p.stderr); sys.exit(p.returncode)

if cmd == "verify":
    r = cf("GET", "/user/tokens/verify")
    say(f"token: success={r.get('success')} status={(r.get('result') or {}).get('status')} errors={r.get('errors')}")
    sys.exit(0 if r.get("success") else 1)

z = cf("GET", f"/zones?name={ZONE}")
if not z.get("success") or not z.get("result"): die(f"cannot read zone {ZONE} (needs Zone:Zone:Read): {z.get('errors')}")
ZID = z["result"][0]["id"]
recs = cf("GET", f"/zones/{ZID}/dns_records?per_page=500")
if not recs.get("success"): die(f"cannot list DNS records: {recs.get('errors')}")
RECORDS = recs["result"]
s = cf("GET", f"/zones/{ZID}/settings/ssl")
SSLMODE = s["result"]["value"] if s.get("success") else "unknown (token lacks Zone Settings:Read)"

state = json.load(open(STATE)) if os.path.exists(STATE) else None
if state: PRIMARY_IP = state["primaryIp"]
else:
    apex = [r for r in RECORDS if r["type"] == "A" and r["name"] == ZONE]
    PRIMARY_IP = apex[0]["content"] if apex else None
if not PRIMARY_IP: die("cannot tell the primary's origin (no apex A record, no state file)")
if PRIMARY_IP == SHOST: die(f"the primary origin IS the standby address — refusing (inspect {STATE})")

def on(ip): return [r for r in RECORDS if r["type"] in ("A", "AAAA") and r["content"] == ip]
ON_PRIMARY, ON_STANDBY = on(PRIMARY_IP), on(SHOST)
def flippable(r): return r["proxied"] and r["name"] in FLIP_NAMES
TO_FLIP = [r for r in ON_PRIMARY if flippable(r)]
def show(rs):
    if not rs: print("    (none)")
    for r in rs:
        why = "FLIPS" if flippable(r) else ("stays (DNS-only)" if not r["proxied"] else "stays (not a site hostname)")
        print(f"    {r['type']} {r['name']} {'proxied' if r['proxied'] else 'DNS-only'} id={r['id'][:8]}  {why}")

def save_state():
    if os.path.exists(STATE): return
    host = edge_health().get("host")
    old = os.umask(0o077)
    try:
        json.dump({"primaryIp": PRIMARY_IP, "primaryHostId": host, "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "records": [{k: r[k] for k in ("id", "type", "name", "content", "proxied")} for r in TO_FLIP]},
                  open(STATE, "w"), indent=1)
    finally: os.umask(old)
    say(f"saved the primary's records to {STATE}")

def patch(rs, ip, label):
    n = 0
    for r in rs:
        if not r["proxied"]: continue
        out = cf("PATCH", f"/zones/{ZID}/dns_records/{r['id']}", {"content": ip})
        if not out.get("success"): die(f"  PATCH {r['name']} failed: {out.get('errors')} — run status; some records may already be flipped")
        say(f"  {r['name']} -> {label}"); n += 1
    say(f"{n} record(s) changed")

def wait_edge(host_id):
    last = None
    for _ in range(45):
        last = edge_health().get("host")
        if last and last == host_id: say(f"the edge now answers from host '{last}'"); return True
        time.sleep(2)
    say(f"WARNING: the edge has not shown host '{host_id}' yet (last: {last!r}); check: status"); return False

if cmd == "status":
    say(f"zone {ZONE}, SSL mode: {SSLMODE}")
    say("records on the PRIMARY origin:"); show(ON_PRIMARY)
    say("records on the STANDBY origin:"); show(ON_STANDBY)
    say(f"the edge answers: {json.dumps(edge_health())}")
    rc, out = rssh("sudo hawkeye-standby-mode health; sudo hawkeye-standby-mode status | grep -E '^(mode|serving|prod env|egress|tls cert)'")
    say("standby (direct, over ssh):"); print("\n".join("    " + l for l in out.strip().splitlines()))
    sys.exit(0)

if cmd == "to-standby":
    if not TO_FLIP: die(f"none of {sorted(FLIP_NAMES)} is a proxied record on the primary — already flipped? (status)")
    say("preflight: the standby must answer, read-only, with a database")
    rc, out = rssh("sudo hawkeye-standby-mode health && sudo hawkeye-standby-pull --status | head -3")
    print("\n".join("    " + l for l in out.strip().splitlines()))
    if rc != 0 or '"ok":true' not in out: die("the standby's /api/health does not answer — not flipping")
    if "installed: none" in out: die("the standby has no database installed — not flipping")
    rc, cert = rssh("sudo openssl x509 -in /etc/hawkeye/tls/origin.crt -noout -issuer")
    if SSLMODE == "strict" and "cloudflare" not in cert.lower() and "--force-tls" not in flags:
        die("SSL mode is Full (strict) and the standby has no Cloudflare Origin CA cert — Cloudflare would answer 526. README 'Origin certificate' (--force-tls overrides)")
    if SSLMODE.startswith("unknown") and "cloudflare" not in cert.lower():
        say("WARNING: SSL mode unreadable with this token. If it is Full (strict) the edge will answer 526 until the Origin CA cert is installed; to-primary undoes the flip in seconds.")
    say("records on the primary (only FLIPS move):"); show(ON_PRIMARY)
    if not YES: say("dry run — add --yes to flip"); sys.exit(0)
    save_state()
    rssh("sudo hawkeye-standby-mode serving on")
    patch(TO_FLIP, SHOST, "standby")
    wait_edge(STANDBY_HOST_ID)
    say(f"edge: {json.dumps(edge_health())}")
    say("DONE. The site is served READ-ONLY by the standby. Back: scripts/standby_failover.sh to-primary --yes")
    sys.exit(0)

if cmd == "to-primary":
    if not state: die(f"no {STATE}: nothing was flipped by this script")
    rc, _ = rssh("test -f /etc/hawkeye/promoted.env")
    if rc == 0 and "--db-copied-back" not in flags:
        die("REFUSED: the standby is a PROMOTED PRIMARY and has taken writes. Fail-back first copies its DB to GO54 (README 'Fail-back'), then: to-primary --yes --db-copied-back")
    say("preflight: the primary origin must answer (a 403 'origin_locked' proves Node is up)")
    code, body = origin_probe(PRIMARY_IP)
    if code == "200" or (code == "403" and "origin_locked" in body): say(f"  primary origin answers ({code})")
    elif os.environ.get("FORCE_PRIMARY") == "1": say(f"  primary origin answered {code}; FORCE_PRIMARY=1, continuing")
    else: die(f"  the primary origin answered HTTP {code} — not flipping back (FORCE_PRIMARY=1 overrides)")
    saved = {r["id"] for r in state["records"]}
    back = [r for r in RECORDS if r["id"] in saved and r["content"] == SHOST]
    say("would move back to the primary:"); show(back)
    if not YES: say("dry run — add --yes to flip back"); sys.exit(0)
    patch(back, PRIMARY_IP, "primary")
    if state.get("primaryHostId"): wait_edge(state["primaryHostId"])
    rssh("sudo hawkeye-standby-mode serving off")
    say(f"edge: {json.dumps(edge_health())}")
    os.rename(STATE, STATE + time.strftime(".%Y%m%dT%H%M%SZ.done", time.gmtime()))
    say("DONE. The primary serves again; the standby is back to hourly pulls.")
    sys.exit(0)

die(f"unknown command {cmd} (status | verify | origin-cert | to-standby | to-primary)")
PY

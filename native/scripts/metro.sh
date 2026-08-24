#!/usr/bin/env bash
# Start Metro and print the URL to type into the dev client.
#
#   native/scripts/metro.sh
#
# WHY THIS EXISTS. Metro on WSL2 (NAT) binds a WSL-internal 172.28.x address the
# phone cannot reach. Two Windows-side pieces bridge it — a portproxy on 8081 and
# an inbound firewall rule — and BOTH have a moving part:
#
#   - the WSL IP changes when WSL restarts, which strands the portproxy's target
#   - the Windows Wi-Fi DHCP lease changes, which strands the person typing the
#     URL into their phone
#
# The second one cost a day: the lease moved from .200 to .198, the address in
# everyone's head kept pointing at nothing, and "Metro doesn't work" is what that
# looks like from the phone. Neither failure announces itself, so this checks
# both and says which one is wrong.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

say()  { printf '  %s\n' "$1"; }
warn() { printf '\033[1;33m  %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

WSL_IP=$(hostname -I | tr ' ' '\n' | grep -E '^172\.28\.' | head -1)
[ -n "$WSL_IP" ] || die "no 172.28.x address on this WSL instance"
say "wsl ip      : $WSL_IP"

# The Windows LAN address, asked of Windows rather than guessed. WSL interop lets
# us run the Windows PowerShell directly; \r has to go, it comes back CRLF.
LAN_IP=$(powershell.exe -NoProfile -Command \
  "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.InterfaceAlias -eq 'Wi-Fi' -and \$_.PrefixOrigin -eq 'Dhcp' }).IPAddress" \
  2>/dev/null | tr -d '\r' | head -1)
[ -n "$LAN_IP" ] || warn "could not read the Wi-Fi address from Windows — is Wi-Fi up?"

# Does the portproxy still point at THIS WSL instance?
TARGET=$(netsh.exe interface portproxy show v4tov4 2>/dev/null | tr -d '\r' \
  | awk '/^0\.0\.0\.0 *8081/ { print $3 }' | head -1)
if [ -z "$TARGET" ]; then
  warn "no portproxy on 8081. In an ELEVATED PowerShell:"
  warn "  netsh interface portproxy add v4tov4 listenport=8081 listenaddress=0.0.0.0 connectport=8081 connectaddress=$WSL_IP"
elif [ "$TARGET" != "$WSL_IP" ]; then
  warn "portproxy points at $TARGET but WSL is now $WSL_IP. In an ELEVATED PowerShell:"
  warn "  netsh interface portproxy set v4tov4 listenport=8081 listenaddress=0.0.0.0 connectport=8081 connectaddress=$WSL_IP"
else
  say "portproxy   : 8081 -> $TARGET (current)"
fi

if ss -tln | grep -q ':8081'; then
  say "metro       : already listening"
else
  : > /tmp/mt.log
  # setsid, because a plain `&` inside `wsl.exe bash -lc` dies with the launcher.
  setsid nohup npx expo start --dev-client --host lan > /tmp/mt.log 2>&1 < /dev/null &
  disown 2>/dev/null
  for _ in $(seq 1 60); do
    ss -tln | grep -q ':8081' && break
    sleep 1
  done
  ss -tln | grep -q ':8081' || { tail -20 /tmp/mt.log; die "metro did not come up"; }
  say "metro       : started"
fi

# The end-to-end check, from OUTSIDE wsl — the only one that proves the path the
# phone takes. Curling localhost from in here would pass even with the bridge
# down, which is precisely the failure being looked for.
if [ -n "$LAN_IP" ]; then
  OK=$(powershell.exe -NoProfile -Command \
    "try { (Invoke-WebRequest -Uri 'http://$LAN_IP:8081/status' -TimeoutSec 8 -UseBasicParsing).StatusCode } catch { 0 }" \
    2>/dev/null | tr -d '\r' | head -1)
  if [ "$OK" = "200" ]; then
    printf '\n\033[1;32m  Type this into the dev client:  http://%s:8081\033[0m\n\n' "$LAN_IP"
  else
    warn "Metro is up but http://$LAN_IP:8081/status is not answering from Windows."
    warn "Check the inbound firewall rule (\"WSL Metro\", TCP 8081) and the portproxy above."
  fi
fi

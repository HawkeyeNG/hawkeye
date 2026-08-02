#!/bin/bash
# Start Metro so the QR code points at an address the PHONE can actually reach.
#
# The phone cannot see WSL's internal IP (172.x), so Metro must advertise the
# WINDOWS Wi-Fi IP and Windows must forward 8081 into WSL. Both of those drift:
# the Wi-Fi address is DHCP (it moved .198 -> .199 and every QR scan failed with
# "host unreachable" until this script was written), and WSL's internal IP changes
# whenever WSL restarts. Hardcoding either is why this broke silently for days.
#
# So detect both every launch, fix the portproxy if it is stale, then start Metro.
set -e
cd "$(dirname "$0")/.."

# -PrefixOrigin Dhcp as a PARAMETER, not a Where-Object pipeline: a $_ inside the
# -Command string does not survive the bash/WSL quoting layers and silently
# yielded an empty IP. Link-local 169.254.* is filtered on the bash side.
WIN_IP=$(powershell.exe -NoProfile -Command \
  "Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp | Select-Object -ExpandProperty IPAddress" \
  2>/dev/null | tr -d '\r' | grep -v '^169\.254\.' | grep -E '^[0-9]+\.' | head -1)
WSL_IP=$(hostname -I | awk '{print $1}')

if [ -z "$WIN_IP" ]; then
  echo "Could not read the Windows Wi-Fi IP. Is Wi-Fi up?" >&2
  exit 1
fi

echo "Windows LAN IP : $WIN_IP   (this is what the QR will encode)"
echo "WSL internal IP: $WSL_IP   (portproxy forwards 8081 here)"

# Is the existing portproxy still pointing at the right WSL IP?
CURRENT=$(netsh.exe interface portproxy show all 2>/dev/null | tr -d '\r' | awk '$2==8081 {print $3}' | head -1)
if [ "$CURRENT" != "$WSL_IP" ]; then
  cat <<EOF

  Portproxy is stale (points at '${CURRENT:-nothing}', WSL is now $WSL_IP).
  Run this ONCE in an ELEVATED PowerShell, then re-run this script:

    netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=0.0.0.0
    netsh interface portproxy add v4tov4 listenport=8081 listenaddress=0.0.0.0 connectport=8081 connectaddress=$WSL_IP

EOF
  exit 1
fi

echo "Portproxy OK. Verify from your phone's browser: http://$WIN_IP:8081/status"
echo
export REACT_NATIVE_PACKAGER_HOSTNAME="$WIN_IP"
exec npx expo start --dev-client --lan "$@"

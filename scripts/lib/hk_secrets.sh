# shellcheck shell=bash
# Read a secret file from 1Password, falling back to the copy on disk.
#
#   . "$REPO/scripts/lib/hk_secrets.sh"
#   CONF=$(hk_secret_path standby.env "$HOME/.config/hawkeye/standby.env")
#   . "$CONF"
#
# The secret lives as a DOCUMENT item, titled exactly like the file, in the
# 1Password vault "Infrastructure" (team account teamhawkeye). `op.exe` is the
# Windows 1Password CLI reached through WSL interop; the owner approves each new
# session with Windows Hello, and the value goes straight into the script — it
# is never printed.
#
# WHERE THE COPY GOES: /dev/shm (RAM, never disk), a 0700 directory, file 0600.
# Copies older than 10 minutes are swept on every call, because a script that
# `exec`s (standby_failover.sh) never runs an EXIT trap.
#
# FALLS BACK TO THE FILE — never fails — when 1Password is not there or does not
# answer: op.exe missing, HAWKEYE_NO_OP=1 (scheduled jobs: nobody is awake to
# approve), the prompt is declined, or 120 s pass. The fallback is said once on
# stderr so a run shows which source it used.
hk_secret_path() {
  local doc="$1" fallback="$2" dir tmp op
  # ~/.local/bin is on PATH only for login shells; scripts and agents run without one.
  op=$(command -v op.exe 2>/dev/null || { [ -x "$HOME/.local/bin/op.exe" ] && echo "$HOME/.local/bin/op.exe"; } || true)
  if [ -z "${HAWKEYE_NO_OP:-}" ] && [ -n "$op" ]; then
    dir="/dev/shm/hawkeye-op-$(id -u)"
    mkdir -p "$dir" && chmod 700 "$dir"
    find "$dir" -type f -mmin +10 -delete 2>/dev/null || true
    tmp=$(mktemp "$dir/${doc//[^A-Za-z0-9._-]/_}.XXXXXX") || tmp=""
    if [ -n "$tmp" ]; then
      chmod 600 "$tmp"
      if timeout 120 "$op" document get "$doc" --vault Infrastructure > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
        sed -i 's/\r$//' "$tmp"
        echo "secrets: $doc from 1Password" >&2
        printf '%s\n' "$tmp"
        return 0
      fi
      rm -f "$tmp"
    fi
    echo "secrets: $doc — 1Password did not answer; using $fallback" >&2
  fi
  printf '%s\n' "$fallback"
}

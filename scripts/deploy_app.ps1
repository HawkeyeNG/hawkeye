# Windows-side deploy. Use scripts/deploy_app.sh instead whenever WSL works.
#
#   powershell -File scripts\deploy_app.ps1 -Files app/race.js,app/sw.js
#   powershell -File scripts\deploy_app.ps1 -Files backend/src/routes/push.js `
#              -RemotePath /hawkeye/backend/src/routes -Restart
#
# WHY THIS EXISTS. On 2026-08-25 the WSL service started failing every exec with
# "Catastrophic failure / Wsl/Service/E_UNEXPECTED" while the VM itself kept
# running (Metro still answered on 8081, and \\wsl.localhost still served
# files). So the repo was readable and the canonical deploy script was
# unrunnable, with a deploy pending.
#
# Running deploy_app.sh through Git Bash instead does NOT work, and fails in a
# way worth knowing: Git Bash hands curl.exe a UNC working directory, Windows
# programs cannot have one, so every "-F file1=@relative/path" fails to open
# before a connection is made. The symptom is five upload attempts and a "no
# such file" for the response body -- with no request ever reaching the host.
# (Which at least means a failed run here does not count against the never-burst
# rule below.)
#
# It keeps the shell script's three guarantees, which is the point of mirroring
# it rather than hand-rolling uploads:
#
#   - ONE FILE PER REQUEST. A batched POST that drops mid-transfer makes
#     DirectAdmin write a TRUNCATED file and still answer "Upload successful".
#     That is how app/menu.js once landed as 0 bytes across the whole site.
#   - VERIFY BY RE-FETCH. That failure is silent -- error=0 in the body, a broken
#     file on disk -- so nothing short of re-reading the served bytes catches it.
#     HTML comes back a few hundred bytes larger because the host injects into
#     HTML responses, so this is a not-truncated test, not an equality test.
#   - AT MOST TWO ATTEMPTS, PACED. The shell script retries five times; the
#     standing rule is never to burst this API. Repeated rapid calls once tripped
#     the host's intrusion prevention and cost days of blocked panel access.
#
# ORDER MATTERS ON A SHELL DEPLOY: upload sw.js LAST. Its CACHE bump makes every
# installed client re-fetch the SHELL, so a service worker that lands before the
# assets caches the OLD ones under the NEW version -- and nothing bumps again to
# correct it.
#
# Credentials reach curl through a config file, never the command line, so they
# are not in the process table.
#
# ASCII ONLY. Windows PowerShell 5.1 reads a script as ANSI, so a UTF-8 em dash
# arrives as three bytes of mojibake and takes the parser apart mid-string.
param(
  [Parameter(Mandatory = $true)][string[]]$Files,
  [string]$RemotePath = "/hawkeye/app",
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$api  = "https://da32.host-ww.net:2222/CMD_API_FILE_MANAGER"
$site = "https://hawkeye.com.ng"

$envText = Get-Content (Join-Path $repo "backend\.env") -Raw
$u = ([regex]::Match($envText, '(?m)^GO54_USERNAME=(.+?)\s*$')).Groups[1].Value
$p = ([regex]::Match($envText, '(?m)^GO54_PASSWORD=(.+?)\s*(?:#.*)?$')).Groups[1].Value
if (-not $u -or -not $p) { Write-Output "GO54 credentials not readable from backend/.env"; exit 1 }

$cfg  = Join-Path $env:TEMP ("da_" + [guid]::NewGuid().ToString('N') + ".cfg")
$body = Join-Path $env:TEMP ("da_body_" + [guid]::NewGuid().ToString('N') + ".txt")
Set-Content -Path $cfg -Value ('user = "' + $u + ':' + $p + '"') -Encoding ascii

function Upload([string]$rel, [string]$dest) {
  $abs = Join-Path $repo $rel.Replace('/', '\')
  $bytes = (Get-Item $abs).Length
  # TIMEOUT SCALES WITH SIZE. A flat cap silently truncates anything big: curl
  # aborts mid-transfer and DirectAdmin writes the bytes that arrived, so the
  # upload "succeeds" and the file is corrupt. That is how a 31.6 MB APK on the
  # download page became an 11 MB file that could not install.
  $maxt = 180 + [int]($bytes / 17476)
  foreach ($try in 1..2) {
    & curl.exe -sk -K $cfg -m $maxt -o $body -F "action=upload" -F "path=$dest" -F "file1=@$abs" $api 2>$null | Out-Null
    $code = $LASTEXITCODE
    $out = if (Test-Path $body) { Get-Content $body -Raw } else { "" }
    if ($code -eq 0 -and $out -match 'error=0') { return $true }
    if ($try -eq 1) { Start-Sleep -Seconds 6 }
  }
  return $false
}

function Verify([string]$rel) {
  if (-not $rel.StartsWith("app/")) { return 2 }   # backend files are not web-served
  $web = $rel.Substring(4)
  $local = (Get-Item (Join-Path $repo $rel.Replace('/', '\'))).Length
  foreach ($try in 1..2) {
    try {
      $r = Invoke-WebRequest -Uri ($site + "/" + $web + "?v=" + (Get-Random)) -TimeoutSec 60 -UseBasicParsing
      $live = $r.RawContentLength
      if ($live -lt 1) { $live = $r.Content.Length }
      if ($live -ge [int]($local * 0.9)) { return 0 }
      if ($try -eq 2) { Write-Output ("      live=" + $live + " local=" + $local) }
    } catch {
      if ($try -eq 2) { Write-Output ("      fetch failed: " + $_.Exception.Message) }
    }
    Start-Sleep -Seconds 4
  }
  return 1
}

$ok = 0
$failed = @()
foreach ($f in $Files) {
  $abs = Join-Path $repo $f.Replace('/', '\')
  if (-not (Test-Path $abs)) { Write-Output ("  MISSING   " + $f); $failed += $f; continue }
  if (-not (Upload $f $RemotePath)) { Write-Output ("  UPLOAD FAILED  " + $f); $failed += $f; continue }
  $rc = Verify $f
  if ($rc -eq 0) {
    Write-Output ("  ok        " + $f); $ok++
  } elseif ($rc -eq 2) {
    Write-Output ("  ok*       " + $f + "  (not web-served, accepted but unverified)"); $ok++
  } else {
    Write-Output ("  TRUNCATED " + $f + " - re-uploading once")
    if ((Upload $f $RemotePath) -and ((Verify $f) -eq 0)) {
      Write-Output ("      recovered " + $f); $ok++
    } else { $failed += $f }
  }
  Start-Sleep -Seconds 2                     # pace: bursts get throttled
}

if ($Restart) {
  # The nodejs_selector restart API often silently fails; dropping a file into
  # backend/tmp makes Passenger restart on the next request, which is reliable.
  $rf = Join-Path $env:TEMP "restart.txt"
  Set-Content -Path $rf -Value ([string][int](Get-Date -UFormat %s)) -Encoding ascii
  & curl.exe -sk -K $cfg -m 120 -o $body -F "action=upload" -F "path=/hawkeye/backend/tmp" -F "file1=@$rf" $api 2>$null | Out-Null
  Write-Output "  restart triggered - waiting 20s"
  Start-Sleep -Seconds 20
  try {
    $h = (Invoke-WebRequest ($site + "/api/health") -TimeoutSec 25 -UseBasicParsing).Content
    Write-Output ("  health: " + $h)
  } catch { Write-Output ("  health check failed: " + $_.Exception.Message) }
  Remove-Item $rf -ErrorAction SilentlyContinue
}

Remove-Item $cfg -ErrorAction SilentlyContinue
Remove-Item $body -ErrorAction SilentlyContinue
Write-Output ("deployed " + $ok + "/" + $Files.Count)
# A BACKEND FILE REPORTS ok* AND THAT IS NOT PROOF. Verify a route by probing it:
# 401 means it exists and refused you, 404 means it is still missing, and a
# known-absent path is the control that proves the probe discriminates.
if ($failed.Count -gt 0) { Write-Output ("FAILED: " + ($failed -join ' ')); exit 1 }

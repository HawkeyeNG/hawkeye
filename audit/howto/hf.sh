#!/bin/bash
# hf.sh <project-dir> <check|render> — run HyperFrames check or render on a how-to.
export PATH="$HOME/.local/bin:$PATH"
export HYPERFRAMES_BROWSER_PATH="$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
DIR="$1"; CMD="$2"
cd "$DIR" || exit 1
if [ "$CMD" = "render" ]; then
  # DO NOT add --low-memory-mode here. It was tried as a fix for the crashes
  # below and made them worse: pinned to one worker with screenshot capture it
  # died at frame 122, where default workers reached 141. The render that has
  # actually succeeded on this box (the OTP how-to, 1156 frames) used the
  # default worker count, so stay on that path.
  #
  # --no-browser-gpu forces SwiftShader. The default PROBES for a host GPU and
  # falls back only if it finds none — under WSL that probe can half-succeed and
  # Chrome dies mid-capture. This HELPS (frame 44 -> 141) but on long clips it
  # is not sufficient on its own: Chrome still dies every ~60-110s of capture,
  # retries, and never recovers. Not memory (9 GB free, no OOM kills), not disk,
  # not assets. A ~1150-frame clip renders; ~1380 does not. If a long one will
  # not finish, restart WSL first, then consider --docker.
  #
  # The timeouts are raised for the same reason: one worker doing all the frames
  # can exceed the 5-minute CDP default on a long clip.
  # Full log kept — `| tail -6` hid the audio diagnostics that explained an
  # earlier failure, and by then the temp dirs holding the detail were gone.
  npx -y hyperframes render --quality high --output out.mp4 \
    --no-browser-gpu \
    --protocol-timeout 900000 --player-ready-timeout 120000 \
    2>&1 | tee /tmp/hf_render_last.log | tail -8
  test -s out.mp4 && ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4 | xargs echo "duration:"
else
  npx -y hyperframes check --snapshots 2>&1 | tail -20
fi

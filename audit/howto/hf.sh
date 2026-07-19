#!/bin/bash
# hf.sh <project-dir> <check|render> — run HyperFrames check or render on a how-to.
export PATH="$HOME/.local/bin:$PATH"
export HYPERFRAMES_BROWSER_PATH="$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
DIR="$1"; CMD="$2"
cd "$DIR" || exit 1
if [ "$CMD" = "render" ]; then
  npx -y hyperframes render --quality high --output out.mp4 2>&1 | tail -6
  test -s out.mp4 && ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4 | xargs echo "duration:"
else
  npx -y hyperframes check --snapshots 2>&1 | tail -20
fi

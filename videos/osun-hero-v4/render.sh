#!/bin/bash
export PATH="$HOME/.local/bin:$PATH"
export HYPERFRAMES_BROWSER_PATH="$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
cd ~/hawkeye/videos/osun-hero-v4 || exit 1
npx -y hyperframes render --quality high --output out.mp4 2>&1 | tail -20
echo "=== result ==="
test -s out.mp4 && ~/hawkeye/audit/node_modules/ffmpeg-static/ffmpeg -i out.mp4 2>&1 | grep -E "Duration|Stream" || echo "NO OUTPUT"

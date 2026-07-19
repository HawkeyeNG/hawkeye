#!/bin/bash
export PATH="$HOME/.local/bin:$PATH"
export HYPERFRAMES_BROWSER_PATH="$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
test -x "$HYPERFRAMES_BROWSER_PATH" || { echo "no chrome at $HYPERFRAMES_BROWSER_PATH"; exit 1; }
cd ~/hawkeye/videos/osun-hero-v3 || exit 1
npx -y hyperframes check --snapshots 2>&1 | tail -26

#!/bin/bash
export PATH="$HOME/.local/bin:$PATH"
cd ~/hawkeye/videos/osun-hero || exit 1
mkdir -p frames
for t in 1.6 5.5 9.5 12.5 14.5 17.5 21 26 30; do
  ffmpeg -loglevel error -ss "$t" -i out.mp4 -frames:v 1 -y "frames/t${t}.png"
done
ls frames

#!/bin/bash
export PATH="$HOME/.local/bin:$PATH"
SRC="$HOME/hawkeye/videos/broll-candidates/gen"
OUT="$HOME/hawkeye/videos/osun-hero/assets/broll"
DL=/mnt/c/Users/HP/Downloads
mkdir -p "$OUT"
# scale to 1920 tall, then center-crop to 1080 wide -> 9:16. object-position bias via crop x.
# args: <src> <dst> <xbias 0..1 of croppable width>
crop916() {
  local s="$1" d="$2" bias="$3"
  # scaled width after height=1920:
  local sw
  sw=$(python3 -c "print(round(1792*1920/2368))")   # 1453
  local x
  x=$(python3 -c "print(max(0,round(($sw-1080)*$bias)))")
  ffmpeg -loglevel error -y -i "$s" -vf "scale=-2:1920,crop=1080:1920:${x}:0" "$d"
}
crop916 "$SRC/B_1.jpg" "$OUT/s2.jpg" 0.62   # bias right — keep the POLLING UNIT sheet
crop916 "$SRC/A_2.jpg" "$OUT/s4.jpg" 0.42   # center-left — hands+phone+sheet
crop916 "$SRC/A_3.jpg" "$OUT/s6.jpg" 0.30   # bias left — keep the face
for f in s2 s4 s6; do cp "$OUT/$f.jpg" "$DL/hawkeye-broll-crop-$f.jpg"; done
ls -la "$OUT"

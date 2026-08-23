#!/usr/bin/env bash
# The camera frame, built against MEASURED geometry rather than a guess.
#
# The app paints the video into a 1318x1930 region (aspect 0.683) with object-fit
# cover, and draws gold corner guides ~30px inside it. A 720x1280 feed (0.5625)
# is taller than that region, so cover scaled it to fill the width and cropped
# the top and bottom off the sheet — which is why the sheet ran edge to edge with
# no grey and no visible margin inside the guides.
#
# So: match the region's aspect exactly, and inset the sheet to 66% of the frame
# so the surface it is lying on shows all round it, inside the guides.
set -e
node -e '
const sharp = require("/home/elrio/hawkeye/backend/node_modules/sharp/dist/index.cjs");
(async () => {
  const W = 720, H = 1054;                 // 720 / 0.683 -> matches the viewport
  const sheetW = Math.round(W * 0.66);     // grey visible on every side
  const sheet = await sharp("/tmp/specimen-ec8a.png")
    .flatten({ background: "#ffffff" })
    .resize({ width: sheetW, fit: "inside" })
    .toBuffer();
  const m = await sharp(sheet).metadata();
  await sharp({ create: { width: W, height: H, channels: 3, background: "#3f4643" } })
    .composite([{ input: sheet, left: Math.round((W - m.width) / 2), top: Math.round((H - m.height) / 2) }])
    .png().toFile("/tmp/camera-frame.png");
  console.log(`frame ${W}x${H} (aspect ${(W / H).toFixed(3)}), sheet ${m.width}x${m.height}`
    + ` = ${(m.width / W * 100).toFixed(0)}% wide, ${(m.height / H * 100).toFixed(0)}% tall`);
})();
'
# Pre-flip: the preview applies a selfie transform, which this cancels.
ffmpeg -y -loglevel error -i /tmp/camera-frame.png -vf hflip /tmp/camera-frame-flipped.png
ffmpeg -y -loglevel error -loop 1 -i /tmp/camera-frame-flipped.png -t 3 -r 5 \
  -pix_fmt yuv420p -s 720x1054 /tmp/camera-feed.y4m
ls -la /tmp/camera-feed.y4m

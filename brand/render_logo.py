# Vigilant Geometry — hawk badge renderer (see PHILOSOPHY.md).
# A paper hawk face inside one perfect circle; browline spectacles; mint signal eye.
#   python3 render_logo.py   ->  exploration-grid.png + hawkeye-logo-sheet.png
from PIL import Image, ImageDraw, ImageFont, ImageChops
import os

INK = (0, 51, 30, 255)
UNDER = (0, 19, 9, 255)
MINT = (46, 229, 157, 255)
GLINT = (159, 255, 217, 255)
PAPER = (243, 246, 242, 255)
HAIR = (201, 212, 204)
DARKBG = (10, 16, 13)
FDIR = os.path.expanduser("~/.claude/skills/canvas-design/canvas-fonts")
SS = 4  # supersample factor

def badge(px, circ=INK, head=PAPER, under=UNDER, eye=MINT, glint=GLINT,
          spike=1.0, lens_r=21, hook=1.0):
    L = px * SS
    s = L / 240.0
    T = lambda pts: [(x * s, y * s) for x, y in pts]
    img = Image.new("RGBA", (L, L), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    cx, cy, R = 120 * s, 120 * s, 112 * s
    dr.ellipse([cx - R, cy - R, cx + R, cy + R], fill=circ)

    hy = 118 + int(12 * (hook - 1))
    s1, s2 = int(26 * spike), int(22 * spike)
    face = [(20, 150), (26, 62),
            (56, 54), (76, 50 - s1), (92, 46), (110, 46 - s2), (144, 48),   # crest
            (152, 58), (196, 82),                    # brow step, beak tip
            (184, hy), (164, 100),                   # hook curls under (paper on green)
            (136, 98), (132, 122),                   # gape corner, chin
            (124, 164), (66, 206)]                   # throat, chest
    lay = Image.new("RGBA", (L, L), (0, 0, 0, 0))
    dl = ImageDraw.Draw(lay)
    dl.polygon(T(face), fill=head)
    dl.line(T([(142, 100), (172, 108)]), fill=under, width=max(2, int(2.8 * s)))  # gape slit
    dl.line(T([(166, 80), (174, 87)]), fill=under, width=max(2, int(2.6 * s)))   # nostril
    dl.polygon(T([(98, 58), (144, 68), (144, 80), (98, 70)]), fill=under)        # browline bar
    dl.line(T([(34, 66), (98, 63)]), fill=under, width=max(2, int(3.2 * s)))     # temple arm
    ex, ey, r = 126 * s, 84 * s, lens_r * s
    dl.polygon(T([(110, 75), (148, 87), (112, 97)]), fill=eye)                    # the signal
    dl.ellipse([ex - r, ey - r, ex + r, ey + r], outline=under, width=max(2, int(3.4 * s)))
    dl.arc([ex - r, ey - r, ex + r, ey + r], 130, 205, fill=glint, width=max(2, int(2.4 * s)))

    mask = Image.new("L", (L, L), 0)
    ImageDraw.Draw(mask).ellipse([cx - R, cy - R, cx + R, cy + R], fill=255)
    img.paste(lay, (0, 0), ImageChops.multiply(mask, lay.split()[3]))
    return img.resize((px, px), Image.LANCZOS)

def font(name, size):
    return ImageFont.truetype(os.path.join(FDIR, name), size)

def tracked(dr, xy, text, f, fill, tr):
    x, y = xy
    for ch in text:
        dr.text((x, y), ch, font=f, fill=fill)
        x += dr.textlength(ch, font=f) + tr

def tracked_width(dr, text, f, tr):
    return sum(dr.textlength(c, font=f) for c in text) + tr * (len(text) - 1)

# ---------- 1) exploration: 3x3 parameter sweep ----------
cell = 720
G = Image.new("RGB", (cell * 3, cell * 3), PAPER[:3])
d = ImageDraw.Draw(G)
mono = font("DMMono-Regular.ttf", 26)
params = [(0.6, 19, 0.8), (0.8, 21, 1.0), (1.0, 23, 1.2),
          (1.0, 21, 0.8), (1.1, 21, 1.2), (1.2, 23, 1.0),
          (1.3, 19, 1.2), (1.4, 21, 1.0), (1.6, 23, 1.4)]
for i, (sp, r, h) in enumerate(params):
    gx, gy = (i % 3) * cell, (i // 3) * cell
    d.rectangle([gx + 8, gy + 8, gx + cell - 8, gy + cell - 8], outline=HAIR, width=2)
    G.paste(badge(520, spike=sp, lens_r=r, hook=h), (gx + 100, gy + 70),
            badge(520, spike=sp, lens_r=r, hook=h))
    d.text((gx + 32, gy + cell - 58), f"s{sp} r{r} h{h}", font=mono, fill=(120, 134, 124))
G.save(os.path.expanduser("~/hawkeye/brand/exploration-grid.png"))
print("exploration-grid.png done")

# ---------- 2) final sheet ----------
PICK = dict(spike=1.1, lens_r=21, hook=1.2)
W, H = 2400, 3200
S = Image.new("RGB", (W, H), PAPER[:3])
d = ImageDraw.Draw(S)
for x in (120, W - 120):
    d.line([x, 120, x, H - 120], fill=HAIR, width=2)
for ty in range(240, H - 200, 240):
    d.line([104, ty, 136, ty], fill=HAIR, width=2)
    d.line([W - 136, ty, W - 104, ty], fill=HAIR, width=2)

b = badge(1240, **PICK)
S.paste(b, ((W - 1240) // 2, 340), b)

big = font("BigShoulders-Bold.ttf", 330)
tr = 38
ww = tracked_width(d, "HAWKEYE", big, tr)
tracked(d, ((W - ww) / 2, 1800), "HAWKEYE", big, INK[:3], tr)

mono44 = font("DMMono-Regular.ttf", 44)
sub = "INDEPENDENT ELECTION RESULTS MONITOR"
sw = tracked_width(d, sub, mono44, 12)
tracked(d, ((W - sw) / 2, 2210), sub, mono44, (90, 106, 96), 12)

chy, chh = 2420, 480
chw = (W - 240 - 80) // 3
xs = [120, 120 + chw + 40, 120 + 2 * (chw + 40)]
d.rectangle([xs[0], chy, xs[0] + chw, chy + chh], fill=DARKBG)
bd = badge(340, circ=PAPER, head=INK, **PICK)
S.paste(bd, (xs[0] + (chw - 340) // 2, chy + (chh - 340) // 2), bd)
d.rectangle([xs[1], chy, xs[1] + chw, chy + chh], fill=INK[:3])
bg2 = badge(340, circ=MINT, head=UNDER, eye=MINT, glint=(0, 60, 40, 255), **PICK)
S.paste(bg2, (xs[1] + (chw - 340) // 2, chy + (chh - 340) // 2), bg2)
d.rectangle([xs[2], chy, xs[2] + chw, chy + chh], outline=HAIR, width=2)
for k, sz in enumerate((200, 96, 44)):
    bs = badge(sz, **PICK)
    S.paste(bs, (xs[2] + 70 + k * 240, chy + (chh - sz) // 2), bs)

mono30 = font("DMMono-Regular.ttf", 30)
d.text((120, H - 150), "fig. 01 — vigilant geometry", font=mono30, fill=(120, 134, 124))
cap = "one perfect circle · straight cuts · one signal"
d.text((W - 120 - d.textlength(cap, font=mono30), H - 150), cap, font=mono30, fill=(120, 134, 124))
S.save(os.path.expanduser("~/hawkeye/brand/hawkeye-logo-sheet.png"))
print("hawkeye-logo-sheet.png done")

badge(1024, **PICK).save(os.path.expanduser("~/hawkeye/brand/hawkeye-badge-1024.png"))
badge(1024, circ=MINT, head=UNDER, eye=MINT, glint=(0, 60, 40, 255), **PICK).save(
    os.path.expanduser("~/hawkeye/brand/hawkeye-badge-mint-1024.png"))
badge(512, circ=PAPER, head=INK, **PICK).save(
    os.path.expanduser("~/hawkeye/brand/hawkeye-badge-paper-512.png"))
print("badge PNGs done")

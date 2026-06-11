#!/usr/bin/env python3
"""Generate a clean 1200x630 OG social card in MOBLUEHQ brand colors:
deep-navy ground, #4D9FFF accent wordmark, tagline. No stale screenshot."""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
BG = (8, 12, 20)          # #080C14
PANEL = (13, 22, 38)      # #0D1626
ACCENT = (77, 159, 255)   # #4D9FFF
WHITE = (232, 236, 242)
MUTE = (122, 134, 153)
BORDER = (28, 41, 64)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# subtle top hairline accent
d.rectangle([0, 0, W, 5], fill=ACCENT)

def font(sz, bold=True):
    paths = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for p in paths:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, sz)
            except Exception: pass
    return ImageFont.load_default()

def center_x(txt, fnt):
    bb = d.textbbox((0, 0), txt, font=fnt)
    return (W - (bb[2] - bb[0])) // 2

# wordmark MOBLUE (white) + HQ (accent), centered
wm_f = font(96, True)
moblue, hq = "MOBLUE", "HQ"
bb1 = d.textbbox((0, 0), moblue, font=wm_f); w1 = bb1[2] - bb1[0]
bb2 = d.textbbox((0, 0), hq, font=wm_f); w2 = bb2[2] - bb2[0]
total = w1 + w2
x0 = (W - total) // 2
y_wm = 200
d.text((x0, y_wm), moblue, font=wm_f, fill=WHITE)
d.text((x0 + w1, y_wm), hq, font=wm_f, fill=ACCENT)

# tagline
tag_f = font(40, False)
tag = "AI you can audit."
d.text((center_x(tag, tag_f), 330), tag, font=tag_f, fill=WHITE)

# sub-tagline
sub_f = font(26, False)
sub = "Verification infrastructure for regulated work"
d.text((center_x(sub, sub_f), 392), sub, font=sub_f, fill=MUTE)

# bottom domain pill
pill_f = font(24, True)
dom = "mobluehq.com"
bb = d.textbbox((0, 0), dom, font=pill_f); dw = bb[2] - bb[0]
px = (W - dw) // 2
d.text((px, 540), dom, font=pill_f, fill=ACCENT)

img.save("assets/og-image.png", "PNG")
print("WROTE assets/og-image.png", img.size)

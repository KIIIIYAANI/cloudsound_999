"""Draws the mobile app icons (sunburst + 999 sticker). Run: python3 mobile/icons/make_icons.py"""
import math, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
INK, GOLD, ORANGE, RED, CREAM = (29, 20, 12), (255, 207, 63), (255, 138, 31), (229, 65, 45), (255, 241, 208)

def font(px):
    for f in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Black.ttf", "/System/Library/Fonts/Supplemental/Arial Black.ttf"]:
        if os.path.exists(f):
            return ImageFont.truetype(f, px)
    return ImageFont.load_default()

def icon(size, pad=0.0):
    S = 1024
    im = Image.new("RGB", (S, S), GOLD)
    d = ImageDraw.Draw(im)
    c = S / 2
    for k in range(24):
        a0, a1 = math.radians(k * 15), math.radians(k * 15 + 7.5)
        d.polygon([(c, c), (c + 2 * S * math.cos(a0), c + 2 * S * math.sin(a0)), (c + 2 * S * math.cos(a1), c + 2 * S * math.sin(a1))], fill=ORANGE)
    for x in range(0, S, 28):
        for y in range(0, S, 28):
            d.ellipse([x, y, x + 6, y + 6], fill=(214, 120, 20))
    s = 1 - pad
    w, h = 700 * s, 430 * s
    box = [c - w / 2, c - h / 2 + 40 * s, c + w / 2, c + h / 2 + 40 * s]
    sticker = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sticker)
    off = 26 * s
    sd.rounded_rectangle([box[0] + off, box[1] + off, box[2] + off, box[3] + off], 50 * s, fill=INK)
    sd.rounded_rectangle(box, 50 * s, fill=RED, outline=INK, width=int(22 * s))
    f = font(int(330 * s))
    tw = sd.textlength("999", font=f)
    sd.text((c - tw / 2 + 12 * s, box[1] + 30 * s), "999", font=f, fill=INK)
    sd.text((c - tw / 2, box[1] + 18 * s), "999", font=f, fill=CREAM)
    # little waveform on top
    pts = []
    for i in range(61):
        x = c - 300 * s + i * 10 * s
        amp = (math.sin(i * 0.9) * 0.6 + math.sin(i * 2.3) * 0.4) * (1 - abs(i - 30) / 34) * 90 * s
        pts.append((x, c - 250 * s + amp))
    sd.line(pts, fill=INK, width=int(20 * s), joint="curve")
    sticker = sticker.rotate(-6, resample=Image.BICUBIC, center=(c, c))
    im.paste(sticker, (0, 0), sticker)
    return im.resize((size, size), Image.LANCZOS)

icon(192).save(os.path.join(HERE, "icon-192.png"))
icon(512).save(os.path.join(HERE, "icon-512.png"))
icon(512, pad=0.2).save(os.path.join(HERE, "icon-maskable-512.png"))
icon(180).save(os.path.join(HERE, "apple-touch-icon.png"))

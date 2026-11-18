"""Draw the cloudsound_999 app icon (2001 skin: off-white tile, black ring, one red dot).
Pure stdlib: writes a 1024x1024 RGBA PNG. Usage: python3 make_icon.py out.png"""
import math
import struct
import sys
import zlib

S = 1024
BG = (239, 238, 233)
INK = (20, 20, 20)
RED = (208, 16, 30)


def cov(d):
    """Signed distance (negative = inside) -> coverage with 1px antialiasing."""
    return max(0.0, min(1.0, 0.5 - d))


def rrect_sd(x, y, cx, cy, half, r):
    qx, qy = abs(x - cx) - (half - r), abs(y - cy) - (half - r)
    out = math.hypot(max(qx, 0), max(qy, 0))
    return out + min(max(qx, qy), 0) - r


def blend(dst, src, a):
    return tuple(d + (s - d) * a for d, s in zip(dst, src))


rows = []
c = S / 2
for py in range(S):
    row = bytearray([0])
    y = py + 0.5
    for px in range(S):
        x = px + 0.5
        # macOS-style tile: 824px rounded square, centred
        tile = cov(rrect_sd(x, y, c, c, 412, 185))
        if tile <= 0:
            row += b"\0\0\0\0"
            continue
        col = BG
        r = math.hypot(x - c, y - c)
        # thin black rule inset along the tile
        rule = cov(abs(rrect_sd(x, y, c, c, 360, 140)) - 3)
        col = blend(col, INK, rule * 0.9)
        # the eye: black ring, black iris, red pupil with glow
        col = blend(col, INK, cov(abs(r - 215) - 16))
        col = blend(col, INK, cov(r - 120))
        glow = max(0.0, 1 - (r - 52) / 70) if r > 52 else 1.0
        col = blend(col, RED, 0.55 * glow * cov(r - 120))
        col = blend(col, RED, cov(r - 52))
        row += bytes(int(v) for v in col) + bytes([int(255 * tile)])
    rows.append(bytes(row))


def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)) \
    + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
open(sys.argv[1] if len(sys.argv) > 1 else "icon.png", "wb").write(png)

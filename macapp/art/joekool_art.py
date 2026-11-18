"""Generates the JoeKool skin artwork (original SVG) and splices it into static/index.html.

  * scene-desert : humid oasis desert — hazy sage-to-peach sky, diffuse sun, mist bands,
                   knife-edged dunes (lit face + shadow face), palms around a teal pool
  * art-camel    : graphic-novel panel — inked frame, halftone sky, palm, sharp dune and an
                   original cartoon camel in wraparound shades with a cigarette (heavy blacks,
                   halftone + hatching, rim light, comic smoke puffs)

Run:  python3 macapp/art/joekool_art.py
"""
import math
import re
from pathlib import Path

INDEX = Path(__file__).resolve().parents[2] / "static" / "index.html"


def f(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


# ------------------------------------------------------------------ palms
def leaf(L, rng_phase=0.0, serr=True):
    """Frond polygon in local coords pointing +x, arching up then drooping (+y is down)."""
    n = 22
    top, bot = [], []
    for i in range(n + 1):
        t = i / n
        cx = t * L
        cy = -0.22 * L * math.sin(math.pi * t * 0.85) + 0.30 * L * t * t
        w = 0.085 * L * (math.sin(math.pi * min(t * 1.05, 1)) ** 0.7)
        fringe = 1.0
        if serr and 0 < i < n:
            fringe = 1.9 if (i + int(rng_phase)) % 2 else 0.55
        top.append((cx, cy - w * fringe))
        bot.append((cx, cy + w * (2.3 - fringe if serr else 1)))
    pts = top + bot[::-1]
    return "M" + " L".join(f"{f(x)} {f(y)}" for x, y in pts) + " Z"


def palm(x, y, h, lean, s, color, rim=None, frond_len=None):
    """Palm silhouette with base at (x, y), crown at (x+lean, y-h)."""
    tx, ty = x + lean, y - h
    out = []
    # tapering trunk built from segments
    segs = 9
    for i in range(segs):
        t0, t1 = i / segs, (i + 1) / segs
        def pt(t):
            # slight S-curve
            return (x + lean * (t ** 1.4) + 6 * s * math.sin(t * math.pi), y - h * t)
        (x0, y0), (x1, y1) = pt(t0), pt(t1)
        w = (11 - 6 * t0) * s
        out.append(f'<path d="M{f(x0)} {f(y0)} L{f(x1)} {f(y1)}" stroke="{color}" stroke-width="{f(w)}" stroke-linecap="round"/>')
        if rim:
            out.append(f'<path d="M{f(x0 + w * .3)} {f(y0)} L{f(x1 + w * .3)} {f(y1)}" stroke="{rim}" stroke-width="{f(1.2 * s)}" opacity=".55"/>')
        # trunk rings
        out.append(f'<path d="M{f(x0 - w / 2)} {f(y0 - 2 * s)} L{f(x0 + w / 2)} {f(y0 - 4 * s)}" stroke="{rim or "#000"}" stroke-width="{f(1.1 * s)}" opacity=".35"/>')
    L = frond_len or h * 0.55
    angles = [-168, -140, -112, -80, -48, -18, 12, 196, 160]
    for k, a in enumerate(angles):
        ll = L * (0.78 + 0.22 * ((k * 37) % 5) / 4)
        if 90 < (a % 360) < 270:   # points left: mirror so the tip still droops down
            tr = f"translate({f(tx)} {f(ty)}) scale(-1 1) rotate({f(180 - a)})"
        else:
            tr = f"translate({f(tx)} {f(ty)}) rotate({f(a)})"
        out.append(f'<path transform="{tr}" d="{leaf(ll, k)}" fill="{color}"/>')
        if rim:
            out.append(f'<path transform="{tr}" d="M4 0 Q{f(ll * .45)} {f(-ll * .2)} {f(ll * .92)} {f(ll * .2)}" fill="none" stroke="{rim}" stroke-width="{f(1.1 * s)}" opacity=".6"/>')
    # coconuts
    out.append(f'<circle cx="{f(tx - 4 * s)}" cy="{f(ty + 6 * s)}" r="{f(4.5 * s)}" fill="{color}"/><circle cx="{f(tx + 5 * s)}" cy="{f(ty + 7 * s)}" r="{f(4 * s)}" fill="{color}"/>')
    return "".join(out)


# ------------------------------------------------------------------ sharp dunes
def dune(x0, x1, peak, base, lit, shade, crest=None, ink=None, crest_bias=0.12):
    """Knife-edged dune: lit body, shadow face to the right of a sinuous crest from the peak."""
    px, py = peak
    body = f"M{x0} {base} Q{f((x0 + px) / 2)} {f(py + (base - py) * .35)} {px} {py} Q{f((px + x1) / 2)} {f(py + (base - py) * .3)} {x1} {base} Z"
    cx = px + (x1 - px) * crest_bias
    shadow = (f"M{px} {py} Q{f(px - (x1 - px) * .05)} {f(py + (base - py) * .55)} {f(cx)} {base} "
              f"L{x1} {base} Q{f((px + x1) / 2)} {f(py + (base - py) * .3)} {px} {py} Z")
    s = f'<path d="{body}" fill="{lit}"/><path d="{shadow}" fill="{shade}"/>'
    if crest:
        s += f'<path d="M{px} {py} Q{f(px - (x1 - px) * .05)} {f(py + (base - py) * .55)} {f(cx)} {base}" fill="none" stroke="{crest}" stroke-width="2.2" opacity=".85"/>'
    if ink:
        s += f'<path d="{body}" fill="none" stroke="{ink}" stroke-width="2.4" stroke-linejoin="round"/>'
    return s


# ------------------------------------------------------------------ background scene
def scene():
    parts = ['<svg class="scene-desert" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMax slice">',
             '<defs>',
             '<linearGradient id="dsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a9c9bd"/><stop offset=".38" stop-color="#dcdcc0"/><stop offset=".7" stop-color="#f1cb9c"/><stop offset="1" stop-color="#e9a874"/></linearGradient>',
             '<radialGradient id="dsun"><stop offset="0" stop-color="#fffbe6"/><stop offset=".22" stop-color="#ffefc2" stop-opacity=".95"/><stop offset=".55" stop-color="#ffe0a8" stop-opacity=".35"/><stop offset="1" stop-color="#ffe0a8" stop-opacity="0"/></radialGradient>',
             '<linearGradient id="dpool" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f8f86"/><stop offset="1" stop-color="#2f6660"/></linearGradient>',
             '<filter id="dmist" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="16"/></filter>',
             '</defs>',
             '<rect width="1440" height="900" fill="url(#dsky)"/>',
             '<circle cx="1040" cy="430" r="300" fill="url(#dsun)"/>',
             '<circle cx="1040" cy="430" r="62" fill="#fff6d6" opacity=".85"/>',
             # far range: hazy, low contrast
             dune(-40, 380, (190, 470), 640, "#e2c6a0", "#c3a58e"),
             dune(250, 760, (520, 452), 640, "#e6c9a2", "#c6a48b"),
             dune(640, 1180, (900, 480), 640, "#e2c4a0", "#c1a28c"),
             dune(1050, 1500, (1290, 458), 640, "#e5c8a2", "#c4a48c"),
             '<ellipse cx="720" cy="560" rx="900" ry="34" fill="#f7f1e6" opacity=".55" filter="url(#dmist)"/>',
             ]
    # oasis: pool + palms + reeds
    parts.append('<ellipse cx="960" cy="668" rx="190" ry="20" fill="url(#dpool)"/>')
    parts.append('<path d="M800 668 L1120 668" stroke="#cfe6dc" stroke-width="2" opacity=".5"/><path d="M860 676 L1060 676" stroke="#cfe6dc" stroke-width="1.5" opacity=".35"/>')
    for rx in (790, 812, 1108, 1132, 1150):
        parts.append(f'<path d="M{rx} 670 q-6 -22 -2 -34 M{rx} 670 q4 -18 12 -28 M{rx} 670 q-1 -14 -12 -22" stroke="#2c4a36" stroke-width="3" fill="none" stroke-linecap="round"/>')
    parts.append(palm(880, 668, 190, -26, 1.0, "#24392d", rim="#6f8f74"))
    parts.append(palm(1000, 668, 240, 22, 1.15, "#1f3327", rim="#6f8f74"))
    parts.append(palm(1080, 670, 160, 34, 0.9, "#2a4233", rim="#6f8f74"))
    # palm reflections in the pool
    parts.append('<g opacity=".18" transform="translate(0 1336) scale(1 -1)">' + palm(1000, 668, 60, 8, .5, "#123", None, 40) + '</g>')
    # mid dunes: crisp crests
    parts += [
        dune(-80, 520, (260, 600), 780, "#dca06c", "#a3653f", crest="#f6cf98"),
        dune(380, 980, (700, 640), 780, "#d99a64", "#9c5c37", crest="#f6cf98"),
        dune(1180, 1600, (1380, 600), 780, "#dca06c", "#a3653f", crest="#f6cf98"),
        '<ellipse cx="400" cy="700" rx="700" ry="26" fill="#fbf4ea" opacity=".45" filter="url(#dmist)"/>',
        # near dunes: deep shadows, razor ridges
        dune(-120, 700, (300, 720), 900, "#c98049", "#7a3f24", crest="#f3c58e"),
        dune(560, 1560, (1060, 740), 900, "#c47a44", "#743a21", crest="#f3c58e"),
    ]
    # ripple marks on the near lit faces
    for (x, y) in [(120, 850), (200, 872), (700, 868), (820, 846), (1240, 860)]:
        parts.append(f'<path d="M{x} {y} q30 -9 60 0 q30 9 60 0" fill="none" stroke="#a6612f" stroke-width="2.2" opacity=".7"/>')
    # foreground framing palm (left)
    parts.append(palm(60, 930, 520, 70, 1.9, "#16261c", rim="#4f6f58", frond_len=230))
    parts.append('</svg>')
    return "\n".join(parts)


# ------------------------------------------------------------------ graphic-novel camel panel
INK = "#111"
FUR = "#c88d55"
FUR_DK = "#8c5a2e"
BODY = "M78 98 L86 80 L110 66 Q124 26 160 32 Q176 40 181 60 L199 66 L209 84 L206 104 L193 114 L96 114 L83 108 Z"
NECK = "M102 92 L94 74 L80 57 L66 48 L53 61 L66 71 L76 87 L84 106 Z"
HEAD = "M71 46 L66 33 L52 25 L35 25 L19 31 L9 42 L9 52 L18 59 L40 60 L61 58 L71 52 Z"


def camel():
    legs_far = [("M110 108 L106 134 L110 157", ), ("M184 108 L188 134 L185 157", )]
    legs_near = [("M96 110 L91 135 L95 158", ), ("M170 110 L175 135 L171 158", )]
    p = []
    for (d,) in legs_far:
        p.append(f'<path d="{d}" stroke="{INK}" stroke-width="12.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        p.append(f'<path d="{d}" stroke="{FUR_DK}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        p.append(f'<path d="{d}" transform="translate(2 0)" stroke="{INK}" stroke-width="2" fill="none"/>')
    p.append(f'<path d="M206 88 Q217 96 214 116" fill="none" stroke="{INK}" stroke-width="3.4" stroke-linecap="round"/>')
    p.append(f'<path d="M210 112 L218 120 L211 128 L205 119 Z" fill="{INK}"/>')
    # neck + shadow
    p.append(f'<path d="{NECK}" fill="{FUR}"/>')
    p.append(f'<g clip-path="url(#cneck)"><path d="M84 106 L74 84 L90 80 L104 96 Z" fill="{INK}"/><rect x="60" y="50" width="40" height="30" fill="url(#cht)"/></g>')
    p.append(f'<path d="{NECK}" fill="none" stroke="{INK}" stroke-width="3.4" stroke-linejoin="round"/>')
    # body + shadows + hatching + rim light
    p.append(f'<path d="{BODY}" fill="{FUR}"/>')
    p.append(f'<g clip-path="url(#cbody)">'
             f'<rect x="70" y="84" width="150" height="16" fill="url(#cht)"/>'
             f'<path d="M70 101 Q140 92 220 96 L220 130 L70 130 Z" fill="{INK}"/>'
             f'<path d="M150 26 L215 38 L215 92 Q180 72 158 60 Z" fill="url(#chatch)"/>'
             f'</g>')
    p.append(f'<path d="{BODY}" fill="none" stroke="{INK}" stroke-width="3.6" stroke-linejoin="round"/>')
    p.append('<path d="M113 63 Q126 36 156 36" fill="none" stroke="#fff3da" stroke-width="2.6" stroke-linecap="round"/>')
    # near legs
    for (d,) in legs_near:
        p.append(f'<path d="{d}" stroke="{INK}" stroke-width="12.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        p.append(f'<path d="{d}" stroke="{FUR}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        p.append(f'<path d="{d}" transform="translate(2.2 0)" stroke="{INK}" stroke-width="2.2" fill="none"/>')
    for hx in (95, 171):
        p.append(f'<path d="M{hx - 7} 160 L{hx + 7} 160" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>')
    # ear, head, jaw shadow
    p.append(f'<path d="M58 30 L63 16 L71 29 Z" fill="{FUR_DK}" stroke="{INK}" stroke-width="3" stroke-linejoin="round"/>')
    p.append(f'<path d="{HEAD}" fill="{FUR}"/>')
    p.append(f'<g clip-path="url(#chead)"><path d="M14 56 L72 51 L72 64 L14 64 Z" fill="{INK}"/><rect x="44" y="40" width="30" height="12" fill="url(#cht)"/></g>')
    p.append(f'<path d="{HEAD}" fill="none" stroke="{INK}" stroke-width="3.6" stroke-linejoin="round"/>')
    p.append(f'<path d="M12 38 L17 37" stroke="{INK}" stroke-width="2.6" stroke-linecap="round"/>')
    p.append(f'<path d="M10 50 L22 51" stroke="{INK}" stroke-width="2.6" stroke-linecap="round"/>')
    p.append('<path d="M14 32 Q30 26 44 27" fill="none" stroke="#fff3da" stroke-width="2" stroke-linecap="round"/>')
    # brow + wraparound shades
    p.append(f'<path d="M26 30 L60 25" stroke="{INK}" stroke-width="4" stroke-linecap="round"/>')
    p.append(f'<path d="M57 33 L69 30" stroke="{INK}" stroke-width="3"/>')
    p.append(f'<path d="M25 33 L59 30 L56 42 L42 47 L30 44 Z" fill="#050505" stroke="{INK}" stroke-width="2.5" stroke-linejoin="round"/>')
    p.append('<path d="M31 35 L41 34 L35 42 Z" fill="#ffffff" opacity=".9"/><path d="M45 34 L49 34 L44 41 L42 41 Z" fill="#ffffff" opacity=".7"/>')
    # cigarette, ember, glow
    p.append('<g class="cig">'
             f'<rect x="-24" y="49" width="38" height="6" fill="#fbf6ea" stroke="{INK}" stroke-width="2"/>'
             f'<rect x="4" y="49" width="10" height="6" fill="#d98a3a" stroke="{INK}" stroke-width="2"/>'
             '<circle class="ember-glow" cx="-25" cy="52" r="7" fill="#ff7a1f" opacity=".5"/>'
             f'<rect x="-28" y="49" width="5" height="6" fill="#ff3d0a" stroke="{INK}" stroke-width="1.6"/>'
             '</g>')
    # comic smoke puffs (white fill, ink outline) rising from the ember
    puffs = []
    for k, (dx, r) in enumerate([(0, 7), (-8, 10), (6, 13)]):
        cy = 38 - k * 17
        puffs.append(f'<g class="puff p{k + 1}"><circle cx="{-27 + dx}" cy="{cy}" r="{r}"/>'
                     f'<circle cx="{f(-27 + dx + r * .85)}" cy="{f(cy + r * .3)}" r="{f(r * .7)}"/>'
                     f'<circle cx="{f(-27 + dx - r * .7)}" cy="{f(cy + r * .35)}" r="{f(r * .55)}"/></g>')
    p.append(f'<g class="smoke" fill="#fffdf6" stroke="{INK}" stroke-width="2">{"".join(puffs)}</g>')
    return "".join(p)


def camel_panel():
    out = ['<svg class="art-camel" viewBox="0 0 400 214" role="img" aria-label="">',
           '<defs>',
           '<pattern id="cht" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r="1.15" fill="#111"/></pattern>',
           '<pattern id="chts" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="3.5" cy="3.5" r="1.1" fill="#7a4b2a" opacity=".55"/></pattern>',
           '<pattern id="chatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(38)"><line x1="0" y1="0" x2="0" y2="5" stroke="#111" stroke-width="1.3"/></pattern>',
           '<linearGradient id="cpsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b7d3c6"/><stop offset=".6" stop-color="#ead9b8"/><stop offset="1" stop-color="#f2c38e"/></linearGradient>',
           f'<clipPath id="cframe"><rect x="6" y="6" width="388" height="202"/></clipPath>',
           f'<clipPath id="cbody"><path d="{BODY}"/></clipPath>',
           f'<clipPath id="cneck"><path d="{NECK}"/></clipPath>',
           f'<clipPath id="chead"><path d="{HEAD}"/></clipPath>',
           '</defs>',
           '<g clip-path="url(#cframe)">',
           '<rect x="6" y="6" width="388" height="202" fill="url(#cpsky)"/>',
           '<rect x="6" y="6" width="388" height="90" fill="url(#chts)"/>',
           '<circle cx="300" cy="62" r="46" fill="#fff4d2" opacity=".55"/><circle cx="300" cy="62" r="24" fill="#fff9e6"/>',
           dune(-20, 260, (110, 120), 190, "#e6c59d", "#b88f73", ink="#111"),
           dune(200, 440, (330, 112), 190, "#e3c099", "#b18a6e", ink="#111"),
           palm(352, 196, 150, 18, .85, "#111", rim="#f6e7c8", frond_len=78),
           palm(36, 196, 110, -10, .6, "#111", rim="#f6e7c8", frond_len=58),
           '<path d="M6 214 L6 178 Q120 150 230 168 Q320 182 394 164 L394 214 Z" fill="#dda26a" stroke="#111" stroke-width="3"/>',
           '<path d="M230 168 Q320 182 394 164 L394 214 L260 214 Q250 190 230 168 Z" fill="url(#chatch)" opacity=".8"/>',
           '<path d="M30 196 q20 -6 40 0 M250 204 q20 -6 40 0" fill="none" stroke="#111" stroke-width="1.6"/>',
           '</g>',
           '<rect x="6" y="6" width="388" height="202" fill="none" stroke="#111" stroke-width="5"/>',
           f'<g transform="translate(128 40)" stroke-linejoin="round">{camel()}</g>',
           '</svg>']
    return "\n".join(out)


def splice(html, cls, svg):
    pat = re.compile(r'<svg class="' + cls + r'".*?</svg>', re.S)
    assert pat.search(html), cls
    return pat.sub(lambda m: svg, html, count=1)


if __name__ == "__main__":
    html = INDEX.read_text()
    html = splice(html, "scene-desert", scene())
    html = splice(html, "art-camel", camel_panel())
    INDEX.write_text(html)
    print("updated", INDEX)

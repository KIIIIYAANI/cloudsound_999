"""Generates the juicy half-lime mark for the LymeWire skin and splices it into app.css."""
import math, re, sys, urllib.parse
from pathlib import Path

def lime():
    cx = cy = 50
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">', '<defs>',
           '<radialGradient id="r" cx=".38" cy=".34" r=".75"><stop offset="0" stop-color="#7fd23a"/><stop offset=".7" stop-color="#3f9a16"/><stop offset="1" stop-color="#1f5e08"/></radialGradient>',
           '<radialGradient id="f" cx=".5" cy=".5" r=".55"><stop offset="0" stop-color="#f3ffc4"/><stop offset=".35" stop-color="#d4f56a"/><stop offset="1" stop-color="#9fdc2c"/></radialGradient>',
           '<radialGradient id="g" cx=".3" cy=".25" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>',
           '</defs>']
    # rind + pith
    out.append(f'<circle cx="{cx}" cy="{cy}" r="47" fill="url(#r)"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="41" fill="#f2fbd9"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="38.5" fill="#e6f7b8"/>')
    # segments: rounded wedges with pith membranes between them
    n = 9
    for i in range(n):
        a0 = 2 * math.pi * i / n + 0.075
        a1 = 2 * math.pi * (i + 1) / n - 0.075
        r_in, r_out = 4.5, 36
        p = lambda a, r: (cx + r * math.cos(a), cy + r * math.sin(a))
        x0, y0 = p(a0, r_in); x1, y1 = p(a0, r_out); x2, y2 = p(a1, r_out); x3, y3 = p(a1, r_in)
        out.append(f'<path d="M{x0:.2f} {y0:.2f} L{x1:.2f} {y1:.2f} A{r_out} {r_out} 0 0 1 {x2:.2f} {y2:.2f} L{x3:.2f} {y3:.2f} Z" fill="url(#f)" stroke="#c7ec7a" stroke-width=".8" stroke-linejoin="round"/>')
        # juice vesicles: little teardrop glints in each segment
        am = (a0 + a1) / 2
        for rr, s in ((14, 1.6), (22, 2.2), (29, 1.8)):
            vx, vy = p(am + (0.12 if rr == 22 else -0.1), rr)
            out.append(f'<ellipse cx="{vx:.2f}" cy="{vy:.2f}" rx="{s*0.55:.2f}" ry="{s:.2f}" transform="rotate({math.degrees(am)+90:.1f} {vx:.2f} {vy:.2f})" fill="#fff" opacity=".55"/>')
    out.append(f'<circle cx="{cx}" cy="{cy}" r="4.8" fill="#f6ffd6" stroke="#c7ec7a" stroke-width=".8"/>')
    # wet gloss + juice drops
    out.append('<ellipse cx="36" cy="30" rx="20" ry="12" transform="rotate(-30 36 30)" fill="url(#g)"/>')
    out.append('<path d="M70 8 Q74 2 76 8 A3.4 3.4 0 1 1 70 8 Z" fill="#c9f25a" stroke="#3f9a16" stroke-width="1"/>')
    out.append('<circle cx="73.6" cy="9.5" r="1" fill="#fff"/>')
    out.append('<path d="M86 84 Q92 90 89 95 A4 4 0 1 1 83 90 Q83 87 86 84 Z" fill="#c9f25a" stroke="#3f9a16" stroke-width="1"/>')
    out.append('<circle cx="85" cy="91" r="1.1" fill="#fff"/>')
    out.append('</svg>')
    return ''.join(out)

def data_uri(svg):
    return 'url("data:image/svg+xml,' + urllib.parse.quote(svg, safe=" =:/'(),.-") .replace('"', "'") + '")'

if __name__ == "__main__":
    css = Path(sys.argv[1]); s = css.read_text()
    uri = data_uri(lime())
    mark = ('[data-skin="lymewire"] .brand .mark { border: 0; border-radius: 50%; width: 30px; height: 30px; '
            f'background: {uri} center / contain no-repeat; filter: drop-shadow(0 1px 1.5px rgba(0,40,0,.45)); transition: transform .4s; }}')
    empty = ('[data-skin="lymewire"] .empty-mark { border: 0; width: 84px; height: 84px; '
             f'background: {uri} center / contain no-repeat; filter: drop-shadow(0 3px 4px rgba(0,60,0,.3)); }}')
    s = re.sub(r'\[data-skin="lymewire"\] \.brand \.mark \{[^\n]*\}', lambda m: mark, s, count=1)
    s = re.sub(r'\[data-skin="lymewire"\] \.empty-mark \{[^\n]*\}', lambda m: empty, s, count=1)
    if 'lime-spin' not in s:
        s = s.replace(mark, mark + '\n[data-skin="lymewire"].is-active .brand .mark { animation: lime-spin 6s linear infinite; }\n@keyframes lime-spin { to { transform: rotate(360deg); } }', 1)
    css.write_text(s)
    Path(sys.argv[1]).with_name("lime-preview.svg").write_text(lime()) if len(sys.argv) > 2 else None

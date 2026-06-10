#!/usr/bin/env python3
"""Generate the Camus landing SVG set — six original pieces in the locked
brand grammar (ink #0B0B16 / paper #F4F1E8, half-squares + circles, 0/45/90
degrees only), each riffing on one Vintage International cover idea."""
import math, os

INK, PAPER = "#0B0B16", "#F4F1E8"
W, H = 400, 600
OUT = "/Users/mateodazab/Documents/Own/camus/brand/landing"
os.makedirs(OUT, exist_ok=True)

def svg(name, label, body, clip=False):
    inner = body
    if clip:
        inner = (f'<clipPath id="c"><rect width="{W}" height="{H}"/></clipPath>'
                 f'<g clip-path="url(#c)">{body}</g>')
    doc = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
           f'role="img" aria-label="{label}">\n{inner}\n</svg>\n')
    with open(os.path.join(OUT, name), "w") as f:
        f.write(doc)
    return name, doc

def poly(pts, fill, seal=False):
    s = " ".join(f"{round(x,1):g},{round(y,1):g}" for x, y in pts)
    seam = f' stroke="{fill}" stroke-width="0.7" stroke-linejoin="miter"' if seal else ""
    return f'<polygon points="{s}" fill="{fill}"{seam}/>'

def rect(x, y, w, h, fill, seal=False):
    seam = f' stroke="{fill}" stroke-width="0.7"' if seal else ""
    return f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" fill="{fill}"{seam}/>'

def circle(cx, cy, r, fill):
    return f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="{fill}"/>'

paper_bg = rect(0, 0, W, H, PAPER)
ink_bg = rect(0, 0, W, H, INK)
pieces = []

# 1. THE GLARE (The Stranger) — the indifferent sun as a halftone of
# half-squares: every cell aims its hypotenuse at the void; density grows
# with distance in three steps. No angle but 45/90 anywhere.
cx, cy, s = 252, 222, 50
shapes = [paper_bg]
for col in range(8):
    for row in range(12):
        mx, my = col * s + 25, row * s + 25
        d = math.hypot(mx - cx, my - cy)
        sx = 1 if mx >= cx else -1   # toward far corner
        sy = 1 if my >= cy else -1
        fx, fy = mx + 25 * sx, my + 25 * sy          # far corner
        nx, ny = mx - 25 * sx, my - 25 * sy          # near corner
        if d < 130:
            continue                                  # the void
        elif d < 215:
            shapes.append(poly([(fx, fy), (fx, ny), (nx, fy)], INK, seal=True))
        elif d < 305:
            shapes.append(rect(min(mx-25, mx+25), min(my-25, my+25), 50, 50, INK, seal=True))
            shapes.append(poly([(nx, ny), (nx + 25*sx, ny), (nx, ny + 25*sy)], PAPER))
        else:
            shapes.append(rect(min(mx-25, mx+25), min(my-25, my+25), 50, 50, INK, seal=True))
shapes.append(circle(cx, cy, 28, INK))
pieces.append(svg("the-glare.svg",
    "A dark sun floating in a silent void, the glare built from half-square triangles",
    "\n".join(shapes)))

# 2. THE CASCADE (The Myth of Sisyphus) — the slope at poster scale, and a
# diagonal chain of half-size echoes of it descending the sky: the same
# mountain at every scale.
shapes = [paper_bg,
          poly([(0, 600), (400, 600), (400, 200)], INK)]
for size, c in ((96, 160), (48, 208), (24, 232), (12, 244)):
    # right-angle corner of this echo at (c,c); chain stays 56+ clear of the
    # hypotenuse (x+y <= 488 < 600) and 17+ clear of the boulder
    shapes.append(poly([(c, c), (c, c - size), (c - size, c)], INK))
shapes.append(circle(268, 289, 34, INK))   # the boulder, mid-ascent
pieces.append(svg("the-cascade.svg",
    "The boulder mid-ascent on the great slope while half-size echoes of the mountain cascade down the sky toward it",
    "\n".join(shapes)))

# 3. THE DESCENT (The Fall) — square inscribed in diamond inscribed in square,
# each level drifting down-right, ending at the boulder. Rotation only by 45.
def diamond(c, a, fill):
    x, y = c
    return poly([(x, y - a), (x + a, y), (x, y + a), (x - a, y)], fill)
def square(c, h, fill):
    x, y = c
    return poly([(x - h, y - h), (x + h, y - h), (x + h, y + h), (x - h, y + h)], fill)
shapes = [ink_bg,
          diamond((214, 372), 360, PAPER),
          square((220, 382), 170, INK),
          diamond((226, 392), 158, PAPER),
          square((232, 402), 70, INK),
          diamond((238, 412), 58, PAPER),
          circle(244, 422, 26, INK)]
pieces.append(svg("the-descent.svg",
    "Nested squares and diamonds falling inward by half, down to a single boulder",
    "\n".join(shapes), clip=True))

# 4. THE CROSSING (The First Man) — four straight roads, one for each legal
# direction, meeting at a single clearing where the boulder waits.
shapes = [paper_bg,
          rect(0, 204, 400, 12, INK),                                  # horizontal
          rect(141, 0, 18, 600, INK),                                  # vertical
          poly([(-700, -685), (1100, 1115), (1100, 1205), (-700, -595)], INK),   # 45 down-right
          poly([(-700, 1049), (1100, -751), (1100, -729), (-700, 1071)], INK),   # 45 up-right
          circle(150, 210, 40, PAPER),                                 # the clearing
          circle(150, 210, 22, INK)]                                   # the boulder
pieces.append(svg("the-crossing.svg",
    "Four roads at right and diagonal angles converge on a clearing holding a single boulder",
    "\n".join(shapes), clip=True))

# 5. THE BREAK (The Rebel) — an obedient field of stripes; two 45-degree bands
# cross it and invert every stripe they touch; where they cross each other,
# order returns. Revolt as XOR.
def stripes(rows):
    return "\n".join(rect(0, y0, 400, y1 - y0, INK) for y0, y1 in rows)
base_rows = [(y, min(y + 40, 600)) for y in range(20, 600, 80)]
inv_rows = [(0, 20)] + [(y + 40, min(y + 80, 600)) for y in range(20, 600, 80)]
bandA = '<clipPath id="bA"><polygon points="-700,-685 1100,1115 1100,1205 -700,-595"/></clipPath>'
bandB = '<clipPath id="bB"><polygon points="-700,1175 1100,-625 1100,-535 -700,1265"/></clipPath>'
body = "\n".join([
    paper_bg, stripes(base_rows), bandA, bandB,
    f'<g clip-path="url(#bA)">{rect(0,0,400,600,PAPER)}{stripes(inv_rows)}</g>',
    f'<g clip-path="url(#bB)">{rect(0,0,400,600,PAPER)}{stripes(inv_rows)}</g>',
    f'<g clip-path="url(#bA)"><g clip-path="url(#bB)">{rect(0,0,400,600,PAPER)}{stripes(base_rows)}</g></g>',
])
pieces.append(svg("the-break.svg",
    "A field of stripes inverted wherever two diagonal bands cross it; where the bands meet, the pattern holds",
    body, clip=True))

# 6. THE CLIMB (ours) — the hero animation's pose as a still: the steep saw,
# the boulder bedded on the long diagonal. Anchor of the set.
shapes = [paper_bg,
          poly([(-24, 456), (40, 520), (360, 200), (416, 256), (416, 600), (-24, 600)], INK),
          circle(190, 307, 50, INK)]
pieces.append(svg("the-climb.svg",
    "The boulder bedded on a long 45-degree slope rising corner to corner, a saddle below the summit",
    "\n".join(shapes), clip=True))

# preview page (inlined) for visual verification
cards = "\n".join(
    f'<figure><div class="art">{doc}</div><figcaption>{name}</figcaption></figure>'
    for name, doc in pieces)
preview = f"""<style>
body{{background:#DDD9D0;font-family:Archivo,system-ui,sans-serif;margin:40px}}
.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;max-width:1180px;margin:0 auto}}
figure{{margin:0}}.art svg{{width:100%;height:auto;display:block;box-shadow:0 2px 14px rgba(11,11,22,.18)}}
figcaption{{margin-top:10px;font-size:12px;letter-spacing:.08em;color:#3a3a40;text-align:center}}
</style>
<div class="grid">{cards}</div>"""
with open("/Users/mateodazab/Downloads/camus_svg_set_preview.html", "w") as f:
    f.write(preview)
print("wrote", len(pieces), "svgs to", OUT, "+ preview page")

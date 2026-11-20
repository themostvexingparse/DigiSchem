"""Generate the oscilloscope-style logo variants (F, G, H): AND-gate 'D' + vertical sine 'S'."""
import math

W = 1024

# --- geometry -------------------------------------------------------------------------------
# AND gate (the 'D'): flat left edge, straight top/bottom, semicircular nose
GATE = "M216 336H326A176 176 0 0 1 326 688H216Z"
INPUTS = "M132 444H216M132 580H216"
OUTPUT = "M502 512H548"


def sine_path(cx, top, bottom, amp, overshoot=0.07, n=90):
    """A vertical sine (one period) — reads as an 'S': upper bowl bulges left, lower bowl right."""
    h = bottom - top
    pts = []
    for i in range(n + 1):
        t = -overshoot + (1 + 2 * overshoot) * i / n
        y = top + t * h
        x = cx - amp * math.sin(2 * math.pi * t)
        pts.append((x, y))
    d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts)
    return d


SINE = sine_path(cx=768, top=322, bottom=702, amp=100, overshoot=0.05, n=160)


def graticule(x0, y0, x1, y1, step, color, op, cross_op):
    lines = []
    x = x0 + step
    while x < x1 - 1:
        lines.append(f'<path d="M{x} {y0}V{y1}"/>')
        x += step
    y = y0 + step
    while y < y1 - 1:
        lines.append(f'<path d="M{x0} {y}H{x1}"/>')
        y += step
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    grid = f'<g stroke="{color}" stroke-opacity="{op}" stroke-width="6" fill="none">' + "".join(lines) + "</g>"
    # centre axes slightly brighter, with small ticks like a real scope
    ticks = []
    t = x0 + step / 4
    while t < x1:
        ticks.append(f'<path d="M{t:.0f} {cy - 12}V{cy + 12}"/>')
        t += step / 4
    t = y0 + step / 4
    while t < y1:
        ticks.append(f'<path d="M{cx - 12} {t:.0f}H{cx + 12}"/>')
        t += step / 4
    axes = (f'<g stroke="{color}" stroke-opacity="{cross_op}" stroke-width="6" fill="none">'
            f'<path d="M{x0} {cy}H{x1}M{cx} {y0}V{y1}"/>' + "".join(ticks) + "</g>")
    return grid + axes


def gate(stroke, width=60):
    return (f'<g fill="none" stroke="{stroke}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round">'
            f'<path d="{GATE}"/><path d="{INPUTS}"/><path d="{OUTPUT}"/></g>')


def trace(color, width=60, glow=None):
    out = ""
    if glow:
        gcol, gw, gop = glow
        out += f'<path d="{SINE}" fill="none" stroke="{gcol}" stroke-opacity="{gop}" stroke-width="{gw}" stroke-linecap="round" stroke-linejoin="round"/>'
    out += f'<path d="{SINE}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>'
    return out


def svg(body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {W}" width="{W}" height="{W}" '
            f'role="img" aria-label="DigiSchem">{body}</svg>\n')


BLUE = "#2463d1"

# F — plain: white gate + white sine trace on blue
F = svg(f'<rect width="{W}" height="{W}" rx="224" fill="{BLUE}"/>' + gate("#ffffff") + trace("#ffffff"))

# G — scope screen: faint graticule on the blue, glowing trace
G = svg(
    f'<rect width="{W}" height="{W}" rx="224" fill="{BLUE}"/>'
    + graticule(112, 112, 912, 912, 160, "#ffffff", 0.13, 0.22)
    + gate("#ffffff")
    + trace("#ffffff", glow=("#cfe6ff", 96, 0.22))
)

# H — scope with bezel: dark screen inside a blue frame, cyan-white glowing trace
SCREEN = "#0d1b33"
H = svg(
    f'<rect width="{W}" height="{W}" rx="224" fill="{BLUE}"/>'
    f'<rect x="72" y="72" width="880" height="880" rx="170" fill="{SCREEN}"/>'
    + graticule(72, 72, 952, 952, 176, "#5fa0ff", 0.20, 0.34)
    + gate("#e8f1ff")
    + trace("#eafcff", width=56, glow=("#5fd4ff", 104, 0.28))
)

for name, s in (("F-scope-plain.svg", F), ("G-scope-grid.svg", G), ("H-scope-bezel.svg", H)):
    open(name, "w", encoding="utf-8").write(s)
print("ok")
